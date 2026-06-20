/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	clearProviderRateLimitCooldown,
	getLLMRetryDelayMs,
	getMaxLLMRetryAttempts,
	getProviderRateLimitCooldownMs,
	isContextOverflowLLMError,
	isFatalLLMError,
	isRateLimitLLMError,
	parseRateLimitCooldownUntilMs,
	recordProviderRateLimitHit,
	shouldForceAggressiveTrimOnRetry,
} from '../llmRateLimit.js';

suite('Trove - llmRateLimit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isRateLimitLLMError detects 429 messages and status', () => {
		assert.strictEqual(isRateLimitLLMError({ message: 'Error: 429 rate_limit_error', fullError: null }), true);
		assert.strictEqual(isRateLimitLLMError({ message: 'network error', fullError: { status: 429, headers: {} } as any }), true);
		assert.strictEqual(isRateLimitLLMError({ message: 'network error', fullError: null }), false);
	});

	test('getMaxLLMRetryAttempts limits rate-limit retries', () => {
		const rateLimitErr = { message: '429 rate limit', fullError: null };
		assert.strictEqual(getMaxLLMRetryAttempts(rateLimitErr), 2);
		assert.strictEqual(getMaxLLMRetryAttempts({ message: 'timeout', fullError: null }), 3);
	});

	test('getMaxLLMRetryAttempts fails fast on fatal errors', () => {
		assert.strictEqual(getMaxLLMRetryAttempts({ message: 'unauthorized', fullError: { status: 401 } as any }), 0);
		assert.strictEqual(getMaxLLMRetryAttempts({ message: 'bad request', fullError: { status: 400 } as any }), 0);
	});

	test('getMaxLLMRetryAttempts allows one retry for context overflow', () => {
		const err = { message: 'context_length_exceeded', fullError: null };
		assert.strictEqual(isContextOverflowLLMError(err), true);
		assert.strictEqual(isFatalLLMError(err), false);
		assert.strictEqual(getMaxLLMRetryAttempts(err), 2);
	});

	test('shouldForceAggressiveTrimOnRetry includes rate limit', () => {
		assert.strictEqual(shouldForceAggressiveTrimOnRetry({ message: '429 rate_limit_error', fullError: null }), true);
	});

	test('getLLMRetryDelayMs honors retry-after header', () => {
		const delay = getLLMRetryDelayMs({
			message: '429',
			fullError: { status: 429, headers: { 'retry-after': '84' } } as any,
		}, 1, 2500);
		assert.strictEqual(delay, 84_500);
	});

	test('parseRateLimitCooldownUntilMs honors retry-after and reset headers', () => {
		const fromRetryAfter = parseRateLimitCooldownUntilMs({
			message: '429',
			fullError: { status: 429, headers: { 'retry-after': '82' } } as any,
		});
		assert.ok(fromRetryAfter >= Date.now() + 81_000);

		const fromReset = parseRateLimitCooldownUntilMs({
			message: '429',
			fullError: {
				status: 429,
				headers: { 'anthropic-ratelimit-input-tokens-reset': '2030-01-01T00:00:00Z' },
			} as any,
		});
		assert.strictEqual(fromReset, Date.parse('2030-01-01T00:00:00Z') + 500);
	});

	test('provider rate limit gate blocks until cooldown expires', () => {
		recordProviderRateLimitHit('anthropic', {
			message: '429',
			fullError: { status: 429, headers: { 'retry-after': '60' } } as any,
		}, 'claude-sonnet-4-6');
		assert.ok(getProviderRateLimitCooldownMs('anthropic', 'claude-sonnet-4-6') > 0);
		clearProviderRateLimitCooldown('anthropic', 'claude-sonnet-4-6');
		assert.strictEqual(getProviderRateLimitCooldownMs('anthropic', 'claude-sonnet-4-6'), 0);
	});
});
