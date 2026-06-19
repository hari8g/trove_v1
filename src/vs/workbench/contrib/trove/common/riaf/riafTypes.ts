/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../../base/common/event.js';

export interface RiafConfig {
	/** Output filename written to the workspace root. Default: `{repo_title}_context.md` */
	outputFileName: string;
	/** Max source files the agent is instructed to read. Default: 80 */
	maxFiles: number;
	/** Include test files in analysis. Default: false */
	includeTests: boolean;
}

export const DEFAULT_RIAF_LIMITS = {
	maxFiles: 80,
	includeTests: false,
} as const;

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
