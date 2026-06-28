/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { extractImports } from '../universalImportExtractor.js';

suite('Trove - universalImportExtractor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolveRelativePath preserves explicit .tsx extension', () => {
		const workspaceRoot = '/workspace';
		const filePath = join(workspaceRoot, 'src/App.tsx');
		const content = `import { Widget } from './Widget.tsx';`;

		const edges = extractImports(filePath, content, 'TypeScript', workspaceRoot);
		assert.strictEqual(edges.length, 1);
		assert.strictEqual(edges[0].resolvedFile, 'src/Widget.tsx');
	});
});
