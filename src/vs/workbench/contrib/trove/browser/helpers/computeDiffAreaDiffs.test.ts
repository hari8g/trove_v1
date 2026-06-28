/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeDiffAreaDiffs, sliceDiffAreaCodeFromFile } from './computeDiffAreaDiffs.js';

suite('Trove - computeDiffAreaDiffs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sliceDiffAreaCodeFromFile extracts inclusive line range', () => {
		const file = 'line1\nline2\nline3\nline4';
		assert.strictEqual(sliceDiffAreaCodeFromFile(file, 2, 3), 'line2\nline3');
	});

	test('computeDiffAreaDiffs offsets insertion lines into file coordinates', () => {
		const original = 'alpha\nbeta';
		const updated = 'alpha\nbeta\ngamma';
		const diffs = computeDiffAreaDiffs(original, updated, 5);
		const insertion = diffs.find(d => d.type === 'insertion');
		assert.ok(insertion);
		assert.strictEqual(insertion!.startLine, 7);
		assert.strictEqual(insertion!.endLine, 7);
	});

	test('computeDiffAreaDiffs offsets deletion lines into file coordinates', () => {
		const original = 'keep\nremove\nkeep2';
		const updated = 'keep\nkeep2';
		const diffs = computeDiffAreaDiffs(original, updated, 10);
		const deletion = diffs.find(d => d.type === 'deletion');
		assert.ok(deletion);
		assert.strictEqual(deletion!.startLine, 11);
	});
});
