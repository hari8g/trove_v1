/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractSearchReplaceBlocks, normalizeSearchReplaceBlocks } from './extractCodeFromResult.js';

const COMPLETE_BLOCK = [
	'<<<<<<< ORIGINAL',
	'const x = 1;',
	'=======',
	'const x = 2;',
	'>>>>>>> UPDATED',
].join('\n');

suite('Trove - extractCodeFromResult', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('extractSearchReplaceBlocks parses a complete block', () => {
		const blocks = extractSearchReplaceBlocks(COMPLETE_BLOCK);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].state, 'done');
		assert.strictEqual(blocks[0].orig, 'const x = 1;');
		assert.strictEqual(blocks[0].final, 'const x = 2;');
	});

	test('normalizeSearchReplaceBlocks inserts ORIGINAL for divider-only payloads', () => {
		const normalized = normalizeSearchReplaceBlocks('=======\nconst x = 2;\n>>>>>>> UPDATED');
		assert.ok(normalized.includes('<<<<<<< ORIGINAL'));
		const blocks = extractSearchReplaceBlocks(normalized);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].final, 'const x = 2;');
	});

	test('extractSearchReplaceBlocks tracks partial original state', () => {
		const partial = '<<<<<<< ORIGINAL\nconst x = 1;';
		const blocks = extractSearchReplaceBlocks(partial);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].state, 'writingOriginal');
		assert.strictEqual(blocks[0].orig, 'const x = 1;');
	});

	test('extractSearchReplaceBlocks tracks partial final state', () => {
		const partial = [
			'<<<<<<< ORIGINAL',
			'const x = 1;',
			'=======',
			'const x = 2;',
		].join('\n');
		const blocks = extractSearchReplaceBlocks(partial);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].state, 'writingFinal');
		assert.strictEqual(blocks[0].final, 'const x = 2;');
	});

	test('completed block replaces original text in source content', () => {
		const source = 'const x = 1;\nconst y = 2;';
		const blocks = extractSearchReplaceBlocks(COMPLETE_BLOCK);
		const applied = source.replace(blocks[0].orig, blocks[0].final);
		assert.strictEqual(applied, 'const x = 2;\nconst y = 2;');
	});

	test('extractSearchReplaceBlocks parses multiple blocks', () => {
		const multi = [
			COMPLETE_BLOCK,
			'',
			'<<<<<<< ORIGINAL',
			'const y = 1;',
			'=======',
			'const y = 3;',
			'>>>>>>> UPDATED',
		].join('\n');
		const blocks = extractSearchReplaceBlocks(multi);
		assert.strictEqual(blocks.length, 2);
		assert.strictEqual(blocks[0].orig, 'const x = 1;');
		assert.strictEqual(blocks[1].orig, 'const y = 1;');
	});
});
