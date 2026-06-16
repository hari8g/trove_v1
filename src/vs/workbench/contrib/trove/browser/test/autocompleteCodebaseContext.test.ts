/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildAutocompleteCodebaseQuery,
	extractImportHints,
	formatCodebaseContextBlock,
} from '../autocompleteCodebaseContext.js';

suite('Trove - autocompleteCodebaseContext', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('extractImportHints parses TypeScript imports', () => {
		const source = [
			"import { formatCurrency, parseAmount } from './utils/currency';",
			"import Disposable from '../base/disposable';",
			'const x = 1;',
		].join('\n');

		const hints = extractImportHints(source);
		assert.ok(hints.includes('formatCurrency'));
		assert.ok(hints.includes('parseAmount'));
		assert.ok(hints.includes('currency'));
		assert.ok(hints.includes('Disposable'));
	});

	test('extractImportHints parses Python imports', () => {
		const source = [
			'from auth.service import authenticate_user',
			'import json',
		].join('\n');

		const hints = extractImportHints(source);
		assert.ok(hints.includes('authenticate_user'));
		assert.ok(hints.includes('service'));
		assert.ok(hints.includes('json'));
	});

	test('buildAutocompleteCodebaseQuery prioritizes symbol under cursor', () => {
		const query = buildAutocompleteCodebaseQuery(['currency', 'formatCurrency'], 'formatC');
		assert.ok(query.startsWith('formatC'));
		assert.ok(query.includes('currency'));
	});

	test('formatCodebaseContextBlock emits comment-prefixed snippets', () => {
		const block = formatCodebaseContextBlock([{
			filePath: 'src/utils/currency.ts',
			startLine: 12,
			endLine: 28,
			snippet: 'export function formatCurrency(amount: number): string {\n  return String(amount);\n}',
			score: 1,
		}], 'typescript', '/workspace/src/app.ts');

		assert.ok(block.includes('// Related code from codebase:'));
		assert.ok(block.includes('// currency.ts lines 12-28:'));
		assert.ok(block.includes('// export function formatCurrency'));
	});

	test('formatCodebaseContextBlock excludes current file', () => {
		const block = formatCodebaseContextBlock([{
			filePath: 'src/app.ts',
			startLine: 1,
			endLine: 5,
			snippet: 'const local = 1;',
			score: 1,
		}], 'typescript', '/workspace/src/app.ts');

		assert.strictEqual(block, '');
	});

	test('formatCodebaseContextBlock uses hash comments for Python', () => {
		const block = formatCodebaseContextBlock([{
			filePath: 'auth.py',
			startLine: 1,
			endLine: 3,
			snippet: 'def login(): pass',
			score: 1,
		}], 'python');

		assert.ok(block.startsWith('# Related code from codebase:'));
		assert.ok(block.includes('# def login(): pass'));
	});
});
