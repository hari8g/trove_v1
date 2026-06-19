/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildDeliveryNextStepsMessage } from '../../common/agentDeliveryNextSteps.js';

suite('Trove - agentDeliveryNextSteps', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('mentions Trove Agent terminal and preview URL', () => {
		const message = buildDeliveryNextStepsMessage({
			status: 'verified',
			previewUrl: 'http://localhost:3000',
			previewOpenedInEditor: true,
			updatedAt: new Date().toISOString(),
		});
		assert.ok(message.includes('Trove Agent'));
		assert.ok(message.includes('http://localhost:3000'));
		assert.ok(message.includes('**What to do next**'));
	});

	test('includes pending diff guidance', () => {
		const message = buildDeliveryNextStepsMessage({
			status: 'verified',
			previewUrl: 'http://localhost:3000',
			previewOpenedInEditor: false,
			pendingDiffCount: 3,
			updatedAt: new Date().toISOString(),
		});
		assert.ok(message.includes('3 pending changes'));
	});
});
