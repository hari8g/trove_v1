/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { defaultModelsOfProvider, getModelCapabilities } from './modelCapabilities.js';
import { providerNames } from './troveSettingsTypes.js';

suite('Trove - modelCapabilities', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('xAI grok-2 and grok-3 resolve to distinct fallbacks', () => {
		const grok2 = getModelCapabilities('xAI', 'grok-2-latest', undefined);
		const grok3 = getModelCapabilities('xAI', 'grok-3-beta', undefined);

		assert.strictEqual(grok2.isUnrecognizedModel, false);
		assert.strictEqual(grok3.isUnrecognizedModel, false);
		assert.strictEqual(grok2.recognizedModelName, 'grok-2');
		assert.strictEqual(grok3.recognizedModelName, 'grok-3');
	});

	test('openRouter grok-2 resolves to grok-2 not grok-3', () => {
		const caps = getModelCapabilities('openRouter', 'x-ai/grok-2-1212', undefined);
		assert.strictEqual(caps.isUnrecognizedModel, false);
		assert.strictEqual(caps.recognizedModelName, 'grok-2');
	});

	test('llama4-maverick resolves to maverick profile not scout', () => {
		const caps = getModelCapabilities('openRouter', 'meta-llama/llama4-maverick', undefined);
		assert.strictEqual(caps.isUnrecognizedModel, false);
		assert.strictEqual(caps.recognizedModelName, 'llama4-maverick');
	});

	test('openRouter claude-sonnet-4 pricing is cheaper than claude-opus-4', () => {
		const sonnet = getModelCapabilities('openRouter', 'anthropic/claude-sonnet-4', undefined);
		const opus = getModelCapabilities('openRouter', 'anthropic/claude-opus-4', undefined);

		assert.strictEqual(sonnet.isUnrecognizedModel, false);
		assert.strictEqual(opus.isUnrecognizedModel, false);
		assert.ok(sonnet.cost.input < opus.cost.input);
		assert.ok(sonnet.cost.output < opus.cost.output);
	});

	test('each provider recognizes at least one default model exactly', () => {
		for (const providerName of providerNames) {
			const defaults = defaultModelsOfProvider[providerName];
			if (defaults.length === 0) {
				continue;
			}
			const caps = getModelCapabilities(providerName, defaults[0], undefined);
			assert.strictEqual(caps.isUnrecognizedModel, false, `${providerName} default ${defaults[0]} should be recognized`);
		}
	});

	test('provider fallbacks recognize representative model strings', () => {
		const samples: Array<[typeof providerNames[number], string]> = [
			['openAI', 'gpt-5.5-preview'],
			['anthropic', 'claude-sonnet-4-6-20250514'],
			['xAI', 'grok-3-mini-fast'],
			['gemini', 'gemini-2.5-pro-preview-05-06'],
			['deepseek', 'deepseek-reasoner'],
			['openRouter', 'anthropic/claude-3.5-sonnet'],
			['ollama', 'qwen2.5-coder:1.5b'],
		];

		for (const [providerName, modelName] of samples) {
			const caps = getModelCapabilities(providerName, modelName, undefined);
			assert.strictEqual(caps.isUnrecognizedModel, false, `${providerName}/${modelName} should fallback`);
		}
	});

	test('unknown models return isUnrecognizedModel without throwing', () => {
		const caps = getModelCapabilities('anthropic', 'totally-unknown-model-xyz', undefined);
		assert.strictEqual(caps.isUnrecognizedModel, true);
	});
});
