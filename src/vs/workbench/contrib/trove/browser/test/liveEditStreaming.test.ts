/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseStreamingEditProgress } from '../liveEditStreaming.js';

suite('Trove - liveEditStreaming', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseStreamingEditProgress counts complete and partial blocks', () => {
		const partial = parseStreamingEditProgress(`<<<<<<< SEARCH
old line
=======`, true);
		assert.strictEqual(partial.completeBlockCount, 0);
		assert.strictEqual(partial.hasPartialBlock, true);
		assert.strictEqual(partial.blocks.length, 1);

		const complete = parseStreamingEditProgress(`<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE`, true);
		assert.strictEqual(complete.completeBlockCount, 1);
		assert.strictEqual(complete.hasPartialBlock, false);
	});
});
