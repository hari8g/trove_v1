/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { defaultGlobalSettings } from './troveSettingsTypes.js';
import { DEFAULT_ORG_EXTENSIONS_ENABLED } from '../extensions/staas/staasToolNames.js';

suite('Trove - troveSettingsService migration defaults', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('llmStreamStallTimeoutMs migration uses defaultGlobalSettings', () => {
		const migratedGlobalSettings = { ...defaultGlobalSettings };
		delete (migratedGlobalSettings as Partial<typeof defaultGlobalSettings>).llmStreamStallTimeoutMs;

		if (migratedGlobalSettings.llmStreamStallTimeoutMs === undefined) {
			migratedGlobalSettings.llmStreamStallTimeoutMs = defaultGlobalSettings.llmStreamStallTimeoutMs;
		}

		assert.strictEqual(
			migratedGlobalSettings.llmStreamStallTimeoutMs,
			defaultGlobalSettings.llmStreamStallTimeoutMs,
		);
		assert.strictEqual(migratedGlobalSettings.llmStreamStallTimeoutMs, 120_000);
	});

	test('orgExtensions defaults to enabled', () => {
		assert.strictEqual(defaultGlobalSettings.orgExtensions, DEFAULT_ORG_EXTENSIONS_ENABLED);
		assert.strictEqual(defaultGlobalSettings.orgExtensions, true);
	});

	test('org extension indexer settings default to STaaS literals', () => {
		assert.ok(defaultGlobalSettings.orgExtensionNpmScopes.includes('@mobilitystore'));
		assert.ok(defaultGlobalSettings.orgExtensionConfigServerDirs.includes('staas-cloud-config-service-dev'));
	});
});
