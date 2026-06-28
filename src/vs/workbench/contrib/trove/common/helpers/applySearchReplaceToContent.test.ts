/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applySearchReplaceBlocksToContent } from './applySearchReplaceToContent.js';

const block = (orig: string, final: string) => [
	'<<<<<<< ORIGINAL',
	orig,
	'=======',
	final,
	'>>>>>>> UPDATED',
].join('\n');

suite('Trove - applySearchReplaceToContent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('applies a single SEARCH/REPLACE block', () => {
		const source = 'const x = 1;\nconst y = 2;';
		const blocks = block('const x = 1;', 'const x = 99;');
		const applied = applySearchReplaceBlocksToContent(source, blocks);
		assert.strictEqual(applied, 'const x = 99;\nconst y = 2;');
	});

	test('applies multiple non-overlapping blocks', () => {
		const source = 'a\nb\nc';
		const blocks = [
			block('a', 'A'),
			block('c', 'C'),
		].join('\n\n');
		assert.strictEqual(applySearchReplaceBlocksToContent(source, blocks), 'A\nb\nC');
	});

	test('throws when ORIGINAL text is not found', () => {
		assert.throws(
			() => applySearchReplaceBlocksToContent('hello', block('missing', 'x')),
			/no match/,
		);
	});

	test('throws when ORIGINAL blocks overlap', () => {
		const source = 'alpha beta gamma';
		const blocks = [
			block('alpha beta', 'AB'),
			block('beta gamma', 'BG'),
		].join('\n\n');
		assert.throws(
			() => applySearchReplaceBlocksToContent(source, blocks),
			/overlap/,
		);
	});
});
