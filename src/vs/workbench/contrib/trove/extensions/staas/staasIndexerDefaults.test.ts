/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DEFAULT_ORG_EXTENSION_CONFIG_SERVER_DIRS,
	DEFAULT_ORG_EXTENSION_NPM_SCOPES,
	resolveOrgExtensionIndexerOptions,
} from './staasIndexerDefaults.js';
import { defaultGlobalSettings } from '../../common/troveSettingsTypes.js';
import { indexConfigEnvironments } from '../../electron-main/repoIntelligence/configEnvIndexer.js';

suite('Trove - staasIndexerDefaults', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolveOrgExtensionIndexerOptions falls back to STaaS defaults', () => {
		const resolved = resolveOrgExtensionIndexerOptions(undefined);
		assert.deepStrictEqual(resolved.npmScopes, [...DEFAULT_ORG_EXTENSION_NPM_SCOPES]);
		assert.deepStrictEqual(resolved.configServerDirs, [...DEFAULT_ORG_EXTENSION_CONFIG_SERVER_DIRS]);
	});

	test('resolveOrgExtensionIndexerOptions preserves custom overrides', () => {
		const resolved = resolveOrgExtensionIndexerOptions({
			npmScopes: ['@custom'],
			configServerDirs: ['my-config-server'],
		});
		assert.deepStrictEqual(resolved.npmScopes, ['@custom']);
		assert.deepStrictEqual(resolved.configServerDirs, ['my-config-server']);
	});

	test('defaultGlobalSettings uses org-extension indexer defaults', () => {
		assert.deepStrictEqual(defaultGlobalSettings.orgExtensionNpmScopes, [...DEFAULT_ORG_EXTENSION_NPM_SCOPES]);
		assert.deepStrictEqual(defaultGlobalSettings.orgExtensionConfigServerDirs, [...DEFAULT_ORG_EXTENSION_CONFIG_SERVER_DIRS]);
	});

	test('indexConfigEnvironments scans custom config server directories', () => {
		const tempDir = join(tmpdir(), `trove-config-defaults-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const customDir = join(tempDir, 'custom-config-root');
			mkdirSync(customDir, { recursive: true });
			writeFileSync(join(customDir, 'billing-prod.yml'), 'service:\n  name: billing\n');

			const result = indexConfigEnvironments(tempDir, { configServerDirs: ['custom-config-root'] });
			assert.ok(result.fileCount >= 1);
			assert.ok(result.properties.some(p => p.serviceName.length > 0));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
