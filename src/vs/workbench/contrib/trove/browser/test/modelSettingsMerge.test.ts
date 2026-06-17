/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { deepClone } from '../../../../../base/common/objects.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { defaultModelsOfProvider } from '../../common/modelCapabilities.js';
import {
	modelsWithSwappedInNewModels,
	pruneStaleOverridesOfModel,
	stateWithMergedDefaultModels,
	validatedModelState,
} from '../../common/troveSettingsService.js';
import { defaultGlobalSettings, defaultOverridesOfModel, defaultSettingsOfProvider, TroveStatefulModelInfo } from '../../common/troveSettingsTypes.js';

const baseSettingsState = () => ({
	settingsOfProvider: deepClone(defaultSettingsOfProvider),
	modelSelectionOfFeature: { Chat: null, 'Ctrl+K': null, Autocomplete: null, Apply: null, SCM: null },
	optionsOfModelSelection: { Chat: {}, 'Ctrl+K': {}, Autocomplete: {}, Apply: {}, SCM: {} },
	overridesOfModel: deepClone(defaultOverridesOfModel),
	globalSettings: deepClone(defaultGlobalSettings),
	mcpUserStateOfName: {},
});

suite('Trove - modelSettingsMerge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('modelsWithSwappedInNewModels prunes removed defaults', () => {
		const existingModels: TroveStatefulModelInfo[] = [
			{ modelName: 'gpt-5.5', type: 'default', isHidden: false },
			{ modelName: 'gpt-4.1', type: 'default', isHidden: false },
			{ modelName: 'gpt-5.4', type: 'default', isHidden: true },
		];
		const merged = modelsWithSwappedInNewModels({
			existingModels,
			models: defaultModelsOfProvider.openAI.slice(),
			type: 'default',
		});
		const names = merged.map(m => m.modelName);
		assert.deepStrictEqual(names, defaultModelsOfProvider.openAI);
		assert.strictEqual(merged.find(m => m.modelName === 'gpt-5.5')?.isHidden, false);
		assert.strictEqual(merged.find(m => m.modelName === 'gpt-5.4')?.isHidden, true);
		assert.strictEqual(merged.some(m => m.modelName === 'gpt-4.1'), false);
	});

	test('modelsWithSwappedInNewModels preserves custom models', () => {
		const existingModels: TroveStatefulModelInfo[] = [
			{ modelName: 'gpt-5.5', type: 'default', isHidden: false },
			{ modelName: 'gpt-4.1', type: 'custom', isHidden: false },
		];
		const merged = modelsWithSwappedInNewModels({
			existingModels,
			models: defaultModelsOfProvider.openAI.slice(),
			type: 'default',
		});
		assert.strictEqual(merged.some(m => m.modelName === 'gpt-4.1' && m.type === 'custom'), true);
	});

	test('stateWithMergedDefaultModels drops old anthropic defaults', () => {
		const state = validatedModelState(baseSettingsState());
		state.settingsOfProvider.anthropic.models = [
			...defaultModelsOfProvider.anthropic.map(modelName => ({ modelName, type: 'default' as const, isHidden: false })),
			{ modelName: 'claude-3-7-sonnet-latest', type: 'default', isHidden: false },
			{ modelName: 'claude-3-5-haiku-latest', type: 'default', isHidden: false },
		];

		const merged = stateWithMergedDefaultModels(state);
		const names = merged.settingsOfProvider.anthropic.models.map(m => m.modelName);
		assert.deepStrictEqual(names, defaultModelsOfProvider.anthropic);
	});

	test('validatedModelState remaps feature selection when model is pruned', () => {
		const base = validatedModelState({
			...baseSettingsState(),
			modelSelectionOfFeature: {
				Chat: { providerName: 'openAI', modelName: 'gpt-4.1' },
				'Ctrl+K': null,
				Autocomplete: null,
				Apply: null,
				SCM: null,
			},
		});

		base.settingsOfProvider.openAI._didFillInProviderSettings = true;
		base.settingsOfProvider.openAI.apiKey = 'test-key';

		const validated = validatedModelState(base);
		assert.notStrictEqual(validated.modelSelectionOfFeature.Chat?.modelName, 'gpt-4.1');
		assert.strictEqual(validated.modelSelectionOfFeature.Chat?.providerName, 'openAI');
	});

	test('pruneStaleOverridesOfModel removes overrides for inactive models', () => {
		const state = validatedModelState({
			...baseSettingsState(),
			overridesOfModel: {
				...deepClone(defaultOverridesOfModel),
				openAI: {
					'gpt-4.1': { contextWindow: 1000 },
					'gpt-5.5': { contextWindow: 2000 },
				},
			},
		});

		const pruned = pruneStaleOverridesOfModel(state);
		assert.strictEqual(pruned.openAI?.['gpt-4.1'], undefined);
		assert.strictEqual(pruned.openAI?.['gpt-5.5']?.contextWindow, 2000);
	});
});
