/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findTextInCode } from './findTextInCode.js';

suite('Trove - findTextInCode', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const file = [
		'const x = 1;',
		'const y = 2;',
		'const x = 1;',
	].join('\n');

	test('finds exact match and returns 1-indexed line range', () => {
		const result = findTextInCode('const y = 2;', file, false, { returnType: 'lines' });
		assert.deepStrictEqual(result, [2, 2]);
	});

	test('returns Not found when text is absent', () => {
		const result = findTextInCode('missing', file, false, { returnType: 'lines' });
		assert.strictEqual(result, 'Not found');
	});

	test('returns Not unique when whitespace-normalized match is ambiguous', () => {
		const result = findTextInCode('const x=1;', file, true, { returnType: 'lines' });
		assert.strictEqual(result, 'Not unique');
	});

	test('respects startingAtLine when searching', () => {
		const result = findTextInCode('const x = 1;', file, false, { startingAtLine: 2, returnType: 'lines' });
		assert.deepStrictEqual(result, [3, 3]);
	});
});
