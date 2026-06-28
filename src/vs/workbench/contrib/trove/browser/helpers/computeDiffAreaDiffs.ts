/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ComputedDiff } from '../../common/editCodeServiceTypes.js';
import { findDiffs } from './findDiffs.js';

/** Extract the DiffZone slice from full file text (1-indexed inclusive line range). */
export const sliceDiffAreaCodeFromFile = (fullFileText: string, startLine: number, endLine: number): string =>
	fullFileText.split('\n').slice(startLine - 1, endLine).join('\n');

/** Compute line-level diffs for a DiffZone, offset into the full file coordinate system. */
export const computeDiffAreaDiffs = (
	originalCode: string,
	newDiffAreaCode: string,
	diffAreaStartLine: number,
): ComputedDiff[] => {
	const lineOffset = diffAreaStartLine - 1;
	return findDiffs(originalCode, newDiffAreaCode).map((computedDiff) => {
		if (computedDiff.type === 'deletion') {
			return { ...computedDiff, startLine: computedDiff.startLine + lineOffset };
		}
		if (computedDiff.type === 'edit' || computedDiff.type === 'insertion') {
			return {
				...computedDiff,
				startLine: computedDiff.startLine + lineOffset,
				endLine: computedDiff.endLine + lineOffset,
			};
		}
		return computedDiff;
	});
};
