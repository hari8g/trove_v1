/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractStreamingIntentLine, getStreamingTailPreview } from '../liveStreamingText.js';

suite('Trove - live streaming UI helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('getStreamingTailPreview returns last lines', () => {
		const text = 'line1\nline2\nline3\nline4';
		assert.strictEqual(getStreamingTailPreview(text, { maxLines: 2 }), 'line3\nline4');
	});

	test('extractStreamingIntentLine captures next-step phrasing', () => {
		const text = 'Now I have context. I\'ll update style.css with the Nike neon palette.';
		assert.strictEqual(
			extractStreamingIntentLine(text),
			'update style.css with the Nike neon palette',
		);
	});
});
