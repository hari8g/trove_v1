/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createBuiltinToolResultStringifiers } from './toolResultStringifiers.js';

suite('Trove - toolResultStringifiers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const stringOfResult = createBuiltinToolResultStringifiers({
		stringifyDirectoryTree: () => 'dir-tree',
		getModelLineContent: (_uri, line) => `line-${line}`,
		formatEditSuccess: uri => `edited ${uri.fsPath}`,
		formatCreateSuccess: uri => `created ${uri.fsPath}`,
		formatRunCommandResult: (_params, result) => result.result,
		formatRunPersistentCommandResult: (_params, result) => result.result,
	});

	test('read_file includes path and fenced contents', () => {
		const out = stringOfResult.read_file(
			{ uri: URI.file('/proj/a.ts'), startLine: null, endLine: null, pageNumber: 1 },
			{ fileContents: 'hello', hasNextPage: false, totalNumLines: 1, totalFileLen: 5 },
		);
		assert.ok(out.includes('/proj/a.ts'));
		assert.ok(out.includes('```\nhello\n```'));
	});

	test('search_codebase formats empty and non-empty results', () => {
		const empty = stringOfResult.search_codebase(
			{ query: 'auth', maxResults: 5 },
			{ query: 'auth', results: [] },
		);
		assert.ok(empty.includes('No codebase matches'));

		const filled = stringOfResult.search_codebase(
			{ query: 'auth', maxResults: 5 },
			{ query: 'auth', results: [{ filePath: 'a.ts', startLine: 1, endLine: 2, snippet: 'token' }] },
		);
		assert.ok(filled.includes('a.ts:1-2'));
		assert.ok(filled.includes('token'));
	});

	test('search_web formats result list', () => {
		const out = stringOfResult.search_web(
			{ query: 'react', maxResults: 3 },
			{ query: 'react', results: [{ title: 'Docs', url: 'https://example.com', snippet: 'hooks' }] },
		);
		assert.ok(out.includes('Docs'));
		assert.ok(out.includes('https://example.com'));
	});

	test('delete_file_or_folder reports deleted path', () => {
		const out = stringOfResult.delete_file_or_folder(
			{ uri: URI.file('/proj/old.ts'), isRecursive: false, isFolder: false },
			{ uri: URI.file('/proj/old.ts') },
		);
		assert.ok(out.includes('/proj/old.ts'));
		assert.ok(out.includes('successfully deleted'));
	});

	test('search_in_file uses injected line content provider', () => {
		const out = stringOfResult.search_in_file(
			{ uri: URI.file('/a.ts'), query: 'foo', isRegex: false },
			{ lines: [3, 7] },
		);
		assert.ok(out.includes('Line 3'));
		assert.ok(out.includes('line-3'));
		assert.ok(out.includes('line-7'));
	});
});
