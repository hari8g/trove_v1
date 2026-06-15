/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

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

export interface IRepoIntelligenceMainService {
	readonly _serviceBrand: undefined;
	getProfile(workspaceRoot: string): Promise<WorkspaceProfile | null>;
	refreshProfile(workspaceRoot: string): Promise<WorkspaceProfile>;
}

export const IRepoIntelligenceMainService = createDecorator<IRepoIntelligenceMainService>('repoIntelligenceMainService');

export interface IRepoIntelligenceService extends IRepoIntelligenceMainService {
	getProfileSync(): WorkspaceProfile | null;
}

export const IRepoIntelligenceService = createDecorator<IRepoIntelligenceService>('repoIntelligenceService');

export const REPO_INTEL_PROFILE_STALE_MS = 24 * 60 * 60 * 1000;
