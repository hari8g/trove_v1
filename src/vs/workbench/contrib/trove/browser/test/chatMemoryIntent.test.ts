/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Bosch Mobility and Platform Solutions Private Limited. All rights reserved.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractRememberIntent, isRememberOnlyMessage } from '../chatMemoryIntent.js';

suite('Trove - chatMemoryIntent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('extractRememberIntent parses please remember that', () => {
		const fact = extractRememberIntent('Please remember that this project uses PostgreSQL version 15 as its primary database.');
		assert.strictEqual(fact, 'this project uses PostgreSQL version 15 as its primary database');
	});

	test('extractRememberIntent parses save to memory', () => {
		const fact = extractRememberIntent('Save to memory: API runs on port 3000');
		assert.strictEqual(fact, 'API runs on port 3000');
	});

	test('isRememberOnlyMessage is true for pure remember requests', () => {
		assert.strictEqual(isRememberOnlyMessage('Remember that we use pnpm.'), true);
	});

	test('isRememberOnlyMessage is false when remember is part of a larger task', () => {
		assert.strictEqual(
			isRememberOnlyMessage('Remember that we use pnpm, then fix the login bug in auth.ts'),
			false,
		);
	});

	test('extractRememberIntent returns null for unrelated messages', () => {
		assert.strictEqual(extractRememberIntent('Fix the login bug'), null);
	});
});
