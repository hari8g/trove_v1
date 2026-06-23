/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const TROVE_SRC_ROOT = path.join(process.cwd(), 'src/vs/workbench/contrib/trove');

function readTroveFile(relativePath: string): string {
	return fs.readFileSync(path.join(TROVE_SRC_ROOT, relativePath), 'utf8');
}

suite('Trove - riafIntegration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('core RIAF source files exist', () => {
		const required = [
			'common/riaf/riafTypes.ts',
			'common/riaf/riafPrompts.ts',
			'browser/riafAgentRunController.ts',
			'browser/riafAgentService.ts',
			'browser/analyseRepositoryAction.ts',
			'browser/react/src/sidebar-tsx/ContextDocPanel.tsx',
		];
		for (const file of required) {
			assert.ok(fs.existsSync(path.join(TROVE_SRC_ROOT, file)), `missing ${file}`);
		}
	});

	test('trove.contribution registers RIAF modules', () => {
		const contribution = readTroveFile('browser/trove.contribution.ts');
		assert.ok(contribution.includes("import './riafAgentService.js'"));
		assert.ok(contribution.includes("import './analyseRepositoryAction.js'"));
		assert.ok(contribution.includes("import './refreshRepoIndexAction.js'"));
	});

	test('analyse repository action is wired with keybinding', () => {
		const action = readTroveFile('browser/analyseRepositoryAction.ts');
		assert.ok(action.includes('TROVE_ANALYSE_REPOSITORY_ACTION_ID'));
		assert.ok(action.includes('KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK'));
		assert.ok(action.includes('IRiafAgentService'));
		assert.ok(action.includes('TROVE_VIEW_CONTAINER_ID'));
	});

	test('SidebarChat renders ContextDocPanel', () => {
		const sidebarChat = readTroveFile('browser/react/src/sidebar-tsx/SidebarChat.tsx');
		assert.ok(sidebarChat.includes("import { ContextDocPanel } from './ContextDocPanel.js'"));
		assert.ok(sidebarChat.includes('<ContextDocPanel />'));
	});

	test('React services expose IRiafAgentService', () => {
		const services = readTroveFile('browser/react/src/util/services.tsx');
		assert.ok(services.includes('IRiafAgentService'));
		assert.ok(services.includes("accessor.get(IRiafAgentService)"));
	});

	test('ContextDocPanel uses riaf service and open command', () => {
		const panel = readTroveFile('browser/react/src/sidebar-tsx/ContextDocPanel.tsx');
		assert.ok(panel.includes("'IRiafAgentService'"));
		assert.ok(panel.includes('Analyse Repo'));
		assert.ok(panel.includes("'vscode.open'"));
		assert.ok(panel.includes('expectedOutputFileName'));
		assert.ok(panel.includes('Tag in chat: @'));
	});

	test('riaf run controller uses IFileService for completion detection', () => {
		const controller = readTroveFile('browser/riafAgentRunController.ts');
		assert.ok(controller.includes('_files.exists'));
		const service = readTroveFile('browser/riafAgentService.ts');
		assert.ok(service.includes('RiafAgentRunController'));
		assert.ok(!controller.includes('filesChanged.some'));
	});
});
