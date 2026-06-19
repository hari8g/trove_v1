/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { serializeWorkspaceProfileForPrompt } from '../../common/prompt/prompts.js';
import { REPO_PROFILE_MAX_CHARS, type WorkspaceProfile } from '../../common/repoIntelligenceTypes.js';

function makeProfile(overrides: Partial<WorkspaceProfile> = {}): WorkspaceProfile {
	return {
		workspaceRoot: '/Users/dev/trove_v1',
		lastScannedAt: Date.now(),
		languageStack: ['typescript', 'javascript'],
		frameworks: [
			{ name: 'react', version: '18.3.1', confidence: 'high' },
			{ name: 'electron', version: '32.0.0', confidence: 'high' },
		],
		packageManagers: ['npm'],
		buildCommands: [
			{ command: 'npm run compile', purpose: 'build', confidence: 'high', source: 'package.json' },
			{ command: 'npm run watch', purpose: 'start', confidence: 'high', source: 'package.json' },
			{ command: 'npm run buildreact', purpose: 'format', confidence: 'medium', source: 'package.json' },
		],
		testCommands: [
			{ command: 'npm run test-trove', purpose: 'test', confidence: 'high', source: 'package.json' },
		],
		lintCommands: [
			{ command: 'npm run lint', purpose: 'lint', confidence: 'high', source: 'package.json' },
		],
		typecheckCommands: [
			{ command: 'npm run typecheck', purpose: 'typecheck', confidence: 'medium', source: 'package.json' },
		],
		projectPurpose: 'Agentic IDE fork of VS Code',
		architectureSummary: 'Monorepo with Electron main, browser workbench, and React sidebar.',
		fileCount: 12_345,
		totalLoc: 987_654,
		isStale: false,
		...overrides,
	};
}

function profileBody(block: string): string {
	return block.replace(/^<repository_context>\n/, '').replace(/\n<\/repository_context>$/, '');
}

suite('Trove - serializeWorkspaceProfileForPrompt', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('null profile returns empty string', () => {
		assert.strictEqual(serializeWorkspaceProfileForPrompt(null, 'agent'), '');
	});

	test('agent mode includes structural context and secondary commands', () => {
		const block = serializeWorkspaceProfileForPrompt(makeProfile(), 'agent');
		assert.ok(block.startsWith('<repository_context>'));
		assert.ok(block.includes('Project: trove_v1'));
		assert.ok(block.includes('react@18.3.1'));
		assert.ok(block.includes('File count: 12,345'));
		assert.ok(block.includes('Total LOC:  987,654'));
		assert.ok(block.includes('Architecture summary:'));
		assert.ok(block.includes('Other commands:'));
		assert.ok(block.includes('Build command: npm run compile'));
	});

	test('normal mode omits file count and architecture', () => {
		const block = serializeWorkspaceProfileForPrompt(makeProfile(), 'normal');
		assert.ok(block.includes('Test command:  npm run test-trove'));
		assert.ok(!block.includes('File count:'));
		assert.ok(!block.includes('Architecture summary:'));
		assert.ok(!block.includes('Other commands:'));
	});

	test('stale profile includes stale note', () => {
		const block = serializeWorkspaceProfileForPrompt(makeProfile({ isStale: true }), 'agent');
		assert.ok(block.includes('[stale — being refreshed in background]'));
	});

	test('long architecture summary is truncated at 400 chars', () => {
		const longSummary = 'x'.repeat(500);
		const block = serializeWorkspaceProfileForPrompt(makeProfile({ architectureSummary: longSummary }), 'agent');
		const body = profileBody(block);
		const archLine = body.split('\n').find(l => l.startsWith('Architecture summary:'))!;
		assert.ok(archLine.endsWith('…'));
		assert.ok(archLine.length <= 'Architecture summary: '.length + 400 + 1);
	});

	test('respects per-mode char cap', () => {
		for (const mode of ['agent', 'gather', 'normal'] as const) {
			const block = serializeWorkspaceProfileForPrompt(
				makeProfile({ architectureSummary: 'a'.repeat(10_000) }),
				mode,
			);
			const body = profileBody(block);
			const cap = REPO_PROFILE_MAX_CHARS[mode];
			assert.ok(
				body.length <= cap + '\n…[profile truncated]'.length,
				`${mode} body exceeded cap (${body.length} > ${cap})`,
			);
		}
	});

	test('omits purpose line when null', () => {
		const block = serializeWorkspaceProfileForPrompt(makeProfile({ projectPurpose: null }), 'normal');
		assert.ok(!block.includes('Purpose:'));
	});
});
