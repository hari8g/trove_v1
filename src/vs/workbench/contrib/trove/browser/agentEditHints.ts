/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ToolName } from '../common/toolsServiceTypes.js';

export const REPEAT_EDIT_THRESHOLD = 2;

export const trackFileEdit = (
	counts: Map<string, number>,
	toolName: ToolName,
	toolParams: Record<string, unknown>,
): void => {
	if (toolName !== 'edit_file' && toolName !== 'rewrite_file') {
		return;
	}
	const uri = toolParams.uri;
	const path = uri instanceof URI ? uri.fsPath : typeof uri === 'string' ? uri : undefined;
	if (!path) {
		return;
	}
	counts.set(path, (counts.get(path) ?? 0) + 1);
};

export const buildRepeatEditHint = (fileEditCounts: Map<string, number>): string => {
	const repeated = [...fileEditCounts.entries()]
		.filter(([, count]) => count >= REPEAT_EDIT_THRESHOLD)
		.map(([path]) => path);
	if (repeated.length === 0) {
		return '';
	}
	const fileList = repeated.map(p => p.split(/[/\\]/).pop() ?? p).join(', ');
	return `\n\n<agent_hints>
You have edited the same file(s) multiple times this run (${fileList}). Stop making incremental edits.
Read the current file state once, then apply ALL remaining related changes in a single edit_file call with multiple SEARCH/REPLACE blocks (or one rewrite_file if replacing most of the file).
</agent_hints>`;
};
