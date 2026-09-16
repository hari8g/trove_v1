/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isRedundantEmptyFileRead } from '../toolResultDisplayUtils.js';
import type { ChatMessage } from '../../common/chatThreadServiceTypes.js';

suite('Trove - toolResultDisplayUtils', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isRedundantEmptyFileRead hides empty read before write on same path', () => {
		const uri = URI.file('/workspace/src/New.tsx');
		const messages: ChatMessage[] = [
			{
				role: 'user',
				displayContent: 'create component',
				content: 'create component',
				selections: null,
				state: { stagingSelections: [], isBeingEdited: false },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				id: 'read-1',
				params: { uri, startLine: null, endLine: null, pageNumber: 1 },
				result: { fileContents: '', totalFileLen: 0, totalNumLines: 0, hasNextPage: false, totalPages: 1 },
				content: '',
				rawParams: {},
				mcpServerName: undefined,
			},
			{
				role: 'tool',
				type: 'success',
				name: 'rewrite_file',
				id: 'write-1',
				params: { uri, newContent: 'export const x = 1;\n' },
				result: {
					lintErrors: null,
					edit: { applied: true, blocksMatched: 1, blocksTotal: 1, savedToDisk: true },
				},
				content: '',
				rawParams: {},
				mcpServerName: undefined,
			},
		];

		const readMessage = messages[1] as Extract<ChatMessage, { role: 'tool'; name: 'read_file' }>;
		assert.strictEqual(isRedundantEmptyFileRead(readMessage, messages, 1), true);
	});

	test('isRedundantEmptyFileRead hides dedup-skipped reads', () => {
		const uri = URI.file('/workspace/src/a.ts');
		const messages: ChatMessage[] = [
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				id: 'read-1',
				params: { uri, startLine: null, endLine: null, pageNumber: 1 },
				result: { fileContents: '', totalFileLen: 0, totalNumLines: 0, hasNextPage: false, totalPages: 1 },
				content: '/workspace/src/a.ts\n```\n[read_file skipped — this exact range was already read in this thread]\n```',
				rawParams: {},
				mcpServerName: undefined,
			},
		];
		const readMessage = messages[0] as Extract<ChatMessage, { role: 'tool'; name: 'read_file' }>;
		assert.strictEqual(isRedundantEmptyFileRead(readMessage, messages, 0), true);
	});

	test('isRedundantEmptyFileRead keeps genuine empty-file explanations', () => {
		const uri = URI.file('/workspace/src/empty.ts');
		const messages: ChatMessage[] = [
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				id: 'read-1',
				params: { uri, startLine: null, endLine: null, pageNumber: 1 },
				result: { fileContents: '', totalFileLen: 0, totalNumLines: 0, hasNextPage: false, emptyReason: 'empty-file', totalPages: 1 },
				content: '/workspace/src/empty.ts\n(file is empty — 0 bytes)',
				rawParams: {},
				mcpServerName: undefined,
			},
		];
		const readMessage = messages[0] as Extract<ChatMessage, { role: 'tool'; name: 'read_file' }>;
		assert.strictEqual(isRedundantEmptyFileRead(readMessage, messages, 0), false);
	});

	test('isRedundantEmptyFileRead keeps non-empty reads', () => {
		const uri = URI.file('/workspace/src/Existing.tsx');
		const messages: ChatMessage[] = [
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				id: 'read-1',
				params: { uri, startLine: null, endLine: null, pageNumber: 1 },
				result: { fileContents: 'hello', totalFileLen: 5, totalNumLines: 1, hasNextPage: false, totalPages: 1 },
				content: '',
				rawParams: {},
				mcpServerName: undefined,
			},
			{
				role: 'tool',
				type: 'success',
				name: 'edit_file',
				id: 'edit-1',
				params: { uri, searchReplaceBlocks: '...' },
				result: {
					lintErrors: null,
					edit: { applied: true, blocksMatched: 1, blocksTotal: 1, savedToDisk: true },
				},
				content: '',
				rawParams: {},
				mcpServerName: undefined,
			},
		];

		const readMessage = messages[0] as Extract<ChatMessage, { role: 'tool'; name: 'read_file' }>;
		assert.strictEqual(isRedundantEmptyFileRead(readMessage, messages, 0), false);
	});
});
