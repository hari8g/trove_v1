/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { ITroveSettingsService } from '../common/troveSettingsService.js';
import { CodebaseSearchResult, IRepoIntelligenceMainService, IRepoIntelligenceService, REPO_INTEL_CHANNEL, REPO_INTEL_PROFILE_STALE_MS, ScopedRuleInfo, WorkspaceProfile } from '../common/repoIntelligenceTypes.js';
import { buildIndexingStatsFromProfile, formatRepoIntelligenceIndexingReport } from '../common/repoIntelligenceIndexingReport.js';

/** One parsed rule file from either `.troverules` root file or `.troverules/*.md` */
interface ScopedRule {
	content: string;
	globs: string[];
	alwaysApply: boolean;
	source: string;
}

/** Minimatch-style glob check (supports `**`, `*`, `?`). */
function globMatches(pattern: string, filePath: string): boolean {
	const escapedPattern = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '\u0000GLOBSTAR\u0000')
		.replace(/\*/g, '[^/]*')
		.replace(/\?/g, '[^/]')
		.replace(/\u0000GLOBSTAR\u0000/g, '.*');
	const re = new RegExp(`(^|/)${escapedPattern}($|/)`, 'i');
	return re.test(filePath) || new RegExp(`^${escapedPattern}$`, 'i').test(filePath);
}

function parseFrontmatter(raw: string): { globs: string[]; alwaysApply: boolean; content: string } {
	const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!fmMatch) return { globs: [], alwaysApply: true, content: raw.trim() };
	const yaml = fmMatch[1];
	const body = fmMatch[2].trim();
	const globsMatch = yaml.match(/globs\s*:\s*\[([^\]]*)\]/);
	const alwaysApplyMatch = yaml.match(/alwaysApply\s*:\s*(true|false)/i);
	const globs = globsMatch
		? globsMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
		: [];
	const alwaysApply = alwaysApplyMatch ? alwaysApplyMatch[1].toLowerCase() === 'true' : globs.length === 0;
	return { globs, alwaysApply, content: body };
}

class RepoIntelligenceService extends Disposable implements IRepoIntelligenceService {
	readonly _serviceBrand: undefined;

	private _cachedProfile: WorkspaceProfile | null = null;
	private _cachedWorkspaceRules: string | null = null;
	private _cachedScopedRules: ScopedRule[] = [];
	private _cachedUserMemory: string | null = null;
	private _troverulesUris: URI[] = [];
	private readonly _rulesWatchers = this._register(new DisposableStore());
	private readonly _onDidChangeWorkspaceRules = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaceRules = this._onDidChangeWorkspaceRules.event;
	private readonly _onDidChangeChunkIndex = this._register(new Emitter<number>());
	readonly onDidChangeChunkIndex = this._onDidChangeChunkIndex.event;
	private readonly _onDidChangeUserMemory = this._register(new Emitter<void>());
	readonly onDidChangeUserMemory = this._onDidChangeUserMemory.event;
	private readonly _onDidChangeUCG = this._register(new Emitter<void>());
	readonly onDidChangeUCG = this._onDidChangeUCG.event;

	private readonly _mainProxy: IRepoIntelligenceMainService;
	private _initInFlight: Promise<void> | null = null;
	private _initAttempts = 0;
	private _embeddingIndexTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@ITroveSettingsService private readonly _troveSettingsService: ITroveSettingsService,
	) {
		super();
		this._mainProxy = ProxyChannel.toService<IRepoIntelligenceMainService>(
			this._mainProcessService.getChannel(REPO_INTEL_CHANNEL),
		);

		this._register(
			this._workspaceContextService.onDidChangeWorkbenchState(state => {
				if (state !== WorkbenchState.EMPTY) {
					void this.ensureInitialized();
				}
			}),
		);

		this._register(
			this._workspaceContextService.onDidChangeWorkspaceFolders(async (e) => {
				if (e.added.length > 0 || e.changed.length > 0 || e.removed.length > 0) {
					this._initAttempts = 0;
					await this.ensureInitialized();
				}
			}),
		);

		this._register(this._fileService.onDidFilesChange(e => {
			if (this._troverulesUris.some(uri => e.contains(uri))) {
				this._loadWorkspaceRules();
			}
		}));

		void this.ensureInitialized();

		this._register(this.onDidChangeChunkIndex((count) => {
			if (count > 0) {
				this._scheduleEmbeddingIndex();
			}
		}));
	}

	private _scheduleEmbeddingIndex(): void {
		if (!this._troveSettingsService.state.globalSettings.enableVectorSearch) {
			return;
		}
		const root = this._getWorkspaceRoot();
		if (!root) {
			return;
		}
		if (this._embeddingIndexTimeout) {
			clearTimeout(this._embeddingIndexTimeout);
		}
		this._embeddingIndexTimeout = setTimeout(() => {
			void this._mainProxy.indexEmbeddingsForWorkspace(root).catch(err => {
				console.warn('[RepoIntelligence] Embedding index failed:', err);
			});
		}, 5000);
	}

	ensureInitialized(): Promise<void> {
		if (this._initInFlight) {
			return this._initInFlight;
		}
		this._initInFlight = this._initProfile()
			.then(() => this._loadWorkspaceRules())
			.then(() => this._loadUserMemory())
			.finally(() => {
				this._initInFlight = null;
			});
		return this._initInFlight;
	}

	private _scheduleInitRetry(): void {
		if (this._initAttempts >= 5) {
			return;
		}
		this._initAttempts += 1;
		const delayMs = Math.min(10_000, 500 * this._initAttempts);
		setTimeout(() => { void this.ensureInitialized(); }, delayMs);
	}

	private _getWorkspaceRoot(): string | null {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders[0]?.uri.fsPath ?? null;
	}

	private async _initProfile(): Promise<void> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			this._cachedProfile = null;
			this._onDidChangeChunkIndex.fire(0);
			return;
		}

		if (this._cachedProfile) {
			const isExpired = Date.now() - this._cachedProfile.lastScannedAt > REPO_INTEL_PROFILE_STALE_MS;
			if (!this._cachedProfile.isStale && !isExpired && this._cachedProfile.workspaceRoot === root) {
				const count = await this._mainProxy.getChunkCount(root);
				if (count > 0) {
					this._onDidChangeChunkIndex.fire(count);
					this._initAttempts = 0;
					return;
				}
			}
		}

		try {
			this._onDidChangeChunkIndex.fire(-1);
			this._cachedProfile = await this._mainProxy.getProfile(root);
			console.log('[RepoIntelligence] Profile loaded for', root);
			await this._refreshChunkCount();
			this._onDidChangeUCG.fire();
			this._initAttempts = 0;
		} catch (err) {
			console.error('[RepoIntelligence] Failed to load profile:', err);
			this._cachedProfile = null;
			this._onDidChangeChunkIndex.fire(0);
			this._scheduleInitRetry();
		}
	}

	private async _refreshChunkCount(): Promise<void> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			this._onDidChangeChunkIndex.fire(0);
			return;
		}
		try {
			const count = await this._mainProxy.getChunkCount(root);
			this._onDidChangeChunkIndex.fire(count);
		} catch {
			this._onDidChangeChunkIndex.fire(0);
		}
	}

	private async _loadWorkspaceRules(): Promise<void> {
		this._rulesWatchers.clear();
		const troverulesUris: URI[] = [];
		const alwaysApplyParts: string[] = [];
		const scopedRules: ScopedRule[] = [];

		for (const folder of this._workspaceContextService.getWorkspace().folders) {
			// Load root .troverules file (treated as alwaysApply)
			const rootUri = URI.joinPath(folder.uri, '.troverules');
			try {
				await this._fileService.stat(rootUri);
				const fileContent = await this._fileService.readFile(rootUri);
				const text = fileContent.value.toString().trim();
				if (text) {
					alwaysApplyParts.push(text);
					scopedRules.push({ content: text, globs: [], alwaysApply: true, source: '.troverules' });
				}
				troverulesUris.push(rootUri);
				this._rulesWatchers.add(this._fileService.watch(rootUri));
			} catch {
				// missing or unreadable .troverules is normal
			}

			// Scan .troverules/ directory for scoped rule files
			const dirUri = URI.joinPath(folder.uri, '.troverules');
			try {
				const stat = await this._fileService.stat(dirUri);
				if (stat.isDirectory) {
					// It's a directory — scan for *.md / *.mdc rule files
					const children = await this._fileService.resolve(dirUri);
					for (const child of children.children ?? []) {
						if (!child.isDirectory && /\.(md|mdc)$/i.test(child.name)) {
							try {
								const childContent = await this._fileService.readFile(child.resource);
								const raw = childContent.value.toString();
								const parsed = parseFrontmatter(raw);
								scopedRules.push({ ...parsed, source: child.name });
								if (parsed.alwaysApply) {
									alwaysApplyParts.push(parsed.content);
								}
								troverulesUris.push(child.resource);
								this._rulesWatchers.add(this._fileService.watch(child.resource));
							} catch {
								// skip unreadable rule files
							}
						}
					}
					// Watch the directory for new/deleted rule files
					this._rulesWatchers.add(this._fileService.watch(dirUri));
				}
			} catch {
				// .troverules dir doesn't exist — normal
			}
		}

		this._troverulesUris = troverulesUris;
		this._cachedScopedRules = scopedRules;
		const newRules = alwaysApplyParts.length > 0 ? alwaysApplyParts.join('\n\n') : null;
		const changed = newRules !== this._cachedWorkspaceRules;
		this._cachedWorkspaceRules = newRules;
		if (changed) {
			this._onDidChangeWorkspaceRules.fire();
		}
	}

	getProfileSync(): WorkspaceProfile | null {
		return this._cachedProfile;
	}

	getWorkspaceRules(activeFilePath?: string): string | null {
		if (!activeFilePath || this._cachedScopedRules.length === 0) {
			return this._cachedWorkspaceRules;
		}
		// Return alwaysApply rules + rules whose globs match the active file
		const applicable = this._cachedScopedRules.filter(rule =>
			rule.alwaysApply || rule.globs.some(glob => globMatches(glob, activeFilePath))
		);
		const combined = applicable.map(r => r.content).join('\n\n').trim();
		return combined || null;
	}

	getScopedRulesList(): ScopedRuleInfo[] {
		return this._cachedScopedRules.map(r => ({
			source: r.source,
			content: r.content,
			globs: r.globs,
			alwaysApply: r.alwaysApply,
		}));
	}

	private async _loadUserMemory(): Promise<void> {
		try {
			const memory = await this._mainProxy.getUserMemory();
			const changed = memory !== this._cachedUserMemory;
			this._cachedUserMemory = memory;
			if (changed) {
				this._onDidChangeUserMemory.fire();
			}
		} catch {
			// ignore
		}
	}

	getUserMemory(): string | null {
		return this._cachedUserMemory;
	}

	async appendToUserMemory(text: string): Promise<void> {
		await this._mainProxy.appendToUserMemory(text);
		await this._loadUserMemory();
	}

	async getProfile(workspaceRoot: string): Promise<WorkspaceProfile | null> {
		const profile = await this._mainProxy.getProfile(workspaceRoot);
		if (workspaceRoot === this._getWorkspaceRoot()) {
			this._cachedProfile = profile;
			await this._refreshChunkCount();
		}
		return profile;
	}

	async refreshProfile(workspaceRoot: string): Promise<WorkspaceProfile> {
		if (workspaceRoot === this._getWorkspaceRoot()) {
			this._onDidChangeChunkIndex.fire(-1);
		}
		const profile = await this._mainProxy.refreshProfile(workspaceRoot);
		if (workspaceRoot === this._getWorkspaceRoot()) {
			this._cachedProfile = profile;
			await this._refreshChunkCount();
			this._onDidChangeUCG.fire();
		}
		return profile;
	}

	async searchCodebase(workspaceRoot: string, query: string, maxResults?: number): Promise<CodebaseSearchResult[]> {
		const results = await this._mainProxy.searchCodebase(workspaceRoot, query, maxResults);
		if (workspaceRoot === this._getWorkspaceRoot()) {
			await this._refreshChunkCount();
		}
		return results;
	}

	async getChunkCount(workspaceRoot: string): Promise<number> {
		return this._mainProxy.getChunkCount(workspaceRoot);
	}

	async getFileOutline(workspaceRoot: string, filePath: string) {
		return this._mainProxy.getFileOutline(workspaceRoot, filePath);
	}

	async getSymbol(workspaceRoot: string, filePath: string, symbolName: string) {
		return this._mainProxy.getSymbol(workspaceRoot, filePath, symbolName);
	}

	async searchSymbols(workspaceRoot: string, query: string, maxResults?: number) {
		return this._mainProxy.searchSymbols(workspaceRoot, query, maxResults);
	}

	async getServiceTopology(workspaceRoot: string) {
		return this._mainProxy.getServiceTopology(workspaceRoot);
	}

	async getMavenImpact(workspaceRoot: string, artifactId: string) {
		return this._mainProxy.getMavenImpact(workspaceRoot, artifactId);
	}

	async resolveApiContract(workspaceRoot: string, httpMethod: string, pathPattern: string) {
		return this._mainProxy.resolveApiContract(workspaceRoot, httpMethod, pathPattern);
	}

	async getNpmConsumers(workspaceRoot: string, packageName: string) {
		return this._mainProxy.getNpmConsumers(workspaceRoot, packageName);
	}

	async getConfigDrift(workspaceRoot: string, serviceName: string) {
		return this._mainProxy.getConfigDrift(workspaceRoot, serviceName);
	}

	async getTerraformResources(workspaceRoot: string, resourceType?: string) {
		return this._mainProxy.getTerraformResources(workspaceRoot, resourceType);
	}

	async getPipelineJobs(workspaceRoot: string, stage?: string) {
		return this._mainProxy.getPipelineJobs(workspaceRoot, stage);
	}

	async getUCGGraph(workspaceRoot: string) {
		const data = await this._mainProxy.getUCGGraph(workspaceRoot);
		if (data && data.nodes.length > 0) {
			this._onDidChangeUCG.fire();
		}
		return data;
	}

	async getUCGMetrics(workspaceRoot: string) {
		return this._mainProxy.getUCGMetrics(workspaceRoot);
	}

	async getImportGraph(workspaceRoot: string, relFilePath: string, direction: 'imports' | 'importedBy' | 'both') {
		return this._mainProxy.getImportGraph(workspaceRoot, relFilePath, direction);
	}

	async getTestsForFile(workspaceRoot: string, relFilePath: string) {
		return this._mainProxy.getTestsForFile(workspaceRoot, relFilePath);
	}

	async getGitDiffStat(workspaceRoot: string) {
		return this._mainProxy.getGitDiffStat(workspaceRoot);
	}

	async getGitRecentlyChanged(workspaceRoot: string, limit?: number) {
		return this._mainProxy.getGitRecentlyChanged(workspaceRoot, limit);
	}

	async getContextualProfile(workspaceRoot: string, opts: { activeUri?: string; recentlyEditedUris?: string[] }) {
		return this._mainProxy.getContextualProfile(workspaceRoot, opts);
	}

	async searchCodebaseHybrid(workspaceRoot: string, query: string, maxResults?: number): Promise<CodebaseSearchResult[]> {
		return this._mainProxy.searchCodebaseHybrid(workspaceRoot, query, maxResults);
	}

	async indexEmbeddingsForWorkspace(workspaceRoot: string): Promise<void> {
		return this._mainProxy.indexEmbeddingsForWorkspace(workspaceRoot);
	}

	async getIndexingReport(workspaceRoot: string): Promise<string> {
		try {
			return await (this._mainProxy as unknown as { getIndexingReport(root: string): Promise<string> }).getIndexingReport(workspaceRoot);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!message.includes('Method not found')) {
				throw err;
			}
		}

		const profile = await this.getProfile(workspaceRoot);
		const chunkCount = await this.getChunkCount(workspaceRoot);
		const isIndexing = this._initInFlight !== null;
		const stats = buildIndexingStatsFromProfile(profile, chunkCount);
		return formatRepoIntelligenceIndexingReport(workspaceRoot, profile, stats, isIndexing);
	}
}

registerSingleton(IRepoIntelligenceService, RepoIntelligenceService, InstantiationType.Eager);
