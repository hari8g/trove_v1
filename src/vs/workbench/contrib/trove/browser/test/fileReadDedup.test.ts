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
		assert.ok(covered.message?.includes('range already read'));
		assert.ok(covered.message?.includes('lines 1-120'));
	});

	test('trackReadOnlyCall tracks file-level reads across ranges', () => {
		const counts = createReadOnlyCallCounts();
		trackReadOnlyCall(counts, 'read_file', { uri: '/proj/clock.js', startLine: '1', endLine: '120' });
		trackReadOnlyCall(counts, 'read_file', { uri: '/proj/clock.js', startLine: '270', endLine: '380' });
		assert.strictEqual(counts.fileReads.get('/proj/clock.js')?.count, 2);
		assert.deepStrictEqual(counts.fileReads.get('/proj/clock.js')?.ranges, [
			formatReadFileRange(1, 120),
			formatReadFileRange(270, 380),
		]);
		const hint = buildRepeatFileReadHint(counts.fileReads);
		assert.ok(hint.includes('clock.js'));
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
