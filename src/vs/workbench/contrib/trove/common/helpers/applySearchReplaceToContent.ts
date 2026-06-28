/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { tripleTick } from '../prompt/prompts.js';
import { extractSearchReplaceBlocks, normalizeSearchReplaceBlocks } from './extractCodeFromResult.js';
import { findTextInCode } from './findTextInCode.js';

const errContentOfInvalidStr = (
	str: 'Not found' | 'Not unique' | 'Has overlap',
	blockOrig: string,
): string => {
	const problematicCode = `${tripleTick[0]}\n${JSON.stringify(blockOrig)}\n${tripleTick[1]}`;

	switch (str) {
		case 'Not found':
			return `The edit was not applied. The text in ORIGINAL must EXACTLY match lines of code in the file, but there was no match for:\n${problematicCode}. Ensure you have the latest version of the file, and ensure the ORIGINAL code matches a code excerpt exactly.`;
		case 'Not unique':
			return `The edit was not applied. The text in ORIGINAL must be unique in the file being edited, but the following ORIGINAL code appears multiple times in the file:\n${problematicCode}. Ensure you have the latest version of the file, and ensure the ORIGINAL code is unique.`;
		case 'Has overlap':
			return `The edit was not applied. The text in the ORIGINAL blocks must not overlap, but the following ORIGINAL code had overlap with another ORIGINAL string:\n${problematicCode}. Ensure you have the latest version of the file, and ensure the ORIGINAL code blocks do not overlap.`;
		default:
			return '';
	}
};

/** Applies normalized SEARCH/REPLACE blocks to file contents without touching the editor model. */
export const applySearchReplaceBlocksToContent = (fileContents: string, blocksStr: string): string => {
	const blocks = extractSearchReplaceBlocks(normalizeSearchReplaceBlocks(blocksStr));
	if (blocks.length === 0) {
		throw new Error('No Search/Replace blocks were received!');
	}

	const modelStrLines = fileContents.split('\n');
	const replacements: { origStart: number; origEnd: number; final: string }[] = [];

	for (const block of blocks) {
		const res = findTextInCode(block.orig, fileContents, true, { returnType: 'lines' });
		if (typeof res === 'string') {
			throw new Error(errContentOfInvalidStr(res, block.orig));
		}
		let [startLine, endLine] = res;
		startLine -= 1;
		endLine -= 1;

		const origStart = (startLine !== 0 ?
			modelStrLines.slice(0, startLine).join('\n') + '\n'
			: '').length;

		const origEnd = modelStrLines.slice(0, endLine + 1).join('\n').length - 1;

		replacements.push({ origStart, origEnd, final: block.final });
	}

	replacements.sort((a, b) => a.origStart - b.origStart);

	for (let i = 1; i < replacements.length; i++) {
		if (replacements[i].origStart <= replacements[i - 1].origEnd) {
			throw new Error(errContentOfInvalidStr('Has overlap', blocks[i]?.orig ?? ''));
		}
	}

	let newCode = fileContents;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const { origStart, origEnd, final } = replacements[i];
		newCode = newCode.slice(0, origStart) + final + newCode.slice(origEnd + 1, Infinity);
	}

	return newCode;
};
