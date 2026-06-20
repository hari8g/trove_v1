/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import type { RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { isEditToolName } from './agentEditCompletionHints.js';

/** Filter DevTools console with: Trove edit */
export const EDIT_DIAGNOSTICS_PREFIX = '[Trove edit]';

export type EditDiagnosticStage =
	| 'stream_start'
	| 'stream_progress'
	| 'llm_final'
	| 'stream_interrupted'
	| 'completion_nudge'
	| 'tool_dispatch'
	| 'tool_validate_ok'
	| 'tool_validate_fail'
	| 'tool_approval_blocked'
	| 'tool_execute_start'
	| 'tool_execute_done'
	| 'tool_execute_error'
	| 'apply_diffzone_skip'
	| 'apply_start'
	| 'apply_blocks'
	| 'apply_done'
	| 'apply_error'
	| 'auto_accept';

type EditDiagnosticDetail = Record<string, string | number | boolean | null | undefined>;

const summarizeRawParams = (rawParams: RawToolParamsObj | undefined): EditDiagnosticDetail => {
	if (!rawParams) {
		return { paramKeys: 'none' };
	}
	const keys = Object.keys(rawParams);
	const detail: EditDiagnosticDetail = {
		paramKeys: keys.join(',') || 'none',
	};
	for (const key of keys) {
		const val = rawParams[key];
		if (typeof val === 'string') {
			detail[`${key}Len`] = val.length;
		}
	}
	return detail;
};

export const summarizeEditToolCall = (toolCall: RawToolCallObj | null | undefined): EditDiagnosticDetail => {
	if (!toolCall) {
		return { hasToolCall: false };
	}
	return {
		hasToolCall: true,
		toolName: toolCall.name,
		toolId: toolCall.id,
		isDone: toolCall.isDone,
		doneParams: toolCall.doneParams.join(',') || 'none',
		...summarizeRawParams(toolCall.rawParams),
	};
};

export const logEditDiagnostic = (stage: EditDiagnosticStage, detail: EditDiagnosticDetail = {}): void => {
	console.info(`${EDIT_DIAGNOSTICS_PREFIX} ${stage}`, detail);
};

export const warnEditDiagnostic = (stage: EditDiagnosticStage, detail: EditDiagnosticDetail = {}): void => {
	console.warn(`${EDIT_DIAGNOSTICS_PREFIX} ${stage}`, detail);
};

export const errorEditDiagnostic = (stage: EditDiagnosticStage, detail: EditDiagnosticDetail & { error?: string } = {}): void => {
	console.error(`${EDIT_DIAGNOSTICS_PREFIX} ${stage}`, detail);
};

export const uriPathForLog = (uri: URI | string | undefined): string | undefined => {
	if (!uri) {
		return undefined;
	}
	return uri instanceof URI ? uri.fsPath : String(uri);
};

export const shouldTraceEditToolCall = (toolCall: RawToolCallObj | null | undefined): boolean =>
	Boolean(toolCall && isEditToolName(toolCall.name));
