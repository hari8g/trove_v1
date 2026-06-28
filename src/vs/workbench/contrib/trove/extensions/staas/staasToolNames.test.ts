/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { availableTools } from '../../common/prompt/prompts.js';
import { filterStaasBuiltinToolNames, isStaasBuiltinToolName, STAAS_BUILTIN_TOOL_NAMES, DEFAULT_ORG_EXTENSIONS_ENABLED } from './staasToolNames.js';

suite('Trove - staasToolNames', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isStaasBuiltinToolName identifies org extension tools', () => {
		assert.strictEqual(isStaasBuiltinToolName('verify_security_compliance'), true);
		assert.strictEqual(isStaasBuiltinToolName('read_file'), false);
	});

	test('filterStaasBuiltinToolNames removes STaaS tools when disabled', () => {
		const names = ['read_file', 'verify_security_compliance', 'get_npm_impact'] as const;
		const filtered = filterStaasBuiltinToolNames(names, false);
		assert.deepStrictEqual(filtered, ['read_file']);
	});

	test('filterStaasBuiltinToolNames keeps all tools when enabled', () => {
		const names = ['read_file', ...STAAS_BUILTIN_TOOL_NAMES] as const;
		const filtered = filterStaasBuiltinToolNames(names, true);
		assert.strictEqual(filtered.length, names.length);
	});

	test('availableTools exposes STaaS tools by default when orgExtensions omitted', () => {
		const tools = availableTools('agent', undefined) ?? [];
		const toolNames = tools.map(t => t.name);
		assert.ok(toolNames.includes('verify_security_compliance'));
		assert.strictEqual(DEFAULT_ORG_EXTENSIONS_ENABLED, true);
	});

	test('availableTools hides STaaS tools in agent mode when orgExtensions is false', () => {
		const tools = availableTools('agent', undefined, { orgExtensions: false }) ?? [];
		const toolNames = tools.map(t => t.name);
		assert.ok(!toolNames.includes('verify_security_compliance'));
		assert.ok(toolNames.includes('read_file'));
	});

	test('availableTools exposes STaaS tools when orgExtensions is true', () => {
		const tools = availableTools('agent', undefined, { orgExtensions: true }) ?? [];
		const toolNames = tools.map(t => t.name);
		assert.ok(toolNames.includes('verify_security_compliance'));
		assert.ok(toolNames.includes('get_config_drift'));
	});
});
