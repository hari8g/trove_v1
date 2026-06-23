/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { STORAGE_KEY_METERING_SESSION } from '../../common/storageKeys.js';
import { UsageMeteringService } from '../usageMeteringService.js';

function withMeteringService(run: (service: UsageMeteringService, storage: InMemoryStorageService, ds: DisposableStore) => void): void {
	const ds = new DisposableStore();
	try {
		const storage = ds.add(new InMemoryStorageService());
		const service = ds.add(new UsageMeteringService(storage));
		run(service, storage, ds);
	} finally {
		ds.dispose();
	}
}

suite('Trove - usageMeteringService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recordTurn accumulates cache write tokens', () => {
		withMeteringService((service) => {
			service.recordTurn({
				usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 200 },
				providerName: 'anthropic',
				modelName: 'claude-sonnet-4-6',
				threadId: 'thread-1',
			});

			const session = service.getSession();
			assert.strictEqual(session.totalCacheReadTokens, 500);
			assert.strictEqual(session.totalCacheWriteTokens, 200);
		});
	});

	test('recordTurn accumulates session and provider totals', () => {
		withMeteringService((service) => {
			service.recordTurn({
				usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
				providerName: 'anthropic',
				modelName: 'claude-sonnet-4-6',
				threadId: 'thread-1',
			});

			const session = service.getSession();
			assert.strictEqual(session.totalTurns, 1);
			assert.ok(session.totalCostUSD > 0);
			assert.strictEqual(session.byProvider.anthropic?.turns, 1);
			assert.strictEqual(session.byThread['thread-1']?.turns, 1);
		});
	});

	test('session persists across service reload', () => {
		withMeteringService((service, storage, ds) => {
			service.recordTurn({
				usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0 },
				providerName: 'anthropic',
				modelName: 'claude-sonnet-4-6',
				threadId: 'thread-1',
			});

			const reloaded = ds.add(new UsageMeteringService(storage));
			assert.strictEqual(reloaded.getSession().totalTurns, 1);
		});
	});

	test('dailyUSD accumulates for today', () => {
		withMeteringService((service) => {
			service.recordTurn({
				usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
				providerName: 'anthropic',
				modelName: 'claude-sonnet-4-6',
				threadId: 'thread-1',
			});
			service.recordTurn({
				usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
				providerName: 'anthropic',
				modelName: 'claude-sonnet-4-6',
				threadId: 'thread-1',
			});

			const today = new Date().toISOString().slice(0, 10);
			const session = service.getSession();
			assert.ok((session.dailyUSD[today] ?? 0) > 0);
			assert.strictEqual(service.getTodayCostUSD(), session.dailyUSD[today]);
		});
	});

	test('budget get/set/clear', () => {
		withMeteringService((service) => {
			assert.strictEqual(service.getBudgetLimitUSD(), null);
			service.setBudgetLimitUSD(5);
			assert.strictEqual(service.getBudgetLimitUSD(), 5);
			service.setBudgetLimitUSD(null);
			assert.strictEqual(service.getBudgetLimitUSD(), null);
		});
	});

	test('resetSession clears accumulated data but not budget', () => {
		withMeteringService((service) => {
			service.setBudgetLimitUSD(10);
			service.recordTurn({
				usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
				providerName: 'anthropic',
				modelName: 'claude-sonnet-4-6',
				threadId: 'thread-1',
			});
			service.resetSession();
			assert.strictEqual(service.getSession().totalTurns, 0);
			assert.strictEqual(service.getBudgetLimitUSD(), 10);
		});
	});

	test('prunes daily buckets older than 90 days', () => {
		withMeteringService((service, storage, ds) => {
			const oldDay = new Date(Date.now() - 100 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
			const turnUsage = {
				usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 },
				providerName: 'anthropic' as const,
				modelName: 'claude-sonnet-4-6',
				threadId: 'thread-1',
			};

			for (let i = 0; i < 19; i++) {
				service.recordTurn(turnUsage);
			}

			const session = service.getSession();
			session.dailyUSD[oldDay] = 1.23;
			storage.store(
				STORAGE_KEY_METERING_SESSION,
				JSON.stringify({ ...session, totalTurns: 19 }),
				StorageScope.APPLICATION,
				StorageTarget.USER,
			);

			const reloaded = ds.add(new UsageMeteringService(storage));
			reloaded.recordTurn(turnUsage);

			assert.strictEqual(reloaded.getSession().dailyUSD[oldDay], undefined);
		});
	});
});
