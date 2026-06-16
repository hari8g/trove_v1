/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildReadToolBatch,
	isReadOnlyBatchTool,
	parseDiscoveryToolLines,
	toolCallDedupKey,
} from '../parallelReadToolBatch.js';
import { RawToolCallObj } from '../../common/sendLLMMessageTypes.js';

suite('Trove - parallelReadToolBatch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isReadOnlyBatchTool identifies read-only builtins', () => {
		assert.strictEqual(isReadOnlyBatchTool('read_file'), true);
		assert.strictEqual(isReadOnlyBatchTool('search_codebase'), true);
		assert.strictEqual(isReadOnlyBatchTool('edit_file'), false);
		assert.strictEqual(isReadOnlyBatchTool('run_command'), false);
	});

	test('parseDiscoveryToolLines parses JSON lines and stops at DONE', () => {
		const text = [
			'{"name":"read_file","rawParams":{"uri":"src/a.ts"}}',
			'{"name":"search_codebase","rawParams":{"query":"auth flow"}}',
			'DONE',
			'{"name":"read_file","rawParams":{"uri":"src/b.ts"}}',
		].join('\n');

		const parsed = parseDiscoveryToolLines(text);
		assert.strictEqual(parsed.length, 2);
		assert.strictEqual(parsed[0].name, 'read_file');
		assert.strictEqual(parsed[1].name, 'search_codebase');
	});

	test('parseDiscoveryToolLines skips destructive tools', () => {
		const parsed = parseDiscoveryToolLines('{"name":"edit_file","rawParams":{"uri":"x.ts","search_replace_blocks":""}}');
		assert.strictEqual(parsed.length, 0);
	});

	test('buildReadToolBatch deduplicates primary and additional', () => {
		const primary: RawToolCallObj = {
			name: 'read_file',
			rawParams: { uri: 'src/a.ts' },
			doneParams: ['uri'],
			id: '1',
			isDone: true,
		};
		const additional: RawToolCallObj[] = [{
			name: 'read_file',
			rawParams: { uri: 'src/a.ts' },
			doneParams: ['uri'],
			id: '2',
			isDone: true,
		}, {
			name: 'read_file',
			rawParams: { uri: 'src/b.ts' },
			doneParams: ['uri'],
			id: '3',
			isDone: true,
		}];

		const batch = buildReadToolBatch(primary, additional);
		assert.strictEqual(batch.length, 2);
		assert.strictEqual(toolCallDedupKey(batch[0].name, batch[0].rawParams), toolCallDedupKey('read_file', { uri: 'src/a.ts' }));
	});

});
