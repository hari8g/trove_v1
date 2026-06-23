/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../../base/common/event.js';
import type { WorkspaceProfile } from '../repoIntelligenceTypes.js';

export interface RiafConfig {
	/** Output filename written to the workspace root. Default: `{repo_title}_context.md` */
	outputFileName: string;
	/** Max source files the agent is instructed to read. Default: 150 */
	maxFiles: number;
	/** Include test files in analysis. Default: false */
	includeTests: boolean;
}

export const DEFAULT_RIAF_LIMITS = {
	maxFiles: 150,
	includeTests: false,
} as const;

/**
 * Pre-computed intelligence from the repo index, injected into the RIAF prompt so the
 * agent can skip expensive Phase-1 discovery for facts already known.
 */
export type RiafIndexSnapshot = {
	languageStack: string[];
	frameworks: string[];
	packageManagers: string[];
	fileCount: number;
	totalLoc: number;
	chunkCount: number;
	projectPurpose: string | null;
	architectureSummary: string | null;
	buildCommands: string[];
	testCommands: string[];
	/** Spring microservice names detected by the indexer */
	serviceNames: string[];
	/** Total REST endpoints indexed */
	totalEndpoints: number;
	/** Total Maven pom.xml files */
	pomCount: number;
	/** Total K8s resources */
	k8sResourceCount: number;
	/** GitLab CI jobs */
	pipelineJobCount: number;
	/** Top shared NPM packages */
	sharedNpmPackages: string[];
};

export const buildRiafIndexSnapshot = (
	profile: WorkspaceProfile | null,
	chunkCount: number,
): RiafIndexSnapshot => ({
	languageStack: profile?.languageStack ?? [],
	frameworks: profile?.frameworks.map(f => f.name) ?? [],
	packageManagers: profile?.packageManagers ?? [],
	fileCount: profile?.fileCount ?? 0,
	totalLoc: profile?.totalLoc ?? 0,
	chunkCount,
	projectPurpose: profile?.projectPurpose ?? null,
	architectureSummary: profile?.architectureSummary ?? null,
	buildCommands: profile?.buildCommands.slice(0, 4).map(c => c.command) ?? [],
	testCommands: profile?.testCommands.slice(0, 3).map(c => c.command) ?? [],
	serviceNames: profile?.serviceTopologySummary?.serviceNames ?? [],
	totalEndpoints: profile?.serviceTopologySummary?.totalEndpoints ?? 0,
	pomCount: profile?.mavenImpactSummary?.pomCount ?? 0,
	k8sResourceCount: profile?.k8sResourceCount ?? 0,
	pipelineJobCount: profile?.pipelineSummary?.jobCount ?? 0,
	sharedNpmPackages: profile?.npmImpactSummary?.sharedPackages.slice(0, 6).map(p => p.packageName) ?? [],
});

/** Shown in chat UI when a RIAF run starts (full prompt is sent to the model only). */
export const RIAF_USER_DISPLAY_MESSAGE = 'Starting to inspect repository…';

/** e.g. `trove_v1` → `trove_v1_context.md` */
export const deriveRiafOutputFileName = (repoTitle: string): string => {
	const normalized = repoTitle
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	return `${normalized || 'repo'}_context.md`;
};

export const buildRiafConfig = (repoTitle: string, override?: Partial<RiafConfig>): RiafConfig => ({
	outputFileName: override?.outputFileName ?? deriveRiafOutputFileName(repoTitle),
	maxFiles: override?.maxFiles ?? DEFAULT_RIAF_LIMITS.maxFiles,
	includeTests: override?.includeTests ?? DEFAULT_RIAF_LIMITS.includeTests,
});

export type RiafRunState =
	| { status: 'idle' }
	| { status: 'running'; threadId: string }
	| { status: 'done'; threadId: string; outputPath: string }
	| { status: 'error'; threadId: string; message: string };

export interface IRiafAgentService {
	readonly _serviceBrand: undefined;
	readonly state: RiafRunState;
	/** Expected output filename for the open workspace (e.g. `trove_v1_context.md`). */
	readonly expectedOutputFileName: string;
	readonly onDidChangeState: Event<RiafRunState>;
	startRun(config?: Partial<RiafConfig>): Promise<void>;
	abort(): Promise<void>;
}

export const IRiafAgentService = createDecorator<IRiafAgentService>('riafAgentService');
