/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CodeChunk, CodeChunkType, FileMetadataEntry } from '../../common/repoIntelligenceTypes.js';

const MAX_FILE_CHARS = 300_000;
const MAX_CHUNK_LINES = 80;
const MIN_NON_EMPTY_LINES = 3;
const MAX_FILES_TO_CHUNK = 5_000;
const MAX_CHUNKS_PER_WORKSPACE = 25_000;
const FALLBACK_FILE_LINES = 120;

const SKIP_LANGUAGES = new Set([
	'Markdown', 'JSON', 'YAML', 'TOML', 'XML', 'HTML', 'CSS', 'SCSS', 'Sass', 'Less',
]);

type BoundaryPattern = { regex: RegExp; chunkType: CodeChunkType };

const LANGUAGE_BOUNDARIES: Record<string, BoundaryPattern[]> = {
	TypeScript: [
		{ regex: /^(?:export\s+)?(?:async\s+)?function\s+\w/m, chunkType: 'function' },
		{ regex: /^(?:export\s+)?class\s+\w/m, chunkType: 'class' },
		{ regex: /^(?:export\s+)?interface\s+\w/m, chunkType: 'block' },
		{ regex: /^(?:export\s+)?type\s+\w/m, chunkType: 'block' },
		{ regex: /^export\s+default\s+/m, chunkType: 'block' },
	],
	JavaScript: [
		{ regex: /^(?:export\s+)?(?:async\s+)?function\s+\w/m, chunkType: 'function' },
		{ regex: /^(?:export\s+)?class\s+\w/m, chunkType: 'class' },
		{ regex: /^export\s+default\s+/m, chunkType: 'block' },
	],
	Python: [
		{ regex: /^def\s+\w/m, chunkType: 'function' },
		{ regex: /^class\s+\w/m, chunkType: 'class' },
	],
	Go: [
		{ regex: /^func\s+/m, chunkType: 'function' },
	],
	Rust: [
		{ regex: /^(?:pub\s+)?fn\s+\w/m, chunkType: 'function' },
		{ regex: /^(?:pub\s+)?impl\b/m, chunkType: 'class' },
		{ regex: /^(?:pub\s+)?struct\s+\w/m, chunkType: 'class' },
	],
	Java: [
		{ regex: /^(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)+?\w+\s*\([^)]*\)\s*\{/m, chunkType: 'function' },
		{ regex: /^(?:public|private|protected)?\s*class\s+\w/m, chunkType: 'class' },
	],
	'C#': [
		{ regex: /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:\w+\s+)+?\w+\s*\([^)]*\)\s*\{/m, chunkType: 'function' },
		{ regex: /^(?:public|private|protected|internal)?\s*class\s+\w/m, chunkType: 'class' },
	],
};

const countNonEmptyLines = (text: string): number => {
	return text.split('\n').filter(line => line.trim().length > 0).length;
};

const makeChunkId = (workspaceHash: string, filePath: string, startLine: number): string => {
	return createHash('sha256').update(`${workspaceHash}:${filePath}:${startLine}`).digest('hex').slice(0, 32);
};

const findBoundaryLines = (content: string, patterns: BoundaryPattern[]): { line: number; chunkType: CodeChunkType }[] => {
	const lines = content.split('\n');
	const boundaries: { line: number; chunkType: CodeChunkType }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const pattern of patterns) {
			if (pattern.regex.test(line)) {
				boundaries.push({ line: i + 1, chunkType: pattern.chunkType });
				break;
			}
		}
	}
	return boundaries;
};

const splitAtBlankLines = (lines: string[], startIdx: number, endIdx: number, maxLines: number): { start: number; end: number }[] => {
	const spans: { start: number; end: number }[] = [];
	let spanStart = startIdx;
	while (spanStart <= endIdx) {
		let spanEnd = Math.min(spanStart + maxLines - 1, endIdx);
		if (spanEnd < endIdx) {
			for (let i = spanEnd; i > spanStart + MIN_NON_EMPTY_LINES; i--) {
				if (lines[i - 1].trim() === '') {
					spanEnd = i - 1;
					break;
				}
			}
		}
		spans.push({ start: spanStart, end: spanEnd });
		spanStart = spanEnd + 1;
	}
	return spans;
};

export const chunkFile = (
	workspaceHash: string,
	filePath: string,
	content: string,
	language: string | null,
): CodeChunk[] => {
	if (!language || SKIP_LANGUAGES.has(language)) return [];
	if (content.length > MAX_FILE_CHARS) return [];

	const lines = content.split('\n');
	const patterns = LANGUAGE_BOUNDARIES[language] ?? [];
	const boundaries = findBoundaryLines(content, patterns);

	const spans: { start: number; end: number; chunkType: CodeChunkType }[] = [];

	if (boundaries.length === 0) {
		const endLine = Math.min(lines.length, FALLBACK_FILE_LINES);
		spans.push({ start: 1, end: endLine, chunkType: 'file' });
	} else {
		for (let i = 0; i < boundaries.length; i++) {
			const startLine = boundaries[i].line;
			const endLine = i + 1 < boundaries.length ? boundaries[i + 1].line - 1 : lines.length;
			const chunkType = boundaries[i].chunkType;
			if (endLine - startLine + 1 > MAX_CHUNK_LINES) {
				for (const sub of splitAtBlankLines(lines, startLine - 1, endLine - 1, MAX_CHUNK_LINES)) {
					spans.push({ start: sub.start + 1, end: sub.end + 1, chunkType });
				}
			} else {
				spans.push({ start: startLine, end: endLine, chunkType });
			}
		}
	}

	const chunks: CodeChunk[] = [];
	for (const span of spans) {
		const chunkText = lines.slice(span.start - 1, span.end).join('\n');
		if (countNonEmptyLines(chunkText) < MIN_NON_EMPTY_LINES) continue;
		chunks.push({
			id: makeChunkId(workspaceHash, filePath, span.start),
			filePath,
			chunkText,
			startLine: span.start,
			endLine: span.end,
			chunkType: span.chunkType,
		});
	}
	return chunks;
};

export const buildChunksForWorkspace = (
	workspaceRoot: string,
	workspaceHash: string,
	fileMeta: FileMetadataEntry[],
): CodeChunk[] => {
	const chunks: CodeChunk[] = [];
	let filesProcessed = 0;

	const indexable = fileMeta.filter(f => f.language && !SKIP_LANGUAGES.has(f.language));

	for (const file of indexable) {
		if (filesProcessed >= MAX_FILES_TO_CHUNK || chunks.length >= MAX_CHUNKS_PER_WORKSPACE) break;
		filesProcessed += 1;

		let content: string;
		try {
			content = readFileSync(join(workspaceRoot, file.filePath), 'utf8');
		} catch {
			continue;
		}

		const fileChunks = chunkFile(workspaceHash, file.filePath, content, file.language);
		for (const c of fileChunks) {
			if (chunks.length >= MAX_CHUNKS_PER_WORKSPACE) break;
			chunks.push(c);
		}
	}

	return chunks;
};
