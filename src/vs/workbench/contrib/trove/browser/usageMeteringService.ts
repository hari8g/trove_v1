/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { LLMMessageUsage } from '../common/llmMessageUsage.js';
import { ProviderName } from '../common/troveSettingsTypes.js';
import { calculateTurnCostUSD } from '../common/llmPricing.js';
import { MeteringSession } from '../common/usageMeteringTypes.js';
import {
	STORAGE_KEY_METERING_BUDGET,
	STORAGE_KEY_METERING_SESSION,
} from '../common/storageKeys.js';

export interface IUsageMeteringService {
	readonly _serviceBrand: undefined;
	readonly onDidUpdate: Event<MeteringSession>;
	recordTurn(opts: {
		usage: LLMMessageUsage;
		providerName: ProviderName;
		modelName: string;
		threadId: string;
	}): void;
	getSession(): MeteringSession;
	getTodayCostUSD(): number;
	getThreadCostUSD(threadId: string): number;
	getBudgetLimitUSD(): number | null;
	setBudgetLimitUSD(usd: number | null): void;
	resetSession(): void;
}

export const IUsageMeteringService = createDecorator<IUsageMeteringService>('usageMeteringService');

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1_000;

const emptySession = (): MeteringSession => ({
	startedAt: Date.now(),
	totalCostUSD: 0,
	totalTurns: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheWriteTokens: 0,
	byProvider: {},
	byThread: {},
	dailyUSD: {},
});

export class UsageMeteringService extends Disposable implements IUsageMeteringService {
	readonly _serviceBrand: undefined;

	private readonly _onDidUpdate = this._register(new Emitter<MeteringSession>());
	readonly onDidUpdate = this._onDidUpdate.event;

	private _session: MeteringSession;

	constructor(
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		this._session = this._load();
	}

	private _load(): MeteringSession {
		try {
			const raw = this._storage.get(STORAGE_KEY_METERING_SESSION, StorageScope.APPLICATION);
			if (raw) {
				const parsed = JSON.parse(raw) as MeteringSession;
				return {
					...parsed,
					totalCacheWriteTokens: parsed.totalCacheWriteTokens ?? 0,
				};
			}
		} catch { /* corrupt storage — start fresh */ }
		return emptySession();
	}

	private _persist(): void {
		this._storage.store(
			STORAGE_KEY_METERING_SESSION,
			JSON.stringify(this._session),
			StorageScope.APPLICATION,
			StorageTarget.USER,
		);
	}

	private _today(): string {
		return new Date().toISOString().slice(0, 10);
	}

	private _pruneDailyBuckets(): void {
		const cutoffMs = Date.now() - NINETY_DAYS_MS;
		for (const day of Object.keys(this._session.dailyUSD)) {
			if (new Date(day).getTime() < cutoffMs) {
				delete this._session.dailyUSD[day];
			}
		}
	}

	recordTurn(opts: {
		usage: LLMMessageUsage;
		providerName: ProviderName;
		modelName: string;
		threadId: string;
	}): void {
		const costUSD = calculateTurnCostUSD(opts.usage, opts.providerName, opts.modelName);
		const today = this._today();

		this._session.totalCostUSD += costUSD;
		this._session.totalTurns += 1;
		this._session.totalInputTokens += opts.usage.inputTokens;
		this._session.totalOutputTokens += opts.usage.outputTokens;
		this._session.totalCacheReadTokens += opts.usage.cacheReadTokens;
		this._session.totalCacheWriteTokens += opts.usage.cacheWriteTokens ?? 0;

		const prov = this._session.byProvider[opts.providerName]
			?? (this._session.byProvider[opts.providerName] = { costUSD: 0, turns: 0 });
		prov.costUSD += costUSD;
		prov.turns += 1;

		const thread = this._session.byThread[opts.threadId]
			?? (this._session.byThread[opts.threadId] = { costUSD: 0, turns: 0 });
		thread.costUSD += costUSD;
		thread.turns += 1;

		this._session.dailyUSD[today] = (this._session.dailyUSD[today] ?? 0) + costUSD;

		if (this._session.totalTurns % 20 === 0) {
			this._pruneDailyBuckets();
		}

		this._persist();
		this._onDidUpdate.fire({ ...this._session });
	}

	getSession(): MeteringSession {
		return { ...this._session };
	}

	getTodayCostUSD(): number {
		return this._session.dailyUSD[this._today()] ?? 0;
	}

	getThreadCostUSD(threadId: string): number {
		return this._session.byThread[threadId]?.costUSD ?? 0;
	}

	getBudgetLimitUSD(): number | null {
		const raw = this._storage.get(STORAGE_KEY_METERING_BUDGET, StorageScope.APPLICATION);
		if (!raw) {
			return null;
		}
		const n = parseFloat(raw);
		return Number.isFinite(n) ? n : null;
	}

	setBudgetLimitUSD(usd: number | null): void {
		if (usd === null || usd <= 0) {
			this._storage.remove(STORAGE_KEY_METERING_BUDGET, StorageScope.APPLICATION);
		} else {
			this._storage.store(
				STORAGE_KEY_METERING_BUDGET,
				String(usd),
				StorageScope.APPLICATION,
				StorageTarget.USER,
			);
		}
		this._onDidUpdate.fire({ ...this._session });
	}

	resetSession(): void {
		this._session = emptySession();
		this._persist();
		this._onDidUpdate.fire({ ...this._session });
	}
}

registerSingleton(IUsageMeteringService, UsageMeteringService, InstantiationType.Delayed);
