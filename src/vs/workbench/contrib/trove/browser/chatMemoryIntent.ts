/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

const REMEMBER_PATTERNS: RegExp[] = [
	/^please\s+remember\s+(?:that\s+)?(.+)$/is,
	/^remember\s+(?:that\s+)?(.+)$/is,
	/^don'?t\s+forget\s+(?:that\s+)?(.+)$/is,
	/^save\s+(?:this\s+)?to\s+(?:trove\s+)?memory[:\s]+(.+)$/is,
	/^keep\s+in\s+mind\s+(?:that\s+)?(.+)$/is,
];

const TRAILING_POLITENESS = /(?:[.!?\s]+(?:thanks|thank you|please)\.?)*$/i;

/** Trailing clause that starts a separate task after the memory fact. */
const TASK_CONTINUATION = /\s*,\s*(?:then|and then|after that|also)\s+.+/is;

export const MEMORY_SAVED_CONFIRMATION = 'Saved to your Trove memory. I\'ll keep that in mind for future sessions.';

const normalizeFact = (raw: string): string => {
	return raw
		.replace(TASK_CONTINUATION, '')
		.replace(TRAILING_POLITENESS, '')
		.trim()
		.replace(/\.$/, '');
};

/** Extract the fact to store from a natural-language remember request, or null. */
export const extractRememberIntent = (text: string): string | null => {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}

	for (const pattern of REMEMBER_PATTERNS) {
		const match = trimmed.match(pattern);
		const fact = match?.[1] ? normalizeFact(match[1]) : null;
		if (fact) {
			return fact;
		}
	}
	return null;
};

/** True when the message is only asking Trove to remember something (no other task). */
export const isRememberOnlyMessage = (text: string): boolean => {
	if (!extractRememberIntent(text)) {
		return false;
	}
	return !TASK_CONTINUATION.test(text.trim());
};
