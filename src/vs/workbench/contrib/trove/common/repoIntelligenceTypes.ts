/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { OrgExtensionIndexerOptions } from '../extensions/staas/staasIndexerDefaults.js';
import type {
	IStaasRepoIntelligenceMethods,
	StaasWorkspaceProfileFields,
} from '../extensions/staas/staasRepoIntelligenceTypes.js';

export type {
	ApiContractResult,
	ConfigDriftSummary,
	IStaasRepoIntelligenceMethods,
	MavenImpactSummary,
	NpmImpactSummary,
	ServiceTopologySummary,
	StaasWorkspaceProfileFields,
} from '../extensions/staas/staasRepoIntelligenceTypes.js';
export type { OrgExtensionIndexerOptions } from '../extensions/staas/staasIndexerDefaults.js';

export const REPO_INTEL_CHANNEL = 'trove-channel-repoIntelligence';

export type CommandPurpose = 'build' | 'test' | 'lint' | 'typecheck' | 'start' | 'format';

export type CommandEntry = {
	command: string;
	purpose: CommandPurpose;
	confidence: 'high' | 'medium' | 'low';
	source: string;
};

export type FrameworkEntry = {
	name: string;
	version: string | null;
	confidence: 'high' | 'medium' | 'low';
};

export type CoreWorkspaceProfile = {
	workspaceRoot: string;
	lastScannedAt: number;
	languageStack: string[];
	frameworks: FrameworkEntry[];
	packageManagers: string[];
	buildCommands: CommandEntry[];
	testCommands: CommandEntry[];
	lintCommands: CommandEntry[];
	typecheckCommands: CommandEntry[];
	projectPurpose: string | null;
	architectureSummary: string | null;
	fileCount: number;
	totalLoc: number;
	isStale: boolean;
	/** Terraform IaC resource summary */
	terraformSummary?: TerraformSummary | null;
	/** GitLab CI pipeline structure summary */
	pipelineSummary?: PipelineSummary | null;
	/** Number of K8s resources indexed (Deployments, Services, Ingresses, etc.) */
	k8sResourceCount?: number;
};

export type WorkspaceProfile = CoreWorkspaceProfile & StaasWorkspaceProfileFields;

export type TerraformSummary = {
	resourceCount: number;
	providers: string[];
	fileCount: number;
	topResourceTypes: string[];
};

export type PipelineSummary = {
	stageCount: number;
	jobCount: number;
	hasManualGates: boolean;
	stages: string[];
};

/** Terraform resource row returned by getTerraformResources */
export type TerraformResourceRow = {
	filePath: string;
	resourceType: string;
	resourceName: string;
	provider: string;
};

/** GitLab CI job row returned by getPipelineJobs */
export type PipelineJobRow = {
	name: string;
	stage: string;
	needs: string[];
	filePath: string;
};

export type UCGFileNode = {
	filePath: string;
	language: string;
	nodeType: string;
	archLayer: string;
	isEntryPoint: boolean;
	importCount: number;
	importedByCount: number;
};

export type UCGImportEdge = {
	fromFile: string;
	toModule: string;
	resolvedFile: string | null;
	isExternal: boolean;
	edgeType: string;
};

export type UCGGraphMetrics = {
	totalNodes: number;
	totalEdges: number;
	entryCount: number;
	cycleCount: number;
	cycles: string[][];
	hotFiles: string[];
	externalDeps: Record<string, number>;
	computedAt: number;
};

export type UCGGraphData = {
	nodes: UCGFileNode[];
	edges: UCGImportEdge[];
	metrics: UCGGraphMetrics | null;
};

export type FileMetadataEntry = {
	filePath: string;
	language: string | null;
	lastModified: number;
	sizeBytes: number;
};

export type CodeChunkType = 'function' | 'class' | 'block' | 'file';

export type CodeChunk = {
	id: string;
	filePath: string;
	chunkText: string;
	startLine: number;
	endLine: number;
	chunkType: CodeChunkType;
};

export type CodebaseSearchResult = {
	filePath: string;
	startLine: number;
	endLine: number;
	snippet: string;
	score: number;
};

export type ExtractedSymbol = {
	name: string;
	kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const';
	filePath: string;
	startLine: number;
	endLine: number;
	signature: string;
	docstring: string;
	isExported: boolean;
	contentHash: string;
};

export type RepoIntelligenceIndexingStats = {
	chunkCount: number;
	indexedFileCount: number;
	totalFileCount: number;
	indexableFileCount: number;
	symbolCount: number;
	symbolFileCount: number;
	chunksByType: Record<string, number>;
	filesByLanguage: Record<string, number>;
	chunksByLanguage: Record<string, number>;
	symbolsByLanguage: Record<string, number>;
	springEndpoints: number;
	feignClients: number;
	mavenDeps: number;
	k8sResources: number;
	gatewayRoutes: number;
	npmEdges: number;
	configDrift: number;
	terraformResources: number;
	pipelineJobs: number;
	/** Present when stats were synthesized from profile instead of SQLite aggregates */
	statsSource?: 'database' | 'profile';
};

export interface ICoreRepoIntelligenceMainService {
	readonly _serviceBrand: undefined;
	getProfile(workspaceRoot: string): Promise<WorkspaceProfile | null>;
	refreshProfile(workspaceRoot: string, indexerOptions?: OrgExtensionIndexerOptions): Promise<WorkspaceProfile>;
	searchCodebase(workspaceRoot: string, query: string, maxResults?: number): Promise<CodebaseSearchResult[]>;
	getChunkCount(workspaceRoot: string): Promise<number>;
	getFileOutline(workspaceRoot: string, filePath: string): Promise<ExtractedSymbol[]>;
	getSymbol(workspaceRoot: string, filePath: string, symbolName: string): Promise<ExtractedSymbol | null>;
	searchSymbols(workspaceRoot: string, query: string, maxResults?: number): Promise<ExtractedSymbol[]>;
	getUserMemory(): string | null;
	appendToUserMemory(text: string): Promise<void>;
	getTerraformResources(workspaceRoot: string, resourceType?: string): Promise<TerraformResourceRow[]>;
	getPipelineJobs(workspaceRoot: string, stage?: string): Promise<PipelineJobRow[]>;
	getUCGGraph(workspaceRoot: string): Promise<UCGGraphData | null>;
	getUCGMetrics(workspaceRoot: string): Promise<UCGGraphMetrics | null>;
	getImportGraph(workspaceRoot: string, relFilePath: string, direction: 'imports' | 'importedBy' | 'both'): Promise<ImportGraphResult>;
	getTestsForFile(workspaceRoot: string, relFilePath: string): Promise<TestCoverageEntry[]>;
	getGitDiffStat(workspaceRoot: string): Promise<string | null>;
	getGitRecentlyChanged(workspaceRoot: string, limit?: number): Promise<GitFileStats[]>;
	getContextualProfile(workspaceRoot: string, opts: { activeUri?: string; recentlyEditedUris?: string[] }): Promise<ContextualProfile | null>;
	searchCodebaseHybrid(workspaceRoot: string, query: string, maxResults?: number): Promise<CodebaseSearchResult[]>;
	indexEmbeddingsForWorkspace(workspaceRoot: string): Promise<void>;
}

export interface IRepoIntelligenceMainService extends ICoreRepoIntelligenceMainService, IStaasRepoIntelligenceMethods {}

export type ImportGraphResult = {
	imports: string[];       // files this file imports (resolved relative paths)
	importedBy: string[];    // files that import this file
	externalDeps: string[];  // unresolved external module names
};

export type TestCoverageEntry = {
	testFile: string;
	confidence: 'high' | 'medium';
};

export type GitFileStats = {
	file: string;
	changeCount: number;
	lastChanged: string;
};

export type ContextualProfile = {
	activeFile: string;
	relatedFiles: string[];   // imports + importedBy
	coveringTests: string[];  // test files for this source
};

export type ScopedRuleInfo = {
	source: string;
	content: string;
	globs: string[];
	alwaysApply: boolean;
};

export const IRepoIntelligenceMainService = createDecorator<IRepoIntelligenceMainService>('repoIntelligenceMainService');

export interface IRepoIntelligenceService extends IRepoIntelligenceMainService {
	getIndexingReport(workspaceRoot: string): Promise<string>;
	getProfileSync(): WorkspaceProfile | null;
	getWorkspaceRules(activeFilePath?: string): string | null;
	getScopedRulesList(): ScopedRuleInfo[];
	/** Idempotent — safe to call after workspace restore or folder changes. */
	ensureInitialized(): Promise<void>;
	readonly onDidChangeWorkspaceRules: Event<void>;
	readonly onDidChangeChunkIndex: Event<number>;
	readonly onDidChangeUserMemory: Event<void>;
	readonly onDidChangeUCG: Event<void>;
}

export const IRepoIntelligenceService = createDecorator<IRepoIntelligenceService>('repoIntelligenceService');

export const REPO_INTEL_PROFILE_STALE_MS = 24 * 60 * 60 * 1000;

// Injection char budget caps (per mode). CHARS_PER_TOKEN ≈ 4 in wireMessageTrim.
export const REPO_PROFILE_MAX_CHARS: Record<'agent' | 'gather' | 'normal', number> = {
	agent: 8_000,
	gather: 3_200, // ~800 tokens — commands + framework
	normal: 1_600, // ~400 tokens — language + minimal facts
};
