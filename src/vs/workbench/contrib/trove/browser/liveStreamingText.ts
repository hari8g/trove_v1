/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RawToolCallObj } from '../common/sendLLMMessageTypes.js';
import { BuiltinToolName } from '../common/toolsServiceTypes.js';
import { isABuiltinToolName } from '../common/prompt/prompts.js';

/** Last N lines of streaming text for live previews (status bar + activity panel). */
export const getStreamingTailPreview = (
	text: string | null | undefined,
	opts?: { maxLines?: number; maxChars?: number },
): string => {
	const trimmed = text?.trim();
	if (!trimmed) return '';
	const maxLines = opts?.maxLines ?? 3;
	const maxChars = opts?.maxChars ?? 280;
	const lines = trimmed.split('\n').filter(l => l.trim());
	const tail = lines.slice(-maxLines).join('\n');
	if (tail.length <= maxChars) return tail;
	return `…${tail.slice(-maxChars + 1)}`;
};

/** Pull a short "what happens next" line from partial assistant text. */
export const extractStreamingIntentLine = (text: string | null | undefined): string | undefined => {
	const trimmed = text?.trim();
	if (!trimmed) return undefined;
	const intentPatterns = [
		/(?:I'll|I will|Next,? I'll|Now I'll|Let me)\s+(.+?)(?:\.\s|\.$|$)/i,
		/(?:I'm going to|I am going to)\s+(.+?)(?:\.\s|\.$|$)/i,
		/(?:Next(?:,|:)?\s+)(.+?)(?:\.\s|\.$|$)/i,
	];
	for (const pattern of intentPatterns) {
		const match = trimmed.match(pattern);
		const captured = match?.[1]?.trim();
		if (captured && captured.length >= 8) {
			return captured.length > 120 ? `${captured.slice(0, 117)}…` : captured;
		}
	}
	const lastSentence = trimmed.split(/(?<=[.!?])\s+/).pop()?.trim();
	if (lastSentence && lastSentence.length >= 12 && lastSentence.length <= 160) {
		return lastSentence;
	}
	return undefined;
};

const basenameFromPath = (path: string): string => {
	const normalized = path.replace(/\\/g, '/');
	return normalized.split('/').pop() ?? path;
};

const BUILTIN_TOOL_STREAM_LABELS: Partial<Record<BuiltinToolName, string>> = {
	read_file: 'Reading file',
	ls_dir: 'Inspecting folder',
	get_dir_tree: 'Inspecting folder tree',
	search_pathnames_only: 'Searching by file name',
	search_for_files: 'Searching files',
	search_codebase: 'Searching codebase',
	search_web: 'Searching the web',
	search_in_file: 'Searching in file',
	create_file_or_folder: 'Creating path',
	delete_file_or_folder: 'Deleting path',
	edit_file: 'Preparing edit',
	rewrite_file: 'Writing file',
	run_command: 'Preparing command',
	run_persistent_command: 'Preparing command',
	open_persistent_terminal: 'Opening terminal',
	kill_persistent_terminal: 'Closing terminal',
	read_lint_errors: 'Reading lint errors',
};

export const getStreamingToolCallStatusLine = (toolCallSoFar: RawToolCallObj): string => {
	const label = isABuiltinToolName(toolCallSoFar.name)
		? (BUILTIN_TOOL_STREAM_LABELS[toolCallSoFar.name] ?? toolCallSoFar.name)
		: toolCallSoFar.name;
	const uri = toolCallSoFar.rawParams.uri?.trim();
	const command = toolCallSoFar.rawParams.command?.trim();
	const query = toolCallSoFar.rawParams.query?.trim() ?? toolCallSoFar.rawParams.query_regex?.trim();
	if (uri) {
		return `${label} · ${basenameFromPath(uri)}`;
	}
	if (command) {
		const preview = command.length > 72 ? `${command.slice(0, 69)}…` : command;
		return `${label} · ${preview}`;
	}
	if (query) {
		const preview = query.length > 72 ? `${query.slice(0, 69)}…` : query;
		return `${label} · ${preview}`;
	}
	return `${label}…`;
};
