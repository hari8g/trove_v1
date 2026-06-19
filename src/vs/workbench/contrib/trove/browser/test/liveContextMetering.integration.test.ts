/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { REPO_PROFILE_MAX_CHARS } from '../../common/repoIntelligenceTypes.js';
import { serializeWorkspaceProfileForPrompt } from '../../common/prompt/prompts.js';
import type { WorkspaceProfile } from '../../common/repoIntelligenceTypes.js';

const TROVE_SRC_ROOT = path.join(process.cwd(), 'src/vs/workbench/contrib/trove');

function readTroveFile(relativePath: string): string {
	return fs.readFileSync(path.join(TROVE_SRC_ROOT, relativePath), 'utf8');
}

function sampleProfile(overrides: Partial<WorkspaceProfile> = {}): WorkspaceProfile {
	return {
		workspaceRoot: '/Users/dev/trove_v1',
		lastScannedAt: Date.now(),
		languageStack: ['typescript'],
		frameworks: [{ name: 'react', version: '18.3.1', confidence: 'high' }],
		packageManagers: ['npm'],
		buildCommands: [{ command: 'npm run compile', purpose: 'build', confidence: 'high', source: 'package.json' }],
		testCommands: [{ command: 'npm run test-trove', purpose: 'test', confidence: 'high', source: 'package.json' }],
		lintCommands: [],
		typecheckCommands: [],
		projectPurpose: 'Agentic IDE',
		architectureSummary: 'Browser + electron-main monorepo.',
		fileCount: 8000,
		totalLoc: 400_000,
		isStale: false,
		...overrides,
	};
}

suite('Trove - liveContextMetering integration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('Live Context wiring', () => {
		test('convertToLLMMessageService refreshes stale profiles in background', () => {
			const src = readTroveFile('browser/convertToLLMMessageService.ts');
			assert.ok(src.includes('repoProfile?.isStale'));
			assert.ok(src.includes('refreshProfile'));
			assert.ok(src.includes('.catch(() => { /* non-fatal */ })'));
		});

		test('chat_systemMessage uses mode-aware profile serializer', () => {
			const prompts = readTroveFile('common/prompt/prompts.ts');
			assert.ok(prompts.includes('serializeWorkspaceProfileForPrompt(repoProfile, profileMode)'));
			assert.ok(prompts.includes('REPO_PROFILE_MAX_CHARS'));
		});

		test('agent mode profile includes test command for orientation', () => {
			const block = serializeWorkspaceProfileForPrompt(sampleProfile(), 'agent');
			assert.ok(block.includes('Test command:  npm run test-trove'));
			assert.ok(block.includes('react@18.3.1'));
		});

		test('normal mode profile omits architecture and respects cap', () => {
			const block = serializeWorkspaceProfileForPrompt(
				sampleProfile({ architectureSummary: 'x'.repeat(10_000) }),
				'normal',
			);
			assert.ok(!block.includes('Architecture summary:'));
			const body = block.replace(/^<repository_context>\n/, '').replace(/\n<\/repository_context>$/, '');
			assert.ok(body.length <= REPO_PROFILE_MAX_CHARS.normal + '\n…[profile truncated]'.length);
		});

		test('stale profile includes refresh note', () => {
			const block = serializeWorkspaceProfileForPrompt(sampleProfile({ isStale: true }), 'agent');
			assert.ok(block.includes('[stale — being refreshed in background]'));
		});

		test('null profile serializes to empty string', () => {
			assert.strictEqual(serializeWorkspaceProfileForPrompt(null, 'agent'), '');
		});
	});

	suite('Usage metering wiring', () => {
		test('core metering files exist and are registered', () => {
			const required = [
				'common/llmPricing.ts',
				'common/usageMeteringTypes.ts',
				'browser/usageMeteringService.ts',
				'browser/react/src/trove-settings-tsx/UsageDashboard.tsx',
			];
			for (const file of required) {
				assert.ok(fs.existsSync(path.join(TROVE_SRC_ROOT, file)), `missing ${file}`);
			}
			const contribution = readTroveFile('browser/trove.contribution.ts');
			assert.ok(contribution.includes("import './usageMeteringService.js'"));
		});

		test('chatThreadService records turns and enforces budget', () => {
			const src = readTroveFile('browser/chatThreadService.ts');
			assert.ok(src.includes('IUsageMeteringService'));
			assert.ok(src.includes('_usageMeteringService.recordTurn'));
			assert.ok(src.includes('getBudgetLimitUSD()'));
			assert.ok(src.includes('Budget of $'));
		});

		test('agent plan generation records metering turns', () => {
			const plan = readTroveFile('browser/agentPlan.ts');
			const chat = readTroveFile('browser/chatThreadService.ts');
			assert.ok(plan.includes('usageMeteringService.recordTurn'));
			assert.ok(chat.includes('usageMeteringService: this._usageMeteringService'));
		});

		test('Settings exposes Usage tab and dashboard', () => {
			const settings = readTroveFile('browser/react/src/trove-settings-tsx/Settings.tsx');
			const services = readTroveFile('browser/react/src/util/services.tsx');
			assert.ok(settings.includes("'usage'"));
			assert.ok(settings.includes('<UsageDashboard />'));
			assert.ok(services.includes('IUsageMeteringService'));
		});

		test('storage keys defined for metering session and budget', () => {
			const keys = readTroveFile('common/storageKeys.ts');
			assert.ok(keys.includes('STORAGE_KEY_METERING_SESSION'));
			assert.ok(keys.includes('STORAGE_KEY_METERING_BUDGET'));
		});
	});
});
