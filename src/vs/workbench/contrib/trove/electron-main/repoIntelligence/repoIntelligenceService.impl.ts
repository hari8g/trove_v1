/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import { basename, extname, join } from 'path';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js';
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { ApiContractResult, CodebaseSearchResult, ContextualProfile, ExtractedSymbol, FileMetadataEntry, GitFileStats, IRepoIntelligenceMainService, MavenImpactSummary, REPO_INTEL_PROFILE_STALE_MS, ServiceTopologySummary, UCGGraphData, UCGGraphMetrics, WorkspaceProfile } from '../../common/repoIntelligenceTypes.js';
import { getTroveMemoryFilePath } from '../../common/troveMemoryPaths.js';
import { TROVE_SETTINGS_STORAGE_KEY } from '../../common/storageKeys.js';
import { TroveSettingsState } from '../../common/troveSettingsService.js';
import { IMetricsService } from '../../common/metricsService.js';
import { sendLLMMessage } from '../llmMessage/sendLLMMessage.js';
import { detectCommands } from './commandDetector.js';
import { buildChunksForWorkspace, chunkFile, extractSymbolsFromFile, SKIP_LANGUAGES, supportsSymbolExtraction } from './codeChunker.js';
import { indexGatewayRoutes } from './gatewayRouteIndexer.js';
import { indexGitlabPipelines } from './gitlabCiIndexer.js';
import { indexAllSpringServices } from './javaSpringIndexer.js';
import { indexConfigEnvironments } from './configEnvIndexer.js';
import { resolveOrgExtensionIndexerOptions, OrgExtensionIndexerOptions } from '../../extensions/staas/staasIndexerDefaults.js';
import { getGitDiffStat, getRecentlyChangedFiles } from './gitContextIndexer.js';
import { embedText, embedTexts } from './embeddingService.js';
import { indexKubernetesManifests } from './kubernetesYamlIndexer.js';
import { indexMavenDependencies } from './mavenDependencyIndexer.js';
import { indexNpmDependencies } from './npmImpactIndexer.js';
import { indexTerraformResources } from './terraformIndexer.js';
import { formatRepoIntelligenceIndexingReport } from '../../common/repoIntelligenceIndexingReport.js';
import { getRepoIntelligenceDbPath, hashWorkspaceRoot, RepoIntelligenceDb, UCGFileNode, UCGImportEdge } from './repoIntelligenceDb.js';
import { RawScanResult, scanWorkspace } from './workspaceScanner.js';
import { extractImports } from './universalImportExtractor.js';
import { FileChangeEvent, WorkspaceFileWatcher } from './fileWatcher.js';
import { classifyNode, isEntryPoint } from './universalNodeClassifier.js';
import { computeMetrics } from './universalGraphAnalyzer.js';

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
	private _fileWatcher: WorkspaceFileWatcher | null = null;
	private _watchedRoot: string | null = null;

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
				await this._ensureUCGIndexed(workspaceRoot, hash);
				return this._hydrateStaasSummaries(hash, existing);
			}
		}

		return this._ensureScan(workspaceRoot);
	}

	async refreshProfile(workspaceRoot: string, indexerOptions?: OrgExtensionIndexerOptions): Promise<WorkspaceProfile> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		await this._db.markStale(hash);
		this._scanInProgress.delete(workspaceRoot);
		return this._ensureScan(workspaceRoot, indexerOptions);
	}

	private async _ensureScan(workspaceRoot: string, indexerOptions?: OrgExtensionIndexerOptions): Promise<WorkspaceProfile> {
		const inProgress = this._scanInProgress.get(workspaceRoot);
		if (inProgress) return inProgress;

		const promise = this._scanWorkspace(workspaceRoot, indexerOptions);
		this._scanInProgress.set(workspaceRoot, promise);
		try {
			return await promise;
		} finally {
			this._scanInProgress.delete(workspaceRoot);
		}
	}

	private async _scanWorkspace(workspaceRoot: string, indexerOptions?: OrgExtensionIndexerOptions): Promise<WorkspaceProfile> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		const resolvedIndexerOptions = resolveOrgExtensionIndexerOptions(indexerOptions);
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

			const npmResult = indexNpmDependencies(workspaceRoot, [...resolvedIndexerOptions.npmScopes]);
			if (npmResult.edges.length > 0) {
				await this._db.replaceNpmEdges(hash, npmResult.edges);
				this._metricsService.capture('STaaS NPM Indexed', {
					packageJsonCount: npmResult.packageJsonCount,
					edgeCount: npmResult.edges.length,
				});
			}

			const configResult = indexConfigEnvironments(workspaceRoot, { configServerDirs: resolvedIndexerOptions.configServerDirs });
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

		// ── Universal Context Graph ──────────────────────────────────────────────
		try {
			await this._indexUniversalContextGraph(workspaceRoot, hash, scan.fileMeta);
		} catch (err) {
			console.error('[UniversalContextGraph] Indexing failed:', err);
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

		// Start (or restart) the real-time file watcher for this workspace
		this._startFileWatcher(workspaceRoot, hash);

		return profile;
	}

	private _startFileWatcher(workspaceRoot: string, hash: string): void {
		if (this._watchedRoot === workspaceRoot) return;
		if (this._fileWatcher) {
			this._fileWatcher.stop();
			this._fileWatcher = null;
		}
		this._watchedRoot = workspaceRoot;
		const watcher = new WorkspaceFileWatcher();
		watcher.on('changes', (events: FileChangeEvent[]) => {
			void this._handleFileChanges(workspaceRoot, hash, events);
		});
		watcher.start(workspaceRoot);
		this._fileWatcher = watcher;
		this._register({ dispose: () => { watcher.stop(); } });
	}

	private async _handleFileChanges(
		workspaceRoot: string,
		hash: string,
		events: FileChangeEvent[],
	): Promise<void> {
		for (const event of events) {
			const language = (() => {
				const EXT_MAP: Record<string, string> = {
					'.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
					'.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
					'.py': 'Python', '.java': 'Java', '.kt': 'Kotlin', '.rs': 'Rust', '.go': 'Go',
					'.cs': 'C#', '.cpp': 'C++', '.cc': 'C++', '.c': 'C', '.rb': 'Ruby', '.php': 'PHP',
					'.swift': 'Swift', '.scala': 'Scala', '.sh': 'Shell', '.bash': 'Shell',
					'.sql': 'SQL', '.yml': 'YAML', '.yaml': 'YAML', '.md': 'Markdown', '.mdx': 'Markdown',
				};
				return EXT_MAP[extname(event.filePath).toLowerCase()] ?? null;
			})();

			if (!language || SKIP_LANGUAGES.has(language)) continue;

			if (event.type === 'unlink') {
				await this._db.replaceChunksForFile(hash, event.filePath, []);
				await this._db.deleteChunkFileHash(hash, event.filePath);
				await this._db.deleteChunkEmbeddingsForFile(hash, event.filePath);
				continue;
			}

			const absPath = join(workspaceRoot, event.filePath);
			let content: string;
			try { content = readFileSync(absPath, 'utf8'); } catch { continue; }

			const currentHash = createHash('sha256').update(content).digest('hex').slice(0, 32);
			const storedHash = (await this._db.getChunkFileHashes(hash)).get(event.filePath);
			if (storedHash === currentHash) continue;

			const chunks = chunkFile(hash, event.filePath, content, language);
			await this._db.replaceChunksForFile(hash, event.filePath, chunks);
			await this._db.upsertChunkFileHash(hash, event.filePath, currentHash);
			void this._indexEmbeddingsForFile(hash, event.filePath).catch(err => {
				console.warn('[RepoIntelligence] File embedding index failed:', err);
			});

			if (supportsSymbolExtraction(language)) {
				const symbols = extractSymbolsFromFile(hash, event.filePath, content, language);
				await this._db.replaceSymbolsForFile(hash, event.filePath, symbols);
			}
		}
	}

	private async _hydrateStaasSummaries(
		hash: string,
		profile: WorkspaceProfile,
		scanExtras?: { configFileCount?: number },
	): Promise<WorkspaceProfile> {
		const [
			endpoints, feignClients, routes, mavenDeps, npmEdges, driftStats,
			tfResources, tfMeta, pipelineJobs, pipelineMeta, k8sCount,
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
			this._db.getK8sResourceCount(hash),
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
			const mavenImpact: MavenImpactSummary = { sharedLibs, pomCount: pomPaths.size };
			hydrated = { ...hydrated, mavenImpactSummary: mavenImpact };
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
			const packageJsonCount = new Set(npmEdges.map(e => e.consumerPath)).size;
			hydrated = {
				...hydrated,
				npmImpactSummary: { sharedPackages: topNpmLibs, packageJsonCount },
			};
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

		if (k8sCount > 0) {
			hydrated = { ...hydrated, k8sResourceCount: k8sCount };
		}

		return hydrated;
	}

	private async _ensureUCGIndexed(workspaceRoot: string, hash: string): Promise<void> {
		const nodeCount = await this._db.getUCGNodeCount(hash);
		if (nodeCount > 0) {
			return;
		}

		const fileMeta = await this._db.getFileMetadata(hash);
		if (fileMeta.length === 0) {
			return;
		}

		try {
			await this._indexUniversalContextGraph(workspaceRoot, hash, fileMeta);
		} catch (err) {
			console.error('[UniversalContextGraph] Backfill indexing failed:', err);
		}
	}

	private async _indexUniversalContextGraph(
		workspaceRoot: string,
		hash: string,
		fileMeta: FileMetadataEntry[],
	): Promise<void> {
		const ucgStart = Date.now();
		const allNodes: UCGFileNode[] = [];
		const allEdges: UCGImportEdge[] = [];

		for (const meta of fileMeta) {
			const relPath = meta.filePath;
			const { language } = meta;
			if (!language || SKIP_LANGUAGES.has(language)) {
				continue;
			}

			const absPath = join(workspaceRoot, relPath);
			let content = '';
			try {
				content = readFileSync(absPath, 'utf8');
			} catch {
				continue;
			}

			const normalizedPath = relPath.replace(/\\/g, '/');
			const classification = classifyNode(normalizedPath, content);
			const imports = extractImports(absPath, content, language, workspaceRoot);

			allNodes.push({
				filePath: normalizedPath,
				language,
				nodeType: classification.nodeType,
				archLayer: classification.layer,
				isEntryPoint: false,
				importCount: imports.filter(e => !e.isExternal).length,
				importedByCount: 0,
			});

			for (const imp of imports) {
				allEdges.push({
					fromFile: normalizedPath,
					toModule: imp.toModule,
					resolvedFile: imp.resolvedFile,
					isExternal: imp.isExternal,
					edgeType: imp.edgeType,
				});
			}
		}

		const metrics = computeMetrics(allNodes, allEdges.map(e => ({
			fromFile: e.fromFile,
			toModule: e.toModule,
			resolvedFile: e.resolvedFile,
			isExternal: e.isExternal,
			edgeType: e.edgeType as 'import' | 'require' | 'include' | 'use' | 'from_import',
		})));

		for (const node of allNodes) {
			const inDeg = allEdges.filter(e => e.resolvedFile === node.filePath).length;
			node.isEntryPoint = isEntryPoint(node.filePath, '', inDeg);
			node.importedByCount = inDeg;
		}

		await this._db.replaceUCGNodes(hash, allNodes);
		await this._db.replaceUCGEdges(hash, allEdges);
		await this._db.upsertUCGMetrics(hash, {
			totalNodes: metrics.totalNodes,
			totalEdges: metrics.totalEdges,
			entryCount: metrics.entryPoints.length,
			cycleCount: metrics.cycleCount,
			cycles: metrics.cycles,
			hotFiles: metrics.hotFiles,
			externalDeps: Object.fromEntries(metrics.externalDeps),
			computedAt: Date.now(),
		});

		this._metricsService.capture('UCG Indexed', {
			nodeCount: allNodes.length,
			edgeCount: allEdges.length,
			cycleCount: metrics.cycleCount,
			durationMs: Date.now() - ucgStart,
		});
		console.log(`[UniversalContextGraph] Indexed ${allNodes.length} nodes, ${allEdges.length} edges in ${Date.now() - ucgStart}ms`);
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

		// Incremental: only rebuild chunks for files whose content has changed
		const storedChunkHashes = await this._db.getChunkFileHashes(hash);
		const indexable = fileMeta.filter(f => f.language && !SKIP_LANGUAGES.has(f.language));
		let updatedFiles = 0;
		let totalChunks = 0;

		for (const file of indexable) {
			const absPath = join(workspaceRoot, file.filePath);
			let content: string;
			try { content = readFileSync(absPath, 'utf8'); } catch { continue; }

			const currentHash = createHash('sha256').update(content).digest('hex').slice(0, 32);
			if (storedChunkHashes.get(file.filePath) === currentHash) continue;

			const chunks = chunkFile(hash, file.filePath, content, file.language);
			await this._db.replaceChunksForFile(hash, file.filePath, chunks);
			await this._db.upsertChunkFileHash(hash, file.filePath, currentHash);
			updatedFiles++;
			totalChunks += chunks.length;
		}

		// Remove hashes for files no longer in the index
		const currentPaths = new Set(indexable.map(f => f.filePath));
		for (const storedPath of storedChunkHashes.keys()) {
			if (!currentPaths.has(storedPath)) {
				await this._db.replaceChunksForFile(hash, storedPath, []);
				await this._db.deleteChunkFileHash(hash, storedPath);
			}
		}

		const elapsed = Date.now() - chunkStart;
		if (updatedFiles > 0) {
			console.log(`[RepoIntelligence] Incrementally updated chunks for ${updatedFiles} files (${totalChunks} chunks) in ${elapsed}ms`);
		} else {
			console.log(`[RepoIntelligence] Chunk index up-to-date (${elapsed}ms)`);
		}
		this._metricsService.capture('RepoIntelligence Chunks Indexed', { updatedFiles, totalChunks, workspaceRoot });

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
	): Promise<ApiContractResult | null> {
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

	async getUCGGraph(workspaceRoot: string): Promise<UCGGraphData | null> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		await this._ensureUCGIndexed(workspaceRoot, hash);
		const graph = await this._db.getUCGGraph(hash);
		if (graph.nodes.length === 0 && graph.edges.length === 0) {
			return null;
		}
		const metrics = await this._db.getUCGMetrics(hash);
		return { ...graph, metrics };
	}

	async getUCGMetrics(workspaceRoot: string): Promise<UCGGraphMetrics | null> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		return this._db.getUCGMetrics(hash);
	}

	async getImportGraph(workspaceRoot: string, relFilePath: string, direction: 'imports' | 'importedBy' | 'both'): Promise<{ imports: string[]; importedBy: string[]; externalDeps: string[] }> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		await this._ensureUCGIndexed(workspaceRoot, hash);

		const normPath = relFilePath.replace(/\\/g, '/');
		const [outEdges, inEdges] = await Promise.all([
			(direction === 'importedBy') ? Promise.resolve([]) : this._db.getImportEdgesFrom(hash, normPath),
			(direction === 'imports') ? Promise.resolve([]) : this._db.getImportEdgesTo(hash, normPath),
		]);

		return {
			imports: outEdges.filter(e => !e.isExternal && e.resolvedFile).map(e => e.resolvedFile!),
			importedBy: inEdges.map(e => e.fromFile),
			externalDeps: outEdges.filter(e => e.isExternal).map(e => e.toModule),
		};
	}

	async getTestsForFile(workspaceRoot: string, relFilePath: string): Promise<{ testFile: string; confidence: 'high' | 'medium' }[]> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();

		// Load all file paths from the index
		const allFiles = await this._db.getFileMetadata(hash);

		const TEST_PATTERNS = [/\.(test|spec)\.(ts|js|tsx|jsx|py|java|kt|rb)$/, /Test\.(java|kt)$/, /_test\.(py|go|rs)$/];
		const isTestFile = (p: string) => TEST_PATTERNS.some(r => r.test(p));

		const sourceBase = basename(relFilePath).replace(/\.[^.]+$/, '').toLowerCase();
		const results: { testFile: string; confidence: 'high' | 'medium' }[] = [];

		for (const f of allFiles) {
			if (!isTestFile(f.filePath)) continue;

			// Strategy 1: name proximity (OrderService.test.ts → OrderService.ts)
			const testBase = basename(f.filePath)
				.replace(/\.(test|spec|_test|Test)\.(ts|js|tsx|jsx|py|java|kt|rb)$/, '')
				.replace(/Test$/, '')
				.toLowerCase();

			if (testBase === sourceBase) {
				results.push({ testFile: f.filePath, confidence: 'high' });
				continue;
			}

			// Strategy 2: import-based (test file imports the source file)
			const outEdges = await this._db.getImportEdgesFrom(hash, f.filePath);
			const importsSource = outEdges.some(e =>
				e.resolvedFile?.replace(/\.[^.]+$/, '') === relFilePath.replace(/\.[^.]+$/, '')
			);
			if (importsSource) {
				results.push({ testFile: f.filePath, confidence: 'medium' });
			}
		}

		return results;
	}

	async getGitDiffStat(workspaceRoot: string): Promise<string | null> {
		return getGitDiffStat(workspaceRoot);
	}

	async getGitRecentlyChanged(workspaceRoot: string, limit = 20): Promise<GitFileStats[]> {
		return getRecentlyChangedFiles(workspaceRoot, limit);
	}

	async getContextualProfile(workspaceRoot: string, opts: { activeUri?: string; recentlyEditedUris?: string[] }): Promise<ContextualProfile | null> {
		if (!opts.activeUri) return null;
		await this._db.init();

		const absPath = opts.activeUri;
		const relPath = absPath.startsWith(workspaceRoot)
			? absPath.slice(workspaceRoot.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
			: absPath.replace(/\\/g, '/');

		// Get import graph
		let imports: string[] = [];
		let importedBy: string[] = [];
		try {
			const graph = await this.getImportGraph(workspaceRoot, relPath, 'both');
			imports = graph.imports;
			importedBy = graph.importedBy;
		} catch { /* UCG may not be indexed yet */ }

		// Get test files
		let coveringTests: string[] = [];
		try {
			const tests = await this.getTestsForFile(workspaceRoot, relPath);
			coveringTests = tests.map(t => t.testFile);
		} catch { /* ignore */ }

		const relatedFiles = [...new Set([...imports, ...importedBy])];
		return { activeFile: relPath, relatedFiles, coveringTests };
	}

	async searchCodebaseHybrid(workspaceRoot: string, query: string, maxResults = 10): Promise<CodebaseSearchResult[]> {
		await this._db.init();
		const hash = hashWorkspaceRoot(workspaceRoot);
		const queryEmbedding = await embedText(query);
		return this._db.searchChunksHybrid(hash, query, queryEmbedding, maxResults);
	}

	async indexEmbeddingsForWorkspace(workspaceRoot: string): Promise<void> {
		await this._db.init();
		const hash = hashWorkspaceRoot(workspaceRoot);
		const rows = await this._db.getChunksWithoutEmbeddings(hash, 500);
		if (rows.length === 0) return;

		const texts = rows.map(r => r.chunk_text.slice(0, 512));
		const embeddings = await embedTexts(texts);
		if (!embeddings) return; // LiteLLM not available

		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const emb = embeddings[i];
			if (emb) {
				await this._db.upsertChunkEmbedding(hash, row.file_path, row.start_line, emb);
			}
		}
	}

	private async _indexEmbeddingsForFile(workspaceHash: string, filePath: string): Promise<void> {
		await this._db.init();
		const rows = await this._db.getChunksForFile(workspaceHash, filePath);
		if (rows.length === 0) {
			await this._db.deleteChunkEmbeddingsForFile(workspaceHash, filePath);
			return;
		}
		const texts = rows.map(r => r.chunk_text.slice(0, 512));
		const embeddings = await embedTexts(texts);
		if (!embeddings) return;
		await this._db.deleteChunkEmbeddingsForFile(workspaceHash, filePath);
		for (let i = 0; i < rows.length; i++) {
			const emb = embeddings[i];
			if (emb) {
				await this._db.upsertChunkEmbedding(workspaceHash, rows[i].file_path, rows[i].start_line, emb);
			}
		}
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
