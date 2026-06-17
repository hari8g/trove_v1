/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getLLMRetryDelayMs, getMaxLLMRetryAttempts, isRateLimitLLMError } from '../llmRateLimit.js';

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

	test('getLLMRetryDelayMs honors retry-after header', () => {
		const delay = getLLMRetryDelayMs({
			message: '429',
			fullError: { status: 429, headers: { 'retry-after': '84' } } as any,
		}, 1, 2500);
		assert.strictEqual(delay, 84_500);
	});
});
