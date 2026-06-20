/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

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

export type WorkspaceProfile = {
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

export interface IRepoIntelligenceMainService {
	readonly _serviceBrand: undefined;
	getProfile(workspaceRoot: string): Promise<WorkspaceProfile | null>;
	refreshProfile(workspaceRoot: string): Promise<WorkspaceProfile>;
	searchCodebase(workspaceRoot: string, query: string, maxResults?: number): Promise<CodebaseSearchResult[]>;
	getChunkCount(workspaceRoot: string): Promise<number>;
	getFileOutline(workspaceRoot: string, filePath: string): Promise<ExtractedSymbol[]>;
	getSymbol(workspaceRoot: string, filePath: string, symbolName: string): Promise<ExtractedSymbol | null>;
	searchSymbols(workspaceRoot: string, query: string, maxResults?: number): Promise<ExtractedSymbol[]>;
	getUserMemory(): string | null;
	appendToUserMemory(text: string): Promise<void>;
}

export const IRepoIntelligenceMainService = createDecorator<IRepoIntelligenceMainService>('repoIntelligenceMainService');

export interface IRepoIntelligenceService extends IRepoIntelligenceMainService {
	getProfileSync(): WorkspaceProfile | null;
	getWorkspaceRules(): string | null;
	/** Idempotent — safe to call after workspace restore or folder changes. */
	ensureInitialized(): Promise<void>;
	readonly onDidChangeWorkspaceRules: Event<void>;
	readonly onDidChangeChunkIndex: Event<number>;
	readonly onDidChangeUserMemory: Event<void>;
}

export const IRepoIntelligenceService = createDecorator<IRepoIntelligenceService>('repoIntelligenceService');

export const REPO_INTEL_PROFILE_STALE_MS = 24 * 60 * 60 * 1000;

// Injection char budget caps (per mode). CHARS_PER_TOKEN ≈ 4 in wireMessageTrim.
export const REPO_PROFILE_MAX_CHARS: Record<'agent' | 'gather' | 'normal', number> = {
	agent: 4_800,  // ~1 200 tokens — full structural context
	gather: 3_200, // ~800 tokens — commands + framework
	normal: 1_600, // ~400 tokens — language + minimal facts
};
