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
import { CodebaseSearchResult, IRepoIntelligenceService, REPO_INTEL_CHANNEL, REPO_INTEL_PROFILE_STALE_MS, WorkspaceProfile } from '../common/repoIntelligenceTypes.js';

class RepoIntelligenceService extends Disposable implements IRepoIntelligenceService {
	readonly _serviceBrand: undefined;

	private _cachedProfile: WorkspaceProfile | null = null;
	private _cachedWorkspaceRules: string | null = null;
	private _cachedUserMemory: string | null = null;
	private _troverulesUris: URI[] = [];
	private readonly _rulesWatchers = this._register(new DisposableStore());
	private readonly _onDidChangeWorkspaceRules = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaceRules = this._onDidChangeWorkspaceRules.event;
	private readonly _onDidChangeChunkIndex = this._register(new Emitter<number>());
	readonly onDidChangeChunkIndex = this._onDidChangeChunkIndex.event;
	private readonly _onDidChangeUserMemory = this._register(new Emitter<void>());
	readonly onDidChangeUserMemory = this._onDidChangeUserMemory.event;

	private readonly _mainProxy: Pick<IRepoIntelligenceService, 'getProfile' | 'refreshProfile' | 'searchCodebase' | 'getChunkCount' | 'getFileOutline' | 'getSymbol' | 'searchSymbols' | 'getUserMemory' | 'appendToUserMemory'>;
	private _initInFlight: Promise<void> | null = null;
	private _initAttempts = 0;

	constructor(
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		this._mainProxy = ProxyChannel.toService<IRepoIntelligenceService>(
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
		const parts: string[] = [];

		for (const folder of this._workspaceContextService.getWorkspace().folders) {
			const uri = URI.joinPath(folder.uri, '.troverules');
			try {
				await this._fileService.stat(uri);
				const fileContent = await this._fileService.readFile(uri);
				const text = fileContent.value.toString().trim();
				if (text) {
					parts.push(text);
				}
				troverulesUris.push(uri);
				this._rulesWatchers.add(this._fileService.watch(uri));
			} catch {
				// missing or unreadable .troverules is normal
			}
		}

		this._troverulesUris = troverulesUris;
		const newRules = parts.length > 0 ? parts.join('\n\n') : null;
		const changed = newRules !== this._cachedWorkspaceRules;
		this._cachedWorkspaceRules = newRules;
		if (changed) {
			this._onDidChangeWorkspaceRules.fire();
		}
	}

	getProfileSync(): WorkspaceProfile | null {
		return this._cachedProfile;
	}

	getWorkspaceRules(): string | null {
		return this._cachedWorkspaceRules;
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
}

registerSingleton(IRepoIntelligenceService, RepoIntelligenceService, InstantiationType.Eager);
