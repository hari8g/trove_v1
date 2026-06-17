/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProviderName } from './troveSettingsTypes.js';

export const isAnthropicRoutedModel = (providerName: ProviderName, modelName: string): boolean => {
	const lower = modelName.toLowerCase();
	if (!lower.includes('claude')) {
		return false;
	}
	return providerName === 'openRouter'
		|| providerName === 'awsBedrock'
		|| providerName === 'liteLLM'
		|| providerName === 'microsoftAzure';
};

type OpenAIWireMessage = { role: string; content?: unknown };

/** OpenRouter/Bedrock Claude over the OpenAI wire format needs system content blocks with cache_control. */
export const applyRoutedAnthropicPromptCache = (
	messages: OpenAIWireMessage[],
	separateSystemMessage: string | undefined,
	enablePromptCache: boolean,
	providerName: ProviderName,
	modelName: string,
): OpenAIWireMessage[] => {
	if (!enablePromptCache || !isAnthropicRoutedModel(providerName, modelName)) {
		return messages;
	}

	const result = [...messages];
	const cacheBlock = (text: string) => ([{
		type: 'text',
		text,
		cache_control: { type: 'ephemeral' },
	}]);

	if (separateSystemMessage) {
		result.unshift({ role: 'system', content: cacheBlock(separateSystemMessage) });
		return result;
	}

	if (result[0]?.role === 'system' && typeof result[0].content === 'string') {
		result[0] = { role: 'system', content: cacheBlock(result[0].content) };
	}

	return result;
};
