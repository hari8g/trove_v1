/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { CodebaseSearchResult } from '../common/repoIntelligenceTypes.js';

const MAX_IMPORT_HINTS = 8;
const MAX_QUERY_PARTS = 6;
const MAX_SNIPPET_LINES = 14;
const MAX_RESULTS = 3;

/** Extract module / symbol names from import lines above the cursor. */
export const extractImportHints = (sourceText: string): string[] => {
	const hints = new Set<string>();

	for (const line of sourceText.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
			continue;
		}

		// Python: from foo.bar import Baz
		const pyFrom = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
		if (pyFrom) {
			const moduleTail = pyFrom[1].split('.').pop();
			if (moduleTail) hints.add(moduleTail);
			for (const part of pyFrom[2].split(',')) {
				const name = part.trim().split(/\s+as\s+/)[0].trim();
				if (name && name !== '*') hints.add(name);
			}
		}

		const pyImport = trimmed.match(/^import\s+([\w.]+)/);
		if (pyImport) {
			const tail = pyImport[1].split('.').pop();
			if (tail) hints.add(tail);
		}

		// TypeScript / JavaScript
		if (!trimmed.startsWith('import ')) {
			continue;
		}

		const fromMatch = trimmed.match(/from\s+['"]([^'"]+)['"]/);
		if (fromMatch) {
			const mod = fromMatch[1]
				.replace(/^\.\//, '')
				.split('/')
				.pop()
				?.replace(/\.\w+$/, '');
			if (mod) hints.add(mod);
		}

		const braceMatch = trimmed.match(/import\s+(?:type\s+)?\{([^}]+)\}/);
		if (braceMatch) {
			for (const part of braceMatch[1].split(',')) {
				const name = part.trim().split(/\s+as\s+/)[0].trim();
				if (name) hints.add(name);
			}
		}

		const defaultMatch = trimmed.match(/^import\s+(?:type\s+)?(\w+)\s+from/);
		if (defaultMatch) hints.add(defaultMatch[1]);
	}

	return [...hints].slice(0, MAX_IMPORT_HINTS);
};

export const buildAutocompleteCodebaseQuery = (importHints: string[], symbol: string | null): string => {
	const parts: string[] = [];
	if (symbol && symbol.length >= 2) {
		parts.push(symbol);
	}
	for (const hint of importHints) {
		if (!parts.includes(hint)) {
			parts.push(hint);
		}
	}
	return parts.slice(0, MAX_QUERY_PARTS).join(' ');
};

const commentPrefixForLanguage = (languageId: string): string => {
	if (languageId === 'python' || languageId === 'shellscript' || languageId === 'dockerfile') {
		return '# ';
	}
	if (languageId === 'lua' || languageId === 'sql') {
		return '-- ';
	}
	return '// ';
};

const basename = (filePath: string): string => {
	const normalized = filePath.replace(/\\/g, '/');
	return normalized.split('/').pop() ?? filePath;
};

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');

const isSameFilePath = (currentFilePath: string, resultPath: string): boolean => {
	const current = normalizePath(currentFilePath);
	const result = normalizePath(resultPath);
	if (current === result) return true;
	const currentBase = basename(current);
	return current.endsWith('/' + result) || result.endsWith('/' + currentBase) && basename(result) === currentBase;
};

/** Format FTS hits as a comment block prepended to the FIM prefix. */
export const formatCodebaseContextBlock = (
	results: CodebaseSearchResult[],
	languageId: string,
	currentFilePath?: string,
): string => {
	const filtered = currentFilePath
		? results.filter(r => !isSameFilePath(currentFilePath, r.filePath))
		: results;

	if (filtered.length === 0) {
		return '';
	}

	const comment = commentPrefixForLanguage(languageId);
	const lines: string[] = [`${comment}Related code from codebase:`];

	for (const result of filtered.slice(0, MAX_RESULTS)) {
		const fileLabel = basename(result.filePath);
		lines.push(`${comment}${fileLabel} lines ${result.startLine}-${result.endLine}:`);
		const snippetLines = result.snippet.split('\n').slice(0, MAX_SNIPPET_LINES);
		for (const snippetLine of snippetLines) {
			lines.push(`${comment}${snippetLine}`);
		}
	}

	return lines.join('\n');
};

export const fetchCodebaseContextForAutocomplete = async (opts: {
	model: ITextModel;
	position: Position;
	workspaceRoot: string | null;
	searchCodebase: (workspaceRoot: string, query: string, maxResults?: number) => Promise<CodebaseSearchResult[]>;
	getChunkCount?: (workspaceRoot: string) => Promise<number>;
}): Promise<string> => {
	if (!opts.workspaceRoot) {
		return '';
	}

	try {
		if (opts.getChunkCount) {
			const count = await opts.getChunkCount(opts.workspaceRoot);
			if (count <= 0) {
				return '';
			}
		}

		const fullText = opts.model.getValue(EndOfLinePreference.LF);
		const offset = opts.model.getOffsetAt(opts.position);
		const textToCursor = fullText.substring(0, offset);
		const importHints = extractImportHints(textToCursor);
		const word = opts.model.getWordAtPosition(opts.position);
		const symbol = word?.word ?? null;
		const query = buildAutocompleteCodebaseQuery(importHints, symbol);

		if (!query.trim()) {
			return '';
		}

		const results = await opts.searchCodebase(opts.workspaceRoot, query, MAX_RESULTS + 2);
		return formatCodebaseContextBlock(results, opts.model.getLanguageId(), opts.model.uri.fsPath);
	} catch {
		return '';
	}
};
