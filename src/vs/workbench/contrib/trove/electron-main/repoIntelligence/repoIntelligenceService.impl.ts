/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js';
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { CodebaseSearchResult, ExtractedSymbol, FileMetadataEntry, IRepoIntelligenceMainService, MavenImpactSummary, REPO_INTEL_PROFILE_STALE_MS, ServiceTopologySummary, WorkspaceProfile } from '../../common/repoIntelligenceTypes.js';
import { getTroveMemoryFilePath } from '../../common/troveMemoryPaths.js';
import { TROVE_SETTINGS_STORAGE_KEY } from '../../common/storageKeys.js';
import { TroveSettingsState } from '../../common/troveSettingsService.js';
import { IMetricsService } from '../../common/metricsService.js';
import { sendLLMMessage } from '../llmMessage/sendLLMMessage.js';
import { detectCommands } from './commandDetector.js';
import { buildChunksForWorkspace, extractSymbolsFromFile, SKIP_LANGUAGES, supportsSymbolExtraction } from './codeChunker.js';
import { indexGatewayRoutes } from './gatewayRouteIndexer.js';
import { indexGitlabPipelines } from './gitlabCiIndexer.js';
import { indexAllSpringServices } from './javaSpringIndexer.js';
import { indexConfigEnvironments } from './configEnvIndexer.js';
import { indexKubernetesManifests } from './kubernetesYamlIndexer.js';
import { indexMavenDependencies } from './mavenDependencyIndexer.js';
import { indexNpmDependencies } from './npmImpactIndexer.js';
import { indexTerraformResources } from './terraformIndexer.js';
import { formatRepoIntelligenceIndexingReport } from '../../common/repoIntelligenceIndexingReport.js';
import { getRepoIntelligenceDbPath, hashWorkspaceRoot, RepoIntelligenceDb } from './repoIntelligenceDb.js';
import { RawScanResult, scanWorkspace } from './workspaceScanner.js';

const ARCH_SUMMARY_SYSTEM_PROMPT = `You are a software architect. Given scan data about a codebase, write a concise 2-4 sentence architecture summary describing the project's structure, main components, and technology patterns. Output plain text only, no markdown.`;

const PURPOSE_SUMMARY_SYSTEM_PROMPT = `You are a software analyst. Given scan data about a codebase, write a concise 1-2 sentence description of what this project does and its primary purpose. Output plain text only, no markdown.`;

const buildScanContext = (scan: RawScanResult, commands: ReturnType<typeof detectCommands>, workspaceRoot: string): string => {
	const topFiles = scan.fileMeta
		.filter(f => f.language)
		.slice(0, 30)
		.map(f => f.filePath);

	return JSON.stringify({
		workspaceRoot,
		languages: scan.languages,
		frameworks: scan.frameworks.map(f => f.name),
		packageManagers: scan.packageManagers,
		fileCount: scan.fileCount,
		totalLoc: scan.totalLoc,
		buildCommands: commands.buildCommands.slice(0, 3).map(c => c.command),
		testCommands: commands.testCommands.slice(0, 3).map(c => c.command),
		sampleFiles: topFiles,
	}, null, 2);
};

export class RepoIntelligenceMainService extends Disposable implements IRepoIntelligenceMainService {
	readonly _serviceBrand: undefined;

	private readonly _db: RepoIntelligenceDb;
	private readonly _scanInProgress = new Map<string, Promise<WorkspaceProfile>>();
	private readonly _memoryFilePath: string;
	private _cachedUserMemory: string | null = null;

	constructor(
		@IEnvironmentMainService private readonly _environmentService: IEnvironmentMainService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IApplicationStorageMainService private readonly _appStorage: IApplicationStorageMainService,
		@IEncryptionMainService private readonly _encryptionService: IEncryptionMainService,
	) {
		super();
		const dbPath = getRepoIntelligenceDbPath(this._environmentService.userDataPath);
		this._db = new RepoIntelligenceDb(dbPath);
		this._db.init()
			.then(() => {
				this._metricsService.capture('RepoIntelligence DB Ready', { dbPath });
			})
			.catch(err => {
				console.error('[RepoIntelligence] DB init failed:', err);
				this._metricsService.capture('RepoIntelligence DB Init Failed', {
					message: err instanceof Error ? err.message : String(err),
					dbPath,
				});
			});
		this._memoryFilePath = getTroveMemoryFilePath(this._environmentService.userDataPath);
		this._loadUserMemory().catch(err => console.error('[RepoIntelligence] Memory load failed:', err));
	}

	override dispose(): void {
		this._db.close();
		super.dispose();
	}

	async getProfile(workspaceRoot: string): Promise<WorkspaceProfile | null> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();

		const existing = await this._db.getProfile(hash);
		if (existing) {
			const isExpired = Date.now() - existing.lastScannedAt > REPO_INTEL_PROFILE_STALE_MS;
			if (!existing.isStale && !isExpired) {
				await this._ensureChunksIndexed(workspaceRoot, hash);
				return this._hydrateStaasSummaries(hash, existing);
			}
		}

		return this._ensureScan(workspaceRoot);
	}

	async refreshProfile(workspaceRoot: string): Promise<WorkspaceProfile> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		await this._db.markStale(hash);
		this._scanInProgress.delete(workspaceRoot);
		return this._ensureScan(workspaceRoot);
	}

	private async _ensureScan(workspaceRoot: string): Promise<WorkspaceProfile> {
		const inProgress = this._scanInProgress.get(workspaceRoot);
		if (inProgress) return inProgress;

		const promise = this._scanWorkspace(workspaceRoot);
		this._scanInProgress.set(workspaceRoot, promise);
		try {
			return await promise;
		} finally {
			this._scanInProgress.delete(workspaceRoot);
		}
	}

	private async _scanWorkspace(workspaceRoot: string): Promise<WorkspaceProfile> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		const scan = scanWorkspace(workspaceRoot);
		const commands = detectCommands(workspaceRoot);

		let profile: WorkspaceProfile = {
			workspaceRoot,
			lastScannedAt: Date.now(),
			languageStack: scan.languages,
			frameworks: scan.frameworks,
			packageManagers: scan.packageManagers,
			// Store start scripts alongside build in the same JSON column (purpose distinguishes them)
			buildCommands: [...commands.buildCommands, ...commands.startCommands],
			testCommands: commands.testCommands,
			lintCommands: commands.lintCommands,
			typecheckCommands: commands.typecheckCommands,
			projectPurpose: null,
			architectureSummary: null,
			fileCount: scan.fileCount,
			totalLoc: scan.totalLoc,
			isStale: false,
		};

		await this._db.upsertProfile(hash, profile, scan.fileMeta);

		const chunkStart = Date.now();
		const chunks = buildChunksForWorkspace(workspaceRoot, hash, scan.fileMeta);
		await this._db.replaceChunks(hash, chunks);
		console.log(`[RepoIntelligence] Indexed ${chunks.length} chunks in ${Date.now() - chunkStart}ms`);
		this._metricsService.capture('RepoIntelligence Chunks Indexed', { chunkCount: chunks.length, workspaceRoot });

		try {
			await this._indexSymbolsIncremental(workspaceRoot, hash, scan.fileMeta);
		} catch (err) {
			console.error('[RepoIntelligence] Symbol indexing failed:', err);
		}

		// ── STaaS polyglot indexing ──────────────────────────────────────────────
		try {
			const javaResult = indexAllSpringServices(workspaceRoot);
			if (javaResult.endpoints.length > 0 || javaResult.feignClients.length > 0) {
				await this._db.replaceSpringEndpoints(hash, javaResult.endpoints);
				await this._db.replaceFeignClients(hash, javaResult.feignClients);
				this._metricsService.capture('STaaS Java Indexed', {
					endpoints: javaResult.endpoints.length,
					feignClients: javaResult.feignClients.length,
				});
			}

			const mavenResult = await indexMavenDependencies(workspaceRoot);
			if (mavenResult.pomCount > 0) {
				await this._db.replaceMavenDependencies(hash, mavenResult.deps);
				this._metricsService.capture('STaaS Maven Indexed', {
					pomCount: mavenResult.pomCount, depCount: mavenResult.deps.length,
				});
			}

			const k8sResources = indexKubernetesManifests(workspaceRoot);
			if (k8sResources.length > 0) {
				await this._db.replaceK8sResources(hash, k8sResources);
				this._metricsService.capture('STaaS K8s Indexed', { resourceCount: k8sResources.length });
			}

			const gatewayRoutes = indexGatewayRoutes(workspaceRoot);
			if (gatewayRoutes.length > 0) {
				await this._db.replaceGatewayRoutes(hash, gatewayRoutes);
				this._metricsService.capture('STaaS Gateway Indexed', { routeCount: gatewayRoutes.length });
			}

			const npmResult = indexNpmDependencies(workspaceRoot);
			if (npmResult.edges.length > 0) {
				await this._db.replaceNpmEdges(hash, npmResult.edges);
				this._metricsService.capture('STaaS NPM Indexed', {
					packageJsonCount: npmResult.packageJsonCount,
					edgeCount: npmResult.edges.length,
				});
			}

			const configResult = indexConfigEnvironments(workspaceRoot);
			if (configResult.fileCount > 0) {
				await this._db.replaceConfigDrift(hash, configResult.envDrift);
				this._metricsService.capture('STaaS Config Indexed', {
					fileCount: configResult.fileCount,
					driftCount: configResult.envDrift.length,
				});
			}

			const tfResult = indexTerraformResources(workspaceRoot);
			if (tfResult.fileCount > 0 || tfResult.resources.length > 0) {
				await this._db.replaceTerraformIndex(hash, tfResult);
				this._metricsService.capture('STaaS Terraform Indexed', {
					fileCount: tfResult.fileCount,
					resourceCount: tfResult.resources.length,
				});
			}

			const ciResult = indexGitlabPipelines(workspaceRoot);
			if (ciResult.fileCount > 0 || ciResult.jobs.length > 0) {
				await this._db.replacePipelineIndex(hash, ciResult);
				this._metricsService.capture('STaaS CI Indexed', {
					fileCount: ciResult.fileCount,
					jobCount: ciResult.jobs.length,
				});
			}

			profile = await this._hydrateStaasSummaries(hash, profile, {
				configFileCount: configResult.fileCount,
			});
		} catch (err) {
			console.error('[RepoIntelligence] STaaS polyglot indexing failed:', err);
		}

		const existing = await this._db.getProfile(hash);
		if (existing?.projectPurpose && existing?.architectureSummary) {
			profile = { ...profile, projectPurpose: existing.projectPurpose, architectureSummary: existing.architectureSummary };
		} else {
			try {
				const scanContext = buildScanContext(scan, commands, workspaceRoot);
				const [architectureSummary, projectPurpose] = await Promise.all([
					this._callLLMForSummary(ARCH_SUMMARY_SYSTEM_PROMPT, scanContext),
					this._callLLMForSummary(PURPOSE_SUMMARY_SYSTEM_PROMPT, scanContext),
				]);

				if (architectureSummary || projectPurpose) {
					await this._db.updateSummaries(hash, projectPurpose, architectureSummary);
					profile = { ...profile, projectPurpose, architectureSummary };
				}
			} catch (err) {
				console.error('[RepoIntelligence] LLM summary generation failed:', err);
			}
		}

		return profile;
	}

	private async _hydrateStaasSummaries(
		hash: string,
		profile: WorkspaceProfile,
		scanExtras?: { configFileCount?: number },
	): Promise<WorkspaceProfile> {
		const [
			endpoints, feignClients, routes, mavenDeps, npmEdges, driftStats,
			tfResources, tfMeta, pipelineJobs, pipelineMeta,
		] = await Promise.all([
			this._db.getSpringEndpoints(hash),
			this._db.getFeignClients(hash),
			this._db.getGatewayRoutes(hash),
			this._db.getAllMavenDependencies(hash),
			this._db.getAllNpmEdges(hash),
			this._db.getConfigDriftStats(hash),
			this._db.getTerraformResources(hash),
			this._db.getTerraformIndexMeta(hash),
			this._db.getPipelineJobs(hash),
			this._db.getPipelineIndexMeta(hash),
		]);

		let hydrated = { ...profile };

		if (endpoints.length > 0) {
			const feignMap = new Map<string, Set<string>>();
			for (const e of feignClients) {
				if (!feignMap.has(e.callerService)) feignMap.set(e.callerService, new Set());
				feignMap.get(e.callerService)!.add(e.targetService);
			}
			const feignEdges = Array.from(feignMap.entries()).map(([caller, targets]) => ({
				caller, targets: Array.from(targets),
			}));

			const serviceNamesSet = new Set<string>();
			for (const ep of endpoints) serviceNamesSet.add(ep.serviceName);

			const topology: ServiceTopologySummary = {
				serviceCount: serviceNamesSet.size,
				serviceNames: Array.from(serviceNamesSet),
				gatewayRoutes: routes.map(r => ({ pathPattern: r.pathPredicate, targetService: r.targetService })),
				feignEdges,
				totalEndpoints: endpoints.length,
			};
			hydrated = { ...hydrated, serviceTopologySummary: topology };
		}

		if (mavenDeps.length > 0) {
			const artifactCountMap = new Map<string, Set<string>>();
			for (const d of mavenDeps) {
				if (!artifactCountMap.has(d.artifactId)) artifactCountMap.set(d.artifactId, new Set());
				artifactCountMap.get(d.artifactId)!.add(d.consumerPath);
			}
			const sharedLibs = Array.from(artifactCountMap.entries())
				.filter(([, consumers]) => consumers.size >= 2)
				.map(([artifactId, consumers]) => ({ artifactId, consumerCount: consumers.size }))
				.sort((a, b) => b.consumerCount - a.consumerCount)
				.slice(0, 20);

			const pomPaths = new Set(mavenDeps.map(d => d.consumerPath));
			if (sharedLibs.length > 0) {
				const mavenImpact: MavenImpactSummary = { sharedLibs, pomCount: pomPaths.size };
				hydrated = { ...hydrated, mavenImpactSummary: mavenImpact };
			}
		}

		if (npmEdges.length > 0) {
			const npmImpactMap = new Map<string, Set<string>>();
			for (const e of npmEdges) {
				if (!npmImpactMap.has(e.packageName)) npmImpactMap.set(e.packageName, new Set());
				npmImpactMap.get(e.packageName)!.add(e.consumerPath);
			}
			const topNpmLibs = Array.from(npmImpactMap.entries())
				.filter(([, consumers]) => consumers.size >= 2)
				.map(([packageName, consumers]) => ({ packageName, consumerCount: consumers.size }))
				.sort((a, b) => b.consumerCount - a.consumerCount)
				.slice(0, 15);
			if (topNpmLibs.length > 0) {
				const packageJsonCount = new Set(npmEdges.map(e => e.consumerPath)).size;
				hydrated = { ...hydrated, npmImpactSummary: { sharedPackages: topNpmLibs, packageJsonCount } };
			}
		}

		if (driftStats.driftCount > 0) {
			hydrated = {
				...hydrated,
				configDriftSummary: {
					driftCount: driftStats.driftCount,
					fileCount: scanExtras?.configFileCount ?? driftStats.driftCount,
					topDriftedServices: driftStats.topDriftedServices,
				},
			};
		}

		if (tfResources.length > 0 || tfMeta) {
			const providers = tfMeta?.providers.length
				? tfMeta.providers
				: [...new Set(tfResources.map(r => r.provider))];
			hydrated = {
				...hydrated,
				terraformSummary: {
					resourceCount: tfResources.length,
					providers,
					fileCount: tfMeta?.fileCount ?? 0,
					topResourceTypes: [...new Set(tfResources.map(r => r.resourceType))].slice(0, 10),
				},
			};
		}

		if (pipelineJobs.length > 0 || pipelineMeta) {
			const stageMap = new Map<string, Set<string>>();
			for (const job of pipelineJobs) {
				if (!stageMap.has(job.stage)) stageMap.set(job.stage, new Set());
				stageMap.get(job.stage)!.add(job.name);
			}
			hydrated = {
				...hydrated,
				pipelineSummary: {
					stageCount: stageMap.size,
					jobCount: pipelineJobs.length,
					hasManualGates: pipelineMeta?.hasManualGates ?? false,
					stages: Array.from(stageMap.keys()),
				},
			};
		}

		return hydrated;
	}

	private async _ensureChunksIndexed(workspaceRoot: string, hash: string): Promise<void> {
		const fileMeta = await this._db.getFileMetadata(hash);

		if (fileMeta.length === 0) {
			const chunkCount = await this._db.getChunkCount(hash);
			if (chunkCount === 0) {
				await this._ensureScan(workspaceRoot);
			}
			return;
		}

		if (!(await this._needsChunkRebuild(hash, fileMeta))) {
			try {
				await this._indexSymbolsIncremental(workspaceRoot, hash, fileMeta);
			} catch (err) {
				console.error('[RepoIntelligence] Symbol indexing failed:', err);
			}
			return;
		}

		await this._rebuildChunks(workspaceRoot, hash, fileMeta);
	}

	private _countIndexableFiles(fileMeta: FileMetadataEntry[]): number {
		return fileMeta.filter(f => f.language && !SKIP_LANGUAGES.has(f.language)).length;
	}

	private async _needsChunkRebuild(hash: string, fileMeta: FileMetadataEntry[]): Promise<boolean> {
		const chunkCount = await this._db.getChunkCount(hash);
		if (chunkCount === 0) {
			return true;
		}

		const indexableCount = this._countIndexableFiles(fileMeta);
		if (indexableCount === 0) {
			return false;
		}

		const indexedFileCount = await this._db.getDistinctChunkFileCount(hash);
		if (indexedFileCount < indexableCount) {
			console.log(`[RepoIntelligence] Chunk index incomplete (${indexedFileCount}/${indexableCount} indexable files) — rebuilding`);
			return true;
		}

		return false;
	}

	private async _rebuildChunks(workspaceRoot: string, hash: string, fileMeta: FileMetadataEntry[]): Promise<void> {
		const chunkStart = Date.now();
		const chunks = buildChunksForWorkspace(workspaceRoot, hash, fileMeta);
		await this._db.replaceChunks(hash, chunks);
		console.log(`[RepoIntelligence] Indexed ${chunks.length} chunks in ${Date.now() - chunkStart}ms`);
		this._metricsService.capture('RepoIntelligence Chunks Indexed', { chunkCount: chunks.length, workspaceRoot });
		try {
			await this._indexSymbolsIncremental(workspaceRoot, hash, fileMeta);
		} catch (err) {
			console.error('[RepoIntelligence] Symbol indexing failed:', err);
		}
	}

	private async _indexSymbolsIncremental(
		workspaceRoot: string,
		workspaceHash: string,
		fileMeta: FileMetadataEntry[],
	): Promise<void> {
		const storedHashes = await this._db.getFileHashes(workspaceHash);
		let indexed = 0;

		for (const file of fileMeta) {
			if (!supportsSymbolExtraction(file.language)) {
				continue;
			}

			const absPath = join(workspaceRoot, file.filePath);
			let content: string;
			try {
				content = readFileSync(absPath, 'utf8');
			} catch {
				continue;
			}

			const currentHash = createHash('sha256').update(content).digest('hex').slice(0, 32);
			if (storedHashes.get(file.filePath) === currentHash) {
				continue;
			}

			const symbols = extractSymbolsFromFile(workspaceHash, file.filePath, content, file.language);
			await this._db.replaceSymbolsForFile(workspaceHash, file.filePath, symbols);
			await this._db.upsertFileHash(workspaceHash, file.filePath, currentHash);
			indexed += 1;
		}

		if (indexed > 0) {
			console.log(`[RepoIntelligence] Indexed symbols for ${indexed} changed files`);
		}
	}

	async searchCodebase(workspaceRoot: string, query: string, maxResults = 10): Promise<CodebaseSearchResult[]> {
		await this._db.init();
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this.getProfile(workspaceRoot);

		const trimmed = query.trim();
		if (!trimmed) return [];

		return this._db.searchChunks(hash, trimmed, maxResults);
	}

	async getChunkCount(workspaceRoot: string): Promise<number> {
		await this._db.init();
		const hash = hashWorkspaceRoot(workspaceRoot);
		return this._db.getChunkCount(hash);
	}

	async getFileOutline(workspaceRoot: string, filePath: string): Promise<ExtractedSymbol[]> {
		await this._db.init();
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this.getProfile(workspaceRoot);
		return this._db.getFileOutline(hash, filePath);
	}

	async getSymbol(workspaceRoot: string, filePath: string, symbolName: string): Promise<ExtractedSymbol | null> {
		await this._db.init();
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this.getProfile(workspaceRoot);
		return this._db.getSymbol(hash, filePath, symbolName);
	}

	async searchSymbols(workspaceRoot: string, query: string, maxResults = 15): Promise<ExtractedSymbol[]> {
		await this._db.init();
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this.getProfile(workspaceRoot);
		const trimmed = query.trim();
		if (!trimmed) {
			return [];
		}
		return this._db.searchSymbols(hash, trimmed, maxResults);
	}

	private async _readVoidSettings(): Promise<TroveSettingsState | null> {
		try {
			const encryptedState = this._appStorage.get(TROVE_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION);
			if (!encryptedState) return null;
			const stateStr = await this._encryptionService.decrypt(encryptedState);
			return JSON.parse(stateStr) as TroveSettingsState;
		} catch {
			return null;
		}
	}

	private async _callLLMForSummary(systemPrompt: string, userContent: string): Promise<string | null> {
		const settings = await this._readVoidSettings();
		if (!settings) return null;

		const modelSelection = settings.modelSelectionOfFeature['Chat'];
		if (!modelSelection) return null;

		const modelSelectionOptions = settings.optionsOfModelSelection['Chat']?.[modelSelection.providerName]?.[modelSelection.modelName];

		return new Promise<string | null>((resolve) => {
			const abortRef = { current: null as (() => void) | null };
			const timeout = setTimeout(() => {
				abortRef.current?.();
				resolve(null);
			}, 30_000);

			sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: userContent }],
				separateSystemMessage: systemPrompt,
				chatMode: null,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel: settings.overridesOfModel,
				settingsOfProvider: settings.settingsOfProvider,
				mcpTools: undefined,
				abortRef,
				onText: () => { },
				onFinalMessage: ({ fullText }) => {
					clearTimeout(timeout);
					resolve(fullText.trim() || null);
				},
				onError: () => {
					clearTimeout(timeout);
					resolve(null);
				},
				logging: { loggingName: 'RepoIntelligence - Summary' },
			}, this._metricsService).catch(() => {
				clearTimeout(timeout);
				resolve(null);
			});
		});
	}

	private async _loadUserMemory(): Promise<void> {
		try {
			const content = await fs.readFile(this._memoryFilePath, 'utf8');
			this._cachedUserMemory = content.trim() || null;
		} catch {
			this._cachedUserMemory = null;
		}
	}

	getUserMemory(): string | null {
		return this._cachedUserMemory;
	}

	async appendToUserMemory(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		const entry = `- ${trimmed}\n`;
		try {
			await fs.appendFile(this._memoryFilePath, entry, 'utf8');
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				await fs.writeFile(this._memoryFilePath, entry, 'utf8');
			} else {
				throw err;
			}
		}
		const existing = this._cachedUserMemory ?? '';
		this._cachedUserMemory = (existing ? `${existing}\n` : '') + entry.trim();
	}

	async getServiceTopology(workspaceRoot: string): Promise<ServiceTopologySummary | null> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		const [endpoints, feignClients, routes] = await Promise.all([
			this._db.getSpringEndpoints(hash),
			this._db.getFeignClients(hash),
			this._db.getGatewayRoutes(hash),
		]);
		if (endpoints.length === 0) return null;

		const serviceNamesSet = new Set(endpoints.map(e => e.serviceName));
		const feignMap = new Map<string, Set<string>>();
		for (const e of feignClients) {
			if (!feignMap.has(e.callerService)) feignMap.set(e.callerService, new Set());
			feignMap.get(e.callerService)!.add(e.targetService);
		}

		return {
			serviceCount: serviceNamesSet.size,
			serviceNames: Array.from(serviceNamesSet),
			gatewayRoutes: routes.map(r => ({ pathPattern: r.pathPredicate, targetService: r.targetService })),
			feignEdges: Array.from(feignMap.entries()).map(([caller, targets]) => ({ caller, targets: Array.from(targets) })),
			totalEndpoints: endpoints.length,
		};
	}

	async getMavenImpact(workspaceRoot: string, artifactId: string): Promise<string[]> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		const consumers = await this._db.getMavenConsumers(hash, artifactId);
		return [...new Set(consumers.map(c => c.consumerPath))];
	}

	async resolveApiContract(
		workspaceRoot: string,
		httpMethod: string,
		pathPattern: string,
	): Promise<import('../../common/repoIntelligenceTypes.js').ApiContractResult | null> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		const endpoints = await this._db.getSpringEndpoints(hash);

		let ep = endpoints.find(
			e => e.httpMethod === httpMethod.toUpperCase() && e.pathPattern === pathPattern,
		);
		if (!ep) {
			ep = endpoints.find(e => {
				const prefix = pathPattern.replace(/\*\*$/, '').replace(/\/+$/, '');
				return e.httpMethod === httpMethod.toUpperCase() && e.pathPattern.startsWith(prefix);
			});
		}
		if (!ep) return null;

		return {
			pathPattern: ep.pathPattern,
			httpMethod: ep.httpMethod,
			backendService: ep.serviceName,
			controllerClass: ep.controllerClass,
			handlerMethod: ep.handlerMethod,
			requestDto: ep.requestDto,
			responseDto: ep.responseDto,
			filePath: ep.filePath,
		};
	}

	async getNpmConsumers(workspaceRoot: string, packageName: string): Promise<string[]> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		return this._db.getNpmConsumers(hash, packageName);
	}

	async getConfigDrift(
		workspaceRoot: string,
		serviceName: string,
	): Promise<{ key: string; envValues: Record<string, string> }[]> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		const drifts = await this._db.getConfigDriftForService(hash, serviceName);
		return drifts.map(d => ({ key: d.key, envValues: d.envValues }));
	}

	async getTerraformResources(workspaceRoot: string, resourceType?: string): Promise<import('./terraformIndexer.js').TerraformResource[]> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		const resources = await this._db.getTerraformResources(hash);
		if (!resourceType) return resources;
		return resources.filter(r => r.resourceType === resourceType);
	}

	async getPipelineJobs(workspaceRoot: string, stage?: string): Promise<import('./gitlabCiIndexer.js').PipelineJob[]> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		const jobs = await this._db.getPipelineJobs(hash);
		if (!stage) return jobs;
		return jobs.filter(j => j.stage === stage);
	}

	async getIndexingReport(workspaceRoot: string): Promise<string> {
		await this._db.init();
		const hash = hashWorkspaceRoot(workspaceRoot);
		const profile = await this.getProfile(workspaceRoot);
		const stats = await this._db.getIndexingStats(hash);
		const isIndexing = this._scanInProgress.has(workspaceRoot);
		return formatRepoIntelligenceIndexingReport(workspaceRoot, profile, stats, isIndexing);
	}
}
