/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { chunkFile } from '../codeChunker.js';
import { hashWorkspaceRoot, RepoIntelligenceDb } from '../repoIntelligenceDb.js';

suite('Trove - codeChunker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const workspaceHash = hashWorkspaceRoot('/tmp/test-workspace');

	test('chunks TypeScript functions and classes', () => {
		const content = [
			'export function foo() {',
			'  return 1;',
			'}',
			'',
			'export class Bar {',
			'  baz() {',
			'    return 2;',
			'  }',
			'}',
		].join('\n');

		const chunks = chunkFile(workspaceHash, 'src/example.ts', content, 'TypeScript');
		assert.ok(chunks.length >= 2);
		assert.ok(chunks.some(c => c.chunkType === 'function'));
		assert.ok(chunks.some(c => c.chunkType === 'class'));
	});

	test('skips markdown files', () => {
		const chunks = chunkFile(workspaceHash, 'README.md', '# Title\n\nSome text.', 'Markdown');
		assert.strictEqual(chunks.length, 0);
	});

	test('falls back to file chunk when no boundaries found', () => {
		const content = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
		const chunks = chunkFile(workspaceHash, 'plain.js', content, 'JavaScript');
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].chunkType, 'file');
	});
});

suite('Trove - repoIntelligenceDb chunks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let db: RepoIntelligenceDb;
	const workspaceHash = hashWorkspaceRoot('/tmp/phase3-test');
	const dbPath = join(tmpdir(), `trove-phase3-test-${randomBytes(8).toString('hex')}.db`);

	suiteSetup(async () => {
		db = new RepoIntelligenceDb(dbPath);
		await db.init();

		await db.upsertProfile(workspaceHash, {
			workspaceRoot: '/tmp/phase3-test',
			lastScannedAt: Date.now(),
			languageStack: ['TypeScript'],
			frameworks: [],
			packageManagers: [],
			buildCommands: [],
			testCommands: [],
			lintCommands: [],
			typecheckCommands: [],
			projectPurpose: null,
			architectureSummary: null,
			fileCount: 1,
			totalLoc: 10,
			isStale: false,
		}, []);

		await db.replaceChunks(workspaceHash, [{
			id: 'chunk-1',
			filePath: 'src/auth/login.ts',
			chunkText: 'export async function authenticateUser(credentials: Credentials) {\n  return validateSession(credentials);\n}',
			startLine: 1,
			endLine: 3,
			chunkType: 'function',
		}, {
			id: 'chunk-2',
			filePath: 'src/ipc/channel.ts',
			chunkText: 'mainProcessElectronServer.registerChannel("trove-channel-repoIntelligence", repoIntelligenceChannel);',
			startLine: 10,
			endLine: 12,
			chunkType: 'block',
		}]);
	});

	suiteTeardown(() => {
		db.close();
	});

	test('searchChunks finds authentication-related code', async () => {
		const results = await db.searchChunks(workspaceHash, 'authenticate session', 5);
		assert.ok(results.length >= 1);
		assert.ok(results[0].filePath.includes('auth'));
	});

	test('searchChunks finds IPC channel registration', async () => {
		const results = await db.searchChunks(workspaceHash, 'registerChannel repoIntelligence', 5);
		assert.ok(results.length >= 1);
		assert.ok(results[0].filePath.includes('channel'));
	});

	test('searchChunks returns empty for nonsense query', async () => {
		const results = await db.searchChunks(workspaceHash, 'xyzzy quantum entanglement', 5);
		assert.strictEqual(results.length, 0);
	});

	test('getChunkCount returns indexed chunk total', async () => {
		const count = await db.getChunkCount(workspaceHash);
		assert.strictEqual(count, 2);
	});
});
