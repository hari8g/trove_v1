/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createCoreBuiltinToolCallHandlers, CoreToolHandlerDeps } from '../coreToolHandlers.js';
import { createFakeModel, createFakeModelService } from './editCodeServiceHarness.js';
import { parseTestOutput } from '../testRunnerService.js';

suite('Trove - coreToolHandlers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('read_file returns emptyReason for empty file', async () => {
		const uri = URI.file('/proj/empty.ts');
		const fakeModelService = createFakeModelService();
		fakeModelService.__setModel(uri, createFakeModel(''));

		const handlers = createCoreBuiltinToolCallHandlers({
			troveModelService: fakeModelService as unknown as CoreToolHandlerDeps['troveModelService'],
			fileService: {} as CoreToolHandlerDeps['fileService'],
			workspaceContextService: {
				getWorkspace: () => ({ folders: [{ uri: URI.file('/proj') }] }),
			} as unknown as CoreToolHandlerDeps['workspaceContextService'],
			searchService: {} as CoreToolHandlerDeps['searchService'],
			queryBuilder: {} as CoreToolHandlerDeps['queryBuilder'],
			editCodeService: {} as CoreToolHandlerDeps['editCodeService'],
			terminalToolService: {} as CoreToolHandlerDeps['terminalToolService'],
			commandBarService: { getStreamState: () => undefined } as unknown as CoreToolHandlerDeps['commandBarService'],
			directoryStrService: {} as CoreToolHandlerDeps['directoryStrService'],
			troveSettingsService: {} as CoreToolHandlerDeps['troveSettingsService'],
			repoIntelligenceService: { getProfileSync: () => null } as unknown as CoreToolHandlerDeps['repoIntelligenceService'],
			webSearchService: {} as CoreToolHandlerDeps['webSearchService'],
			getLintErrors: () => ({ lintErrors: null }),
			getLintErrorsWhenSettled: async () => ({ lintErrors: null, settled: true }),
		});

		const { result } = await handlers.read_file({ uri, startLine: null, endLine: null, pageNumber: 1 });
		const resolved = await result;
		assert.strictEqual(resolved.emptyReason, 'empty-file');
		assert.strictEqual(resolved.totalFileLen, 0);
		assert.strictEqual(resolved.fileContents, '');
	});

	test('create_file_or_folder reports alreadyExisted when present', async () => {
		const uri = URI.file('/proj/a.ts');
		const exists = new Set([uri.toString()]);
		const handlers = createCoreBuiltinToolCallHandlers({
			troveModelService: createFakeModelService() as unknown as CoreToolHandlerDeps['troveModelService'],
			fileService: {
				exists: async (u: URI) => exists.has(u.toString()),
				createFolder: async () => { },
				writeFile: async () => { },
			} as unknown as CoreToolHandlerDeps['fileService'],
			workspaceContextService: {
				getWorkspace: () => ({ folders: [{ uri: URI.file('/proj') }] }),
			} as unknown as CoreToolHandlerDeps['workspaceContextService'],
			searchService: {} as CoreToolHandlerDeps['searchService'],
			queryBuilder: {} as CoreToolHandlerDeps['queryBuilder'],
			editCodeService: {} as CoreToolHandlerDeps['editCodeService'],
			terminalToolService: {} as CoreToolHandlerDeps['terminalToolService'],
			commandBarService: { getStreamState: () => undefined } as unknown as CoreToolHandlerDeps['commandBarService'],
			directoryStrService: {} as CoreToolHandlerDeps['directoryStrService'],
			troveSettingsService: {} as CoreToolHandlerDeps['troveSettingsService'],
			repoIntelligenceService: { getProfileSync: () => null } as unknown as CoreToolHandlerDeps['repoIntelligenceService'],
			webSearchService: {} as CoreToolHandlerDeps['webSearchService'],
			getLintErrors: () => ({ lintErrors: null }),
			getLintErrorsWhenSettled: async () => ({ lintErrors: null, settled: true }),
		});

		const { result } = await handlers.create_file_or_folder({ uri, isFolder: false });
		assert.deepStrictEqual(await result, { created: false, alreadyExisted: true });
	});

	test('run_tests parses terminal output via test runner', async () => {
		const jestOut = `
FAIL src/a.test.js
  ● A › fails
    boom
      at Object.<anonymous> (src/a.test.js:3:5)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 0 passed, 1 total
`;
		const handlers = createCoreBuiltinToolCallHandlers({
			troveModelService: createFakeModelService() as unknown as CoreToolHandlerDeps['troveModelService'],
			fileService: {} as CoreToolHandlerDeps['fileService'],
			workspaceContextService: {
				getWorkspace: () => ({ folders: [{ uri: URI.file('/proj') }] }),
			} as unknown as CoreToolHandlerDeps['workspaceContextService'],
			searchService: {} as CoreToolHandlerDeps['searchService'],
			queryBuilder: {} as CoreToolHandlerDeps['queryBuilder'],
			editCodeService: {} as CoreToolHandlerDeps['editCodeService'],
			terminalToolService: {
				runCommand: async () => ({
					interrupt: () => { },
					resPromise: Promise.resolve({
						result: jestOut,
						resolveReason: { type: 'done' as const, exitCode: 1 },
					}),
				}),
			} as unknown as CoreToolHandlerDeps['terminalToolService'],
			commandBarService: { getStreamState: () => undefined } as unknown as CoreToolHandlerDeps['commandBarService'],
			directoryStrService: {} as CoreToolHandlerDeps['directoryStrService'],
			troveSettingsService: {} as CoreToolHandlerDeps['troveSettingsService'],
			repoIntelligenceService: {
				getProfileSync: () => ({ testCommands: [{ command: 'npm test' }] }),
			} as unknown as CoreToolHandlerDeps['repoIntelligenceService'],
			webSearchService: {} as CoreToolHandlerDeps['webSearchService'],
			getLintErrors: () => ({ lintErrors: null }),
			getLintErrorsWhenSettled: async () => ({ lintErrors: null, settled: true }),
		});

		const { result } = await handlers.run_tests({ testCommand: null, filePattern: null, terminalId: 't1' });
		const resolved = await result;
		assert.strictEqual(resolved.framework, 'jest');
		assert.strictEqual(resolved.failed, 1);
		assert.strictEqual(resolved.command, 'npm test');
		// Sanity: same as direct parser
		assert.strictEqual(parseTestOutput(jestOut, 1).failed, 1);
	});
});
