/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { diffAreaSnapshotKeys, pickDiffAreaSnapshotFields, VoidFileSnapshot } from './editCodeServiceTypes.js';

suite('Trove - editCodeServiceTypes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pickDiffAreaSnapshotFields captures checkpoint-relevant diff area fields', () => {
		const diffArea = {
			type: 'DiffZone' as const,
			diffareaid: 42,
			originalCode: 'old code',
			startLine: 1,
			endLine: 3,
			editorId: undefined,
			_URI: URI.file('/proj/a.ts'),
			_diffOfId: {},
			_streamState: { isStreaming: false as const },
			_removeStylesFns: new Set<Function>(),
		};

		const snapshotEntry = pickDiffAreaSnapshotFields(diffArea);
		for (const key of diffAreaSnapshotKeys) {
			assert.strictEqual(snapshotEntry[key], diffArea[key], `missing snapshot field ${key}`);
		}
		assert.strictEqual(snapshotEntry.originalCode, 'old code');
	});

	test('VoidFileSnapshot shape stores file code and diff area map', () => {
		const snapshot: VoidFileSnapshot = {
			entireFileCode: 'const x = 1;',
			snapshottedDiffAreaOfId: {
				'1': {
					type: 'DiffZone',
					diffareaid: 1,
					originalCode: 'const x = 1;',
					startLine: 1,
					endLine: 1,
					editorId: undefined,
				},
			},
		};
		assert.strictEqual(snapshot.entireFileCode, 'const x = 1;');
		assert.strictEqual(snapshot.snapshottedDiffAreaOfId['1'].type, 'DiffZone');
	});
});
