/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EDIT_DIAGNOSTICS_PREFIX, summarizeEditToolCall } from '../agentEditDiagnostics.js';

suite('Trove - agentEditDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('summarizeEditToolCall reports param lengths without content', () => {
		const summary = summarizeEditToolCall({
			id: 't1',
			name: 'edit_file',
			isDone: false,
			doneParams: ['uri'],
			rawParams: { uri: '/tmp/style.css', search_replace_blocks: '<<<<<<< SEARCH\n' },
		});
		assert.strictEqual(summary.toolName, 'edit_file');
		assert.strictEqual(summary.uriLen, '/tmp/style.css'.length);
		assert.strictEqual(summary.search_replace_blocksLen, '<<<<<<< SEARCH\n'.length);
	});

	test('diagnostics prefix is filterable in DevTools', () => {
		assert.ok(EDIT_DIAGNOSTICS_PREFIX.includes('Trove edit'));
	});
});
