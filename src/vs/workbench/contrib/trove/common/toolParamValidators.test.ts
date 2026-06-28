/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createBuiltinToolValidators } from './toolParamValidators.js';

suite('Trove - toolParamValidators', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const validateParams = createBuiltinToolValidators();

	test('read_file validates uri and defaults page number', () => {
		const params = validateParams.read_file({ uri: '/proj/foo.ts' });
		assert.strictEqual(params.uri.fsPath, '/proj/foo.ts');
		assert.strictEqual(params.pageNumber, 1);
		assert.strictEqual(params.startLine, null);
		assert.strictEqual(params.endLine, null);
	});

	test('read_file rejects null uri', () => {
		assert.throws(
			() => validateParams.read_file({ uri: null as unknown as string }),
			/uri was null/,
		);
	});

	test('read_file rejects invalid page number', () => {
		assert.throws(
			() => validateParams.read_file({ uri: '/a.ts', page_number: '0' }),
			/must be 1 or greater/,
		);
	});

	test('search_for_files validates query and optional folder', () => {
		const params = validateParams.search_for_files({
			query: 'TODO',
			search_in_folder: '/proj/src',
			is_regex: 'true',
		});
		assert.strictEqual(params.query, 'TODO');
		assert.strictEqual(params.isRegex, true);
		assert.strictEqual(params.searchInFolder?.fsPath, '/proj/src');
	});

	test('search_for_files rejects non-string query', () => {
		assert.throws(
			() => validateParams.search_for_files({ query: 123 as unknown as string }),
			/query must be a string/,
		);
	});

	test('search_codebase clamps max_results', () => {
		const params = validateParams.search_codebase({ query: 'auth', max_results: '999' });
		assert.strictEqual(params.maxResults, 50);
	});

	test('search_web defaults max_results to 5', () => {
		const params = validateParams.search_web({ query: 'react docs' });
		assert.strictEqual(params.maxResults, 5);
	});

	test('search_in_file validates uri and regex flag', () => {
		const params = validateParams.search_in_file({
			uri: '/a.ts',
			query: 'function',
			is_regex: 'false',
		});
		assert.strictEqual(params.query, 'function');
		assert.strictEqual(params.isRegex, false);
	});

	test('edit_file normalizes search_replace_blocks', () => {
		const params = validateParams.edit_file({
			uri: '/a.ts',
			search_replace_blocks: '=======\nnew\n>>>>>>> UPDATED',
		});
		assert.ok(params.searchReplaceBlocks.includes('<<<<<<< ORIGINAL'));
		assert.strictEqual(params.uri.fsPath, '/a.ts');
	});

	test('edit_file rejects missing search_replace_blocks', () => {
		assert.throws(
			() => validateParams.edit_file({ uri: '/a.ts' }),
			/searchReplaceBlocks/,
		);
	});

	test('rewrite_file accepts JSON object content', () => {
		const params = validateParams.rewrite_file({
			uri: '/a.ts',
			new_content: { hello: 'world' } as unknown as string,
		});
		assert.ok(params.newContent.includes('"hello"'));
	});

	test('create_file_or_folder detects folder trailing slash', () => {
		const params = validateParams.create_file_or_folder({ uri: '/proj/new-dir/' });
		assert.strictEqual(params.isFolder, true);
	});

	test('run_command rejects heredoc commands', () => {
		assert.throws(
			() => validateParams.run_command({ command: 'cat << EOF\nx\nEOF' }),
			/heredoc/,
		);
	});

	test('run_command assigns terminal id', () => {
		const params = validateParams.run_command({ command: 'npm test' });
		assert.strictEqual(params.command, 'npm test');
		assert.ok(params.terminalId.length > 0);
	});

	test('run_persistent_command requires terminal id', () => {
		assert.throws(
			() => validateParams.run_persistent_command({ command: 'npm run dev' }),
			/terminalID must be specified/,
		);
	});

	test('open_persistent_terminal accepts optional cwd', () => {
		const params = validateParams.open_persistent_terminal({ cwd: '/proj' });
		assert.strictEqual(params.cwd, '/proj');
	});

	test('kill_persistent_terminal validates terminal id', () => {
		const params = validateParams.kill_persistent_terminal({ persistent_terminal_id: 'term-1' });
		assert.strictEqual(params.persistentTerminalId, 'term-1');
	});
});
