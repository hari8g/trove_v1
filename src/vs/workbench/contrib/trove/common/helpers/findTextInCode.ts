/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

const numLinesOfStr = (str: string) => str.split('\n').length;

const removeWhitespaceExceptNewlines = (str: string): string => {
	return str.replace(/[^\S\n]+/g, '');
};

export type FindTextInCodeResult = readonly [startLine: number, endLine: number];
export type FindTextInCodeError = 'Not found' | 'Not unique';

/** Finds block.orig in fileContents and returns its 1-indexed line range. */
export const findTextInCode = (
	text: string,
	fileContents: string,
	canFallbackToRemoveWhitespace: boolean,
	opts: { startingAtLine?: number; returnType: 'lines' },
): FindTextInCodeResult | FindTextInCodeError => {

	const returnAns = (contents: string, idx: number) => {
		const startLine = numLinesOfStr(contents.substring(0, idx + 1));
		const numLines = numLinesOfStr(text);
		const endLine = startLine + numLines - 1;

		return [startLine, endLine] as const;
	};

	const startingAtLineIdx = (contents: string) => opts?.startingAtLine !== undefined ?
		contents.split('\n').slice(0, opts.startingAtLine).join('\n').length
		: 0;

	let idx = fileContents.indexOf(text, startingAtLineIdx(fileContents));

	if (idx !== -1) {
		return returnAns(fileContents, idx);
	}

	if (!canFallbackToRemoveWhitespace) {
		return 'Not found';
	}

	text = removeWhitespaceExceptNewlines(text);
	fileContents = removeWhitespaceExceptNewlines(fileContents);
	idx = fileContents.indexOf(text, startingAtLineIdx(fileContents));

	if (idx === -1) {
		return 'Not found';
	}
	const lastIdx = fileContents.lastIndexOf(text);
	if (lastIdx !== idx) {
		return 'Not unique';
	}

	return returnAns(fileContents, idx);
};
