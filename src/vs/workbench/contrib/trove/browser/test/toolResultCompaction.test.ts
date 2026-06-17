/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import { compactStaleToolResults, isCompactableToolName } from '../toolResultCompaction.js';

suite('Trove - toolResultCompaction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isCompactableToolName identifies read and search tools', () => {
		assert.strictEqual(isCompactableToolName('read_file'), true);
		assert.strictEqual(isCompactableToolName('search_codebase'), true);
		assert.strictEqual(isCompactableToolName('edit_file'), false);
	});

	test('compactStaleToolResults compacts old read_file results', () => {
		const fileUri = URI.file('/proj/foo.ts');
		const messages: ChatMessage[] = [
			{
				role: 'user',
				content: 'first',
				displayContent: 'first',
				selections: null,
				state: { stagingSelections: [], isBeingEdited: false },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				content: 'line1\nline2\nline3',
				id: 't1',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { uri: fileUri, startLine: 1, endLine: 3, pageNumber: 1 },
				result: { fileContents: 'line1\nline2\nline3', totalFileLen: 18, totalNumLines: 3, hasNextPage: false },
			},
			{
				role: 'user',
				content: 'second',
				displayContent: 'second',
				selections: null,
				state: { stagingSelections: [], isBeingEdited: false },
			},
			{
				role: 'user',
				content: 'third',
				displayContent: 'third',
				selections: null,
				state: { stagingSelections: [], isBeingEdited: false },
			},
		];

		const compacted = compactStaleToolResults(messages);
		const tool = compacted[1];
		assert.strictEqual(tool.role, 'tool');
		if (tool.role === 'tool') {
			assert.ok(tool.content.includes('read_file('));
			assert.ok(tool.content.includes('re-read if needed'));
			assert.ok(!tool.content.includes('line1'));
		}
	});
});
