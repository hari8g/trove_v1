/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js';

export type FileReadRecord = {
	count: number;
	ranges: string[];
	totalFileLen?: number;
};

export const readFileUriKey = (uri: URI | string): string => {
	if (uri instanceof URI) {
		return uri.fsPath.toLowerCase();
	}
	return String(uri).toLowerCase();
};

export const formatReadFileRange = (startLine: number | null | undefined, endLine: number | null | undefined): string => {
	if (startLine == null && endLine == null) {
		return 'full file';
	}
	const start = startLine ?? 1;
	const end = endLine == null ? 'end' : String(endLine);
	return `lines ${start}-${end}`;
};

export const extractReadFileUriFromRawParams = (rawParams: RawToolParamsObj): string | undefined => {
	const uri = rawParams.uri;
	if (!uri) {
		return undefined;
	}
	if (typeof uri === 'string') {
		return readFileUriKey(uri);
	}
	if (typeof uri === 'object' && uri !== null && 'fsPath' in uri && typeof (uri as { fsPath?: string }).fsPath === 'string') {
		return readFileUriKey((uri as { fsPath: string }).fsPath);
	}
	return undefined;
};

export const trackFileRead = (
	fileReads: Map<string, FileReadRecord>,
	uri: URI | string,
	startLine: number | null | undefined,
	endLine: number | null | undefined,
	totalFileLen?: number,
): void => {
	const key = readFileUriKey(uri);
	const range = formatReadFileRange(startLine, endLine);
	const prev = fileReads.get(key) ?? { count: 0, ranges: [] };
	prev.count += 1;
	if (!prev.ranges.includes(range)) {
		prev.ranges.push(range);
	}
	if (totalFileLen != null && totalFileLen > 0) {
		prev.totalFileLen = Math.max(prev.totalFileLen ?? 0, totalFileLen);
	}
	fileReads.set(key, prev);
};

export const recordFileReadSize = (
	fileReads: Map<string, FileReadRecord>,
	uri: URI | string,
	totalFileLen: number,
): void => {
	if (!totalFileLen || totalFileLen <= 0) {
		return;
	}
	const key = readFileUriKey(uri);
	const prev = fileReads.get(key);
	if (!prev) {
		return;
	}
	prev.totalFileLen = Math.max(prev.totalFileLen ?? 0, totalFileLen);
	fileReads.set(key, prev);
};

export const shouldSkipDuplicateFileRead = (
	fileReads: Map<string, FileReadRecord>,
	uri: URI,
	startLine: number | null,
	endLine: number | null,
): { skip: boolean; message?: string } => {
	const key = readFileUriKey(uri);
	const record = fileReads.get(key);
	if (!record || record.count < 1) {
		return { skip: false };
	}

	const path = uri.fsPath;
	const requested = formatReadFileRange(startLine, endLine);
	const prior = record.ranges.join(', ');
	return {
		skip: true,
		message: [
			`${path}`,
			'```',
			`[read_file skipped — file-level dedup]`,
			`This file was already read this agent run (${prior}).`,
			`Use the content already in the conversation above to edit or answer.`,
			`Requested again: ${requested}.`,
			`If you need another section, read one wider range in a single call instead of multiple partial reads.`,
			'```',
		].join('\n'),
	};
};

export const buildRepeatFileReadHint = (fileReads: Map<string, FileReadRecord>): string => {
	const repeated = [...fileReads.entries()].filter(([, record]) => record.count >= 2);
	if (repeated.length === 0) {
		return '';
	}
	const files = repeated.map(([key]) => key.split(/[/\\]/).pop() ?? key).join(', ');
	return `\n\n<agent_hints>
You already read the same file(s) more than once this run (${files}). Use prior read results in the thread — do not call read_file again on paths you already have. Edit or answer with existing context.
</agent_hints>`;
};
