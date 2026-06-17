/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { BuiltinToolCallParams, ToolName } from '../common/toolsServiceTypes.js';
import { getProtectedTailStartIndex } from './contextWindowTrim.js';

/** How many recent compactable tool results stay at full size within the current agent run. */
export const RECENT_FULL_TOOL_RESULTS = 2;

export const COMPACTABLE_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
	'read_file',
	'search_codebase',
	'search_web',
	'search_for_files',
	'search_in_file',
	'search_pathnames_only',
	'get_dir_tree',
	'ls_dir',
]);

export const isCompactableToolName = (toolName: ToolName): boolean => {
	return COMPACTABLE_TOOL_NAMES.has(toolName);
};

const formatReadFileCompact = (params: BuiltinToolCallParams['read_file'], content: string): string => {
	const path = params.uri instanceof URI ? params.uri.fsPath : String(params.uri);
	const lineCount = content.split('\n').length;
	const start = params.startLine ?? 1;
	const end = params.endLine ?? start + lineCount - 1;
	return `read_file(${path}) → <${lineCount} lines, lines ${start}-${end}>; re-read if needed`;
};

const formatGenericCompact = (toolName: ToolName, content: string): string => {
	const lineCount = content.split('\n').length;
	return `${toolName}(...) → <${lineCount} lines>; re-run if needed`;
};

/** Replace stale compactable tool bodies with short references before wire conversion. */
export const compactStaleToolResults = (chatMessages: ChatMessage[]): ChatMessage[] => {
	const tailStart = getProtectedTailStartIndex(chatMessages);

	const compactableIndices = chatMessages
		.map((message, index) => ({ message, index }))
		.filter(({ message, index }) => {
			return message.role === 'tool'
				&& message.compactable
				&& message.type === 'success';
		})
		.map(({ index }) => index);

	// Within the protected tail (typical single-turn agent runs), still compact all but the last N read/search results.
	const tailCompactable = compactableIndices.filter(index => index >= tailStart);
	const staleTailIndices = new Set(tailCompactable.slice(0, -RECENT_FULL_TOOL_RESULTS));
	const stalePrefixIndices = new Set(compactableIndices.filter(index => index < tailStart));

	return chatMessages.map((message, index) => {
		if (message.role !== 'tool') {
			return message;
		}
		if (!message.compactable || message.type !== 'success') {
			return message;
		}
		if (!stalePrefixIndices.has(index) && !staleTailIndices.has(index)) {
			return message;
		}

		let compactContent: string;
		if (message.name === 'read_file') {
			compactContent = formatReadFileCompact(
				message.params as BuiltinToolCallParams['read_file'],
				message.content,
			);
		} else {
			compactContent = formatGenericCompact(message.name, message.content);
		}

		if (compactContent === message.content) {
			return message;
		}
		return { ...message, content: compactContent };
	});
};
