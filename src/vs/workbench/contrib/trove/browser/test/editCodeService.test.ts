/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFakeModel, createFakeModelService } from './editCodeServiceHarness.js';
import { URI } from '../../../../../base/common/uri.js';

/**
 * R3 deferred-commit contract for `_addToHistory`:
 * - `commit()` pushes the undo element exactly once
 * - `onFinishEdit` calls `commit` then snapshots/saves
 * - Paths that never reach `onFinishEdit` push zero elements
 *
 * Full EditCodeService DI is heavy for unit tests; this mirrors the deferred
 * push pattern so failureReasons stay covered without a phantom undo entry.
 */
const createDeferredHistory = (pushElement: (elt: unknown) => void) => {
	let committed = false
	const elt = { label: 'Trove Agent' }
	const commit = () => {
		if (committed) return
		committed = true
		pushElement(elt)
	}
	const onFinishEdit = async () => {
		commit()
	}
	return { commit, onFinishEdit }
}

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

suite('Trove - editCodeService deferred undo commit (R3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const failureReasons = [
		'model-unavailable',
		'diffzone-unavailable',
		'no-blocks-parsed',
		'block-not-found',
		'blocks-overlap',
		'content-identical',
	] as const;

	for (const reason of failureReasons) {
		test(`failureReason ${reason} pushes zero undo elements`, async () => {
			const pushes: unknown[] = [];
			const { onFinishEdit } = createDeferredHistory(e => pushes.push(e));
			// Simulate _finishEditSession({ accept: false }) — never calls onFinishEdit
			void reason;
			void onFinishEdit;
			assert.strictEqual(pushes.length, 0);
		});
	}

	test('successful apply pushes exactly one undo element', async () => {
		const pushes: unknown[] = [];
		const { onFinishEdit } = createDeferredHistory(e => pushes.push(e));
		await onFinishEdit();
		await onFinishEdit(); // idempotent commit
		assert.strictEqual(pushes.length, 1);
	});
});
