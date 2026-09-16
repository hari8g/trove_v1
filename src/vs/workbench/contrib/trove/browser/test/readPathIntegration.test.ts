/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import { createBuiltinToolResultStringifiers } from '../../common/toolResultStringifiers.js';
import { shouldSkipDuplicateFileRead, trackFileRead } from '../fileReadDedup.js';
import { compactStaleToolResults } from '../toolResultCompaction.js';

suite('Trove - read path integration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const makeReadSuccess = (uri: URI, content: string, id: string): ChatMessage => ({
		role: 'tool',
		type: 'success',
		name: 'read_file',
		content,
		id,
		rawParams: {},
		mcpServerName: undefined,
		compactable: true,
		params: { uri, startLine: null, endLine: null, pageNumber: 1 },
		result: {
			fileContents: content,
			totalFileLen: content.length,
			totalNumLines: content.split('\n').length,
			hasNextPage: false,
		},
	});

	const makeUser = (text: string): ChatMessage => ({
		role: 'user',
		content: text,
		displayContent: text,
		selections: null,
		state: { stagingSelections: [], isBeingEdited: false },
	});

	// Unskip in T3.2 — compaction currently leaves the dedup record intact.
	test.skip('[pending T3.2] compacting a read_file body clears its dedup range record', () => {
		const uri = URI.file('/proj/foo.ts');
		const fileReads = new Map<string, { count: number; ranges: string[] }>();
		trackFileRead(fileReads, uri, null, null);

		const body = 'export const x = 1;\n'.repeat(50);
		const messages: ChatMessage[] = [
			makeUser('first'),
			makeReadSuccess(uri, body, 't1'),
			makeUser('second'),
			makeUser('third'),
			{
				role: 'tool',
				type: 'success',
				name: 'search_codebase',
				content: 'hit',
				id: 't2',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { query: 'x', maxResults: 5 },
				result: { query: 'x', results: [] },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'search_web',
				content: 'hit',
				id: 't3',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { query: 'x', maxResults: 3 },
				result: { query: 'x', results: [] },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'ls_dir',
				content: 'hit',
				id: 't4',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { uri: URI.file('/proj'), pageNumber: 1 },
				result: { children: null, hasNextPage: false, hasPrevPage: false, itemsRemaining: 0 },
			},
		];

		const compacted = compactStaleToolResults(messages);
		const tool = compacted[1];
		assert.strictEqual(tool.role, 'tool');
		if (tool.role === 'tool') {
			assert.ok(tool.content.includes('re-read if needed'), 'read body should be compacted');
			assert.ok(!tool.content.includes('export const x'), 'original body must be gone');
		}

		const skip = shouldSkipDuplicateFileRead(fileReads, uri, null, null);
		assert.strictEqual(skip.skip, false, 'after compaction clears the dedup record, re-read must not be skipped');
	});

	// Unskip in T3.1 — writes currently leave the dedup record intact.
	test.skip('[pending T3.1] a write to a path clears its dedup range record', () => {
		const uri = URI.file('/proj/foo.ts');
		const fileReads = new Map<string, { count: number; ranges: string[] }>();
		trackFileRead(fileReads, uri, null, null);

		// Desired behaviour (T3.1): invalidateFileRead(fileReads, uri) after edit_file success.
		// Until that API exists, asserting skip===false documents the bug (record still present).
		const afterWrite = shouldSkipDuplicateFileRead(fileReads, uri, null, null);
		assert.strictEqual(afterWrite.skip, false, 'after a write, re-read must not be skipped');
	});

	// Unskip in T3.5 — empty reads currently render as path + empty fenced block.
	test.skip('[pending T3.5] read_file never returns an empty stringified result', () => {
		const stringOfResult = createBuiltinToolResultStringifiers({
			stringifyDirectoryTree: () => 'dir-tree',
			getModelLineContent: (_uri, line) => `line-${line}`,
			formatEditResult: (uri, _lint, edit) => edit.applied ? `edited ${uri.fsPath}` : `EDIT NOT APPLIED to ${uri.fsPath}. Reason: ${edit.failureReason}.`,
			formatCreateSuccess: uri => `created ${uri.fsPath}`,
			formatRunCommandResult: (_params, result) => result.result,
			formatRunPersistentCommandResult: (_params, result) => result.result,
		});

		const out = stringOfResult.read_file(
			{ uri: URI.file('/proj/empty.ts'), startLine: null, endLine: null, pageNumber: 1 },
			{ fileContents: '', totalFileLen: 0, totalNumLines: 0, hasNextPage: false },
		);
		assert.ok(out.trim().length > 0);
		assert.ok(out.includes('(file is empty'), `expected empty-file marker, got: ${out}`);
	});
});
