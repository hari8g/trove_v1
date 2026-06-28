/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Diff } from '../../common/editCodeServiceTypes.js';

/** Map a diff to overlay-widget anchor line + vertical offset (mirrors editCodeService styling logic). */
export const getAcceptRejectWidgetPlacement = (diff: Diff): { startLine: number; offsetLines: number } => {
	if (diff.type === 'insertion' || diff.type === 'edit') {
		return { startLine: diff.startLine, offsetLines: 0 };
	}
	if (diff.type === 'deletion') {
		if (diff.startLine === 1) {
			const numRedLines = diff.originalEndLine - diff.originalStartLine + 1;
			return { startLine: diff.startLine, offsetLines: -numRedLines };
		}
		return { startLine: diff.startLine - 1, offsetLines: 1 };
	}
	throw new Error('Trove 1');
};
