/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

type LLMErrorLike = { message: string; fullError: Error | null };

type SerializedApiError = {
	status?: number;
	headers?: Record<string, string | string[] | undefined>;
};

const getSerializedError = (fullError: Error | null): SerializedApiError | null => {
	if (!fullError || typeof fullError !== 'object') {
		return null;
	}
	return fullError as SerializedApiError;
};

export const isRateLimitLLMError = (error: LLMErrorLike): boolean => {
	const message = error.message.toLowerCase();
	if (message.includes('429') || message.includes('rate_limit') || message.includes('rate limit')) {
		return true;
	}
	const serialized = getSerializedError(error.fullError);
	return serialized?.status === 429;
};

/** Max retries for generic LLM errors vs rate-limit errors. */
export const getMaxLLMRetryAttempts = (error: LLMErrorLike): number => {
	return isRateLimitLLMError(error) ? 2 : 3;
};

/** Prefer provider retry-after header; otherwise exponential backoff for rate limits. */
export const getLLMRetryDelayMs = (error: LLMErrorLike, attempt: number, defaultDelayMs: number): number => {
	const serialized = getSerializedError(error.fullError);
	const retryAfterRaw = serialized?.headers?.['retry-after'];
	const retryAfterHeader = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw;
	if (retryAfterHeader) {
		const seconds = parseInt(retryAfterHeader, 10);
		if (!Number.isNaN(seconds) && seconds > 0) {
			return seconds * 1000 + 500;
		}
	}

	if (isRateLimitLLMError(error)) {
		return Math.min(120_000, defaultDelayMs * Math.pow(2, attempt));
	}
	return defaultDelayMs;
};
