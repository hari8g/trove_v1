/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildRepeatEditHint, trackFileEdit } from '../agentEditHints.js';

suite('Trove - agentEditHints', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildRepeatEditHint is empty until threshold', () => {
		const counts = new Map<string, number>();
		assert.strictEqual(buildRepeatEditHint(counts), '');
		trackFileEdit(counts, 'edit_file', { uri: URI.file('/proj/style.css') });
		assert.strictEqual(buildRepeatEditHint(counts), '');
		trackFileEdit(counts, 'edit_file', { uri: URI.file('/proj/style.css') });
		const hint = buildRepeatEditHint(counts);
		assert.ok(hint.includes('style.css'));
		assert.ok(hint.includes('single edit_file'));
	});
});
