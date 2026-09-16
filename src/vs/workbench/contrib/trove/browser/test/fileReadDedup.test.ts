/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildRepeatFileReadHint,
	formatReadFileRange,
	readFileUriKey,
	shouldSkipDuplicateFileRead,
	trackFileRead,
} from '../fileReadDedup.js';
import { createReadOnlyCallCounts, trackReadOnlyCall } from '../agentReadHints.js';
import {
	getEffectiveMaxReadOnlyCalls,
	getEffectiveRepoProfileMode,
	isLightAgentEnabled,
	shouldGenerateAgentPlan,
	shouldUseParallelReadBatching,
} from '../../common/lightAgent.js';
import { defaultGlobalSettings } from '../../common/troveSettingsTypes.js';

suite('Trove - fileReadDedup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shouldSkipDuplicateFileRead skips only when range is fully covered', () => {
		const fileReads = new Map<string, { count: number; ranges: string[] }>();
		const uri = URI.file('/proj/clock.js');
		trackFileRead(fileReads, uri, 1, 120);
		const uncovered = shouldSkipDuplicateFileRead(fileReads, uri, 270, 380);
		assert.strictEqual(uncovered.skip, false);

		const covered = shouldSkipDuplicateFileRead(fileReads, uri, 50, 100);
		assert.strictEqual(covered.skip, true);
		assert.ok(covered.message?.includes('already read'));
		assert.ok(covered.message?.includes('lines 1-120'));
	});

	test('trackFileRead stamps lastReadTurn when turn is provided', () => {
		const fileReads = new Map<string, { count: number; ranges: string[]; lastReadTurn?: number }>();
		const uri = URI.file('/proj/foo.ts');
		trackFileRead(fileReads, uri, null, null, undefined, 3);
		assert.strictEqual(fileReads.get(readFileUriKey(uri))?.lastReadTurn, 3);
	});

	test('trackReadOnlyCall passes userTurn to file read records', () => {
		const counts = createReadOnlyCallCounts();
		trackReadOnlyCall(counts, 'read_file', { uri: '/proj/foo.ts' }, 5);
		assert.strictEqual(counts.fileReads.get(readFileUriKey('/proj/foo.ts'))?.lastReadTurn, 5);
	});

	test('trackFileRead stamps lastReadTurn when provided', () => {
		const fileReads = new Map<string, { count: number; ranges: string[]; lastReadTurn?: number }>();
		const uri = URI.file('/proj/a.ts');
		trackFileRead(fileReads, uri, null, null, undefined, 3);
		assert.strictEqual(fileReads.get(readFileUriKey(uri))?.lastReadTurn, 3);
	});

	test('eviction window keeps only last 2 user turns', () => {
		const fileReads = new Map<string, { count: number; ranges: string[]; lastReadTurn?: number }>();
		const uri1 = URI.file('/proj/old.ts');
		const uri2 = URI.file('/proj/recent.ts');
		trackFileRead(fileReads, uri1, null, null, undefined, 1);
		trackFileRead(fileReads, uri2, null, null, undefined, 3);
		const currentTurn = 4;
		const kept = new Map<string, { count: number; ranges: string[]; lastReadTurn?: number }>();
		for (const [key, record] of fileReads) {
			const lastTurn = record.lastReadTurn ?? currentTurn;
			if (currentTurn - lastTurn > 2) continue;
			kept.set(key, record);
		}
		assert.strictEqual(kept.has(readFileUriKey(uri1)), false);
		assert.strictEqual(kept.has(readFileUriKey(uri2)), true);
	});
});

suite('Trove - lightAgent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('light agent disables plan and parallel batching', () => {
		const settings = { ...defaultGlobalSettings, enableLightAgent: true, enableAgentPlan: true, enableParallelReadBatching: true };
		assert.strictEqual(isLightAgentEnabled(settings), true);
		assert.strictEqual(shouldGenerateAgentPlan(settings), false);
		assert.strictEqual(shouldUseParallelReadBatching(settings), false);
	});

	test('light agent caps read-only calls and shrinks repo profile mode', () => {
		const settings = { ...defaultGlobalSettings, enableLightAgent: true, maxReadOnlyCalls: 12 };
		assert.strictEqual(getEffectiveMaxReadOnlyCalls(settings), 6);
		assert.strictEqual(getEffectiveRepoProfileMode('agent', settings), 'normal');
	});
});
