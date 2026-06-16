/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parsePlanBulletItems } from '../agentPlan.js';

suite('Trove - agentPlan', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parsePlanBulletItems parses dash and numbered lists', () => {
		const text = [
			'- Read Sidebar.tsx',
			'* Create Spinner component',
			'1. Wire into Sidebar.tsx',
		].join('\n');
		const items = parsePlanBulletItems(text);
		assert.strictEqual(items.length, 3);
		assert.strictEqual(items[0].text, 'Read Sidebar.tsx');
		assert.strictEqual(items[0].status, 'pending');
	});
});
