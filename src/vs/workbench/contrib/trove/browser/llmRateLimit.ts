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

export const isContextOverflowLLMError = (error: LLMErrorLike): boolean => {
	const message = error.message.toLowerCase();
	return message.includes('context_length')
		|| message.includes('context length')
		|| message.includes('context_length_exceeded')
		|| message.includes('token limit')
		|| message.includes('maximum context')
		|| message.includes('too many tokens')
		|| message.includes('prompt is too long')
		|| message.includes('request too large');
};

export const isStreamStallLLMError = (error: LLMErrorLike): boolean => {
	return error.message.toLowerCase().includes('stream stalled');
};

export const isFatalLLMError = (error: LLMErrorLike): boolean => {
	if (isContextOverflowLLMError(error)) {
		return false;
	}
	const serialized = getSerializedError(error.fullError);
	const status = serialized?.status;
	if (status === 401 || status === 403 || status === 404) {
		return true;
	}
	if (status === 400) {
		return true;
	}
	const message = error.message.toLowerCase();
	return message.includes('unauthorized')
		|| message.includes('invalid api key')
		|| message.includes('authentication')
		|| message.includes('forbidden')
		|| message.includes('not found');
};

/** Max retries for generic LLM errors vs rate-limit errors. */
export const getMaxLLMRetryAttempts = (error: LLMErrorLike): number => {
	if (isFatalLLMError(error)) {
		return 0;
	}
	if (isContextOverflowLLMError(error)) {
		return 2;
	}
	if (isRateLimitLLMError(error)) {
		return 2;
	}
	if (isStreamStallLLMError(error)) {
		return 2;
	}
	const serialized = getSerializedError(error.fullError);
	if (serialized?.status && serialized.status >= 500) {
		return 3;
	}
	return 3;
};

export const shouldForceAggressiveTrimOnRetry = (error: LLMErrorLike): boolean => {
	return isContextOverflowLLMError(error);
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
