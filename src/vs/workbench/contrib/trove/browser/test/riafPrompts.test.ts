/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildRiafAgentPrompt } from '../../common/riaf/riafPrompts.js';
import { buildRiafConfig, deriveRiafOutputFileName } from '../../common/riaf/riafTypes.js';

const EXPECTED_SECTIONS = [
	'## 1. What This Repository Does',
	'## 2. Architecture Overview',
	'## 3. File Responsibility Map',
	'## 4. Module Wiring & Data Flow',
	'## 5. External Dependencies',
	'## 6. Entry Points & Bootstrap Sequence',
	'## 7. Key Patterns & Conventions',
	'## 8. Implementation Cookbook',
	'## 9. Configuration & Environment',
	'## 10. Testing',
	'## 11. Known Issues & TODOs',
	'## 12. Quick Reference',
];

suite('Trove - riafOutputFileName', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('deriveRiafOutputFileName uses repo folder name', () => {
		assert.strictEqual(deriveRiafOutputFileName('trove_v1'), 'trove_v1_context.md');
		assert.strictEqual(deriveRiafOutputFileName('My Project'), 'my_project_context.md');
	});

	test('deriveRiafOutputFileName falls back for empty titles', () => {
		assert.strictEqual(deriveRiafOutputFileName('   '), 'repo_context.md');
	});
});

suite('Trove - riafPrompts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildRiafAgentPrompt includes workspace root and derived output path', () => {
		const root = '/Users/dev/trove_v1';
		const config = buildRiafConfig('trove_v1');
		const prompt = buildRiafAgentPrompt(root, 'trove_v1', config);
		assert.ok(prompt.includes(root));
		assert.ok(prompt.includes(`${root}/trove_v1_context.md`));
	});

	test('buildRiafAgentPrompt includes maxFiles cap', () => {
		const config = buildRiafConfig('trove_v1', { maxFiles: 42 });
		const prompt = buildRiafAgentPrompt('/workspace', 'trove_v1', config);
		assert.ok(prompt.includes('Read up to 42 files total'));
	});

	test('buildRiafAgentPrompt excludes test files by default', () => {
		const config = buildRiafConfig('trove_v1');
		const prompt = buildRiafAgentPrompt('/workspace', 'trove_v1', config);
		assert.ok(prompt.includes('You may skip test files'));
		assert.ok(!prompt.includes('Include test files in your analysis'));
	});

	test('buildRiafAgentPrompt includes test files when configured', () => {
		const config = buildRiafConfig('trove_v1', { includeTests: true });
		const prompt = buildRiafAgentPrompt('/workspace', 'trove_v1', config);
		assert.ok(prompt.includes('Include test files in your analysis.'));
	});

	test('buildRiafAgentPrompt instructs create then rewrite for output', () => {
		const config = buildRiafConfig('trove_v1');
		const prompt = buildRiafAgentPrompt('/workspace', 'trove_v1', config);
		assert.ok(prompt.includes('create_file_or_folder'));
		assert.ok(prompt.includes('rewrite_file'));
	});

	test('buildRiafAgentPrompt embeds all 12 template sections', () => {
		const config = buildRiafConfig('trove_v1');
		const prompt = buildRiafAgentPrompt('/workspace', 'trove_v1', config);
		for (const heading of EXPECTED_SECTIONS) {
			assert.ok(prompt.includes(heading), `missing section: ${heading}`);
		}
	});

	test('buildRiafAgentPrompt uses repo-specific document title', () => {
		const config = buildRiafConfig('trove_v1');
		const prompt = buildRiafAgentPrompt('/workspace', 'trove_v1', config);
		assert.ok(prompt.includes('# trove_v1_context.md'));
		assert.ok(!prompt.includes('# TROVE_CONTEXT.md'));
	});

	test('buildRiafAgentPrompt allows custom output filename override', () => {
		const config = buildRiafConfig('trove_v1', { outputFileName: 'CUSTOM_CONTEXT.md' });
		const prompt = buildRiafAgentPrompt('/workspace', 'trove_v1', config);
		assert.ok(prompt.includes('/workspace/CUSTOM_CONTEXT.md'));
		assert.ok(prompt.includes('CUSTOM_CONTEXT.md does not exist yet'));
	});
});
