/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getAcceptRejectWidgetPlacement } from '../helpers/getAcceptRejectWidgetPlacement.js';

suite('Trove - getAcceptRejectWidgetPlacement', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('insertion anchors at diff start line', () => {
		const placement = getAcceptRejectWidgetPlacement({
			type: 'insertion',
			diffid: 1,
			diffareaid: 1,
			startLine: 5,
			endLine: 7,
			originalStartLine: 5,
			code: 'new',
		});
		assert.deepStrictEqual(placement, { startLine: 5, offsetLines: 0 });
	});

	test('deletion at line 1 offsets upward by removed line count', () => {
		const placement = getAcceptRejectWidgetPlacement({
			type: 'deletion',
			diffid: 2,
			diffareaid: 1,
			startLine: 1,
			originalStartLine: 1,
			originalEndLine: 3,
			originalCode: 'a\nb\nc',
		});
		assert.deepStrictEqual(placement, { startLine: 1, offsetLines: -3 });
	});

	test('deletion after line 1 anchors on previous line', () => {
		const placement = getAcceptRejectWidgetPlacement({
			type: 'deletion',
			diffid: 3,
			diffareaid: 1,
			startLine: 4,
			originalStartLine: 4,
			originalEndLine: 5,
			originalCode: 'x\ny',
		});
		assert.deepStrictEqual(placement, { startLine: 3, offsetLines: 1 });
	});
});
