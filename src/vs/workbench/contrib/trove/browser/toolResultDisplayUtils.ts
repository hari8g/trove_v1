/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { isWindows } from '../../../../base/common/platform.js';
import type { ChatMessage, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { BuiltinToolName } from '../common/toolsServiceTypes.js';

const uriKey = (uri: URI): string => {
	const key = uri.toString();
	return isWindows ? key.toLowerCase() : key;
};

const isWriteTool = (toolName: BuiltinToolName): boolean =>
	toolName === 'create_file_or_folder' || toolName === 'rewrite_file' || toolName === 'edit_file';

/** Hide empty read_file rows that are dedup skips or followed by a write to the same path. */
export const isRedundantEmptyFileRead = (
	toolMessage: ToolMessage<'read_file'>,
	messages: ChatMessage[],
	messageIdx: number,
): boolean => {
	if (toolMessage.type !== 'success') {
		return false;
	}

	// Dedup-skipped reads: empty result body + skip marker in content
	if (
		toolMessage.result.totalFileLen === 0
		&& !toolMessage.result.emptyReason
		&& typeof toolMessage.content === 'string'
		&& toolMessage.content.includes('[read_file skipped')
	) {
		return true;
	}

	// Genuine empty files / out-of-range pages should render their explanatory stringifier text
	if (toolMessage.result.emptyReason) {
		return false;
	}

	if (toolMessage.result.totalFileLen !== 0) {
		return false;
	}

	const readKey = uriKey(toolMessage.params.uri);
	for (let i = messageIdx + 1; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === 'user') {
			break;
		}
		if (message.role !== 'tool') {
			continue;
		}
		if (message.type !== 'success' && message.type !== 'running_now') {
			continue;
		}
		if (!('params' in message) || !message.params || !('uri' in message.params)) {
			continue;
		}
		const params = message.params as { uri: URI };
		if (uriKey(params.uri) !== readKey) {
			continue;
		}
		if (isWriteTool(message.name as BuiltinToolName)) {
			return true;
		}
	}
	return false;
};
