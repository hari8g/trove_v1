/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { LLMMessageService } from './sendLLMMessageService.js';
import { defaultGlobalSettings, defaultSettingsOfProvider } from './troveSettingsTypes.js';

suite('Trove - sendLLMMessageService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('_clearChannelHooks removes onAbort after request completes', () => {
		const emitters = new Map<string, Emitter<any>>();
		const channel = {
			call: () => Promise.resolve(undefined),
			listen: (eventName: string) => {
				const emitter = new Emitter<any>();
				emitters.set(eventName, emitter);
				return emitter.event;
			},
		};

		const service = new LLMMessageService(
			{ getChannel: () => channel } as any,
			{
				state: {
					settingsOfProvider: defaultSettingsOfProvider,
					globalSettings: defaultGlobalSettings,
				},
			} as any,
			{ getMCPTools: () => [] } as any,
		);

		const hooks = (service as any).llmMessageHooks as {
			onAbort: Record<string, () => void>;
		};

		const requestId = service.sendLLMMessage({
			messagesType: 'chatMessages',
			messages: [{ role: 'user', content: 'hello' }],
			modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
			onText: () => { },
			onFinalMessage: () => { },
			onError: () => { },
			onAbort: () => { },
		} as any);

		assert.ok(requestId);
		assert.ok(hooks.onAbort[requestId!]);

		emitters.get('onFinalMessage_sendLLMMessage')!.fire({
			requestId,
			fullText: 'done',
			fullReasoning: '',
			anthropicReasoning: null,
			usage: null,
		});

		assert.strictEqual(hooks.onAbort[requestId!], undefined);

		for (const emitter of emitters.values()) {
			emitter.dispose();
		}
		service.dispose();
	});
});
