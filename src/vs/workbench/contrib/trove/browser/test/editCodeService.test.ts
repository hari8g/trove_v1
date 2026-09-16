/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFakeModel, createFakeModelService } from './editCodeServiceHarness.js';

suite('Trove - editCodeService harness', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('fake model applies edits and fake model service records saves', async () => {
		const uri = URI.file('/proj/a.ts');
		const model = createFakeModel('hello world');
		model.applyEdits([{
			range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
			text: 'bye',
		}]);
		assert.strictEqual(model.getValue(), 'bye world');

		const fake = createFakeModelService();
		fake.__setModel(uri, model);
		await fake.saveModel(uri);
		assert.strictEqual(fake.__saveCallCount(), 1);
		assert.strictEqual(fake.__savedContentAtSaveTime()[0], 'bye world');
	});

	test('__setInitializeThrows makes initializeModel reject', async () => {
		const fake = createFakeModelService();
		fake.__setInitializeThrows(new Error('boom'));
		await assert.rejects(() => fake.initializeModel(URI.file('/proj/missing.ts')), /boom/);
	});
});
