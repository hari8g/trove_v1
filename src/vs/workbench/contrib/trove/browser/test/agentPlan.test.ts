/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { completeRemainingPlanItems, markPlanItemDoneForTool, parsePlanBulletItems } from '../agentPlan.js';

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

	test('markPlanItemDoneForTool marks locate then read steps', () => {
		const plan = {
			role: 'plan' as const,
			items: [
				{ text: 'Locate the index.html file', status: 'pending' as const },
				{ text: 'Open index.html to inspect its current structure', status: 'pending' as const },
				{ text: 'Add a small comment at the top of index.html', status: 'pending' as const },
			],
		};
		const uri = URI.file('/workspace/index.html');

		const afterSearch = markPlanItemDoneForTool(plan, 'search_for_files', { query: 'index.html', pageNumber: 1 } as any);
		assert.strictEqual(afterSearch.items[0].status, 'done');
		assert.strictEqual(afterSearch.items[1].status, 'pending');

		const afterRead = markPlanItemDoneForTool(afterSearch, 'read_file', { uri, startLine: 1, endLine: 50, pageNumber: 1 });
		assert.strictEqual(afterRead.items[1].status, 'done');
		assert.strictEqual(afterRead.items[2].status, 'pending');
	});

	test('markPlanItemDoneForTool marks add and save steps on edit', () => {
		const plan = {
			role: 'plan' as const,
			items: [
				{ text: 'Open index.html to inspect its current structure', status: 'done' as const },
				{ text: 'Add a small comment at the top of index.html', status: 'pending' as const },
				{ text: 'Save the updated index.html', status: 'pending' as const },
				{ text: 'Verify the comment appears correctly at the top', status: 'pending' as const },
			],
		};
		const uri = URI.file('/workspace/index.html');

		const afterEdit = markPlanItemDoneForTool(plan, 'edit_file', { uri, search_replace_blocks: '...' } as any);
		assert.strictEqual(afterEdit.items[1].status, 'done');
		assert.strictEqual(afterEdit.items[2].status, 'done');
		assert.strictEqual(afterEdit.items[3].status, 'pending');
	});

	test('completeRemainingPlanItems marks all pending steps done', () => {
		const plan = {
			role: 'plan' as const,
			items: [
				{ text: 'Read file', status: 'done' as const },
				{ text: 'Verify output', status: 'pending' as const },
			],
		};
		const completed = completeRemainingPlanItems(plan);
		assert.strictEqual(completed.items[0].status, 'done');
		assert.strictEqual(completed.items[1].status, 'done');
	});
});
