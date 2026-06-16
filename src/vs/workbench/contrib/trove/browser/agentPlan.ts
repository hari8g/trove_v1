/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ChatMessage, PlanMessage } from '../common/chatThreadServiceTypes.js';
import { ChatMode, ModelSelection, ModelSelectionOptions, OverridesOfModel } from '../common/troveSettingsTypes.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { ToolCallParams, ToolName } from '../common/toolsServiceTypes.js';

export const PLAN_OUTPUT_TOKEN_CAP = 300;

const PLAN_SYSTEM_MESSAGE = [
	'You help a coding agent plan its work before using tools.',
	'In 3-7 bullet points, list the concrete steps you will take to complete the user task.',
	'Use infinitive verb form (e.g. "Read Sidebar.tsx", "Create Spinner component").',
	'Output only the bullet list — no intro, no prose, no markdown headings.',
	'One step per line, prefixed with "- ".',
].join('\n');

export const parsePlanBulletItems = (text: string): { text: string; status: 'pending' }[] => {
	const items: { text: string; status: 'pending' }[] = [];
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
		const text = (match?.[1] ?? line).trim();
		if (!text || /^done\.?$/i.test(text)) continue;
		items.push({ text, status: 'pending' });
		if (items.length >= 7) break;
	}
	return items;
};

const withPlanTokenCap = (
	overridesOfModel: OverridesOfModel | undefined,
	modelSelection: ModelSelection,
): OverridesOfModel => {
	const { providerName, modelName } = modelSelection;
	return {
		...(overridesOfModel ?? {}),
		[providerName]: {
			...(overridesOfModel?.[providerName] ?? {}),
			[modelName]: {
				...(overridesOfModel?.[providerName]?.[modelName] ?? {}),
				reservedOutputTokenSpace: PLAN_OUTPUT_TOKEN_CAP,
			},
		},
	} as OverridesOfModel;
};

const summarizeUserTask = (chatMessages: ChatMessage[]): string => {
	for (let i = chatMessages.length - 1; i >= 0; i--) {
		const m = chatMessages[i];
		if (m.role === 'user') {
			const text = m.displayContent?.trim() || m.content?.trim();
			if (text) return text.slice(0, 2000);
		}
	}
	return '(No user message found)';
};

export const generateAgentPlan = async (opts: {
	llmMessageService: ILLMMessageService;
	convertToLLMMessageService: IConvertToLLMMessageService;
	modelSelection: ModelSelection;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	chatMode: ChatMode;
	chatMessages: ChatMessage[];
}): Promise<PlanMessage | null> => {
	const userTask = summarizeUserTask(opts.chatMessages);
	const { messages, separateSystemMessage } = opts.convertToLLMMessageService.prepareLLMSimpleMessages({
		simpleMessages: [{ role: 'user', content: `User task:\n${userTask}\n\nList the steps you will take.` }],
		systemMessage: PLAN_SYSTEM_MESSAGE,
		modelSelection: opts.modelSelection,
		featureName: 'Chat',
	});

	const planOverrides = withPlanTokenCap(opts.overridesOfModel, opts.modelSelection);

	let fullText = '';
	try {
		fullText = await new Promise<string>((resolve, reject) => {
			const requestId = opts.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				chatMode: opts.chatMode,
				messages,
				separateSystemMessage,
				modelSelection: opts.modelSelection,
				modelSelectionOptions: opts.modelSelectionOptions,
				overridesOfModel: planOverrides,
				logging: { loggingName: 'Agent Plan' },
				onText: () => { },
				onFinalMessage: ({ fullText: text }) => resolve(text),
				onError: ({ message }) => reject(new Error(message)),
				onAbort: () => reject(new Error('Plan generation aborted')),
			});
			if (!requestId) {
				reject(new Error('Could not start plan generation'));
			}
		});
	} catch {
		return null;
	}

	const items = parsePlanBulletItems(fullText);
	if (items.length === 0) {
		return null;
	}
	return { role: 'plan', items };
};

export const getToolSummaryForPlanMatch = (toolName: ToolName, toolParams: ToolCallParams<ToolName>): string => {
	const parts = [toolName];
	const params = toolParams as Record<string, unknown>;
	const uri = params.uri;
	if (uri instanceof URI) {
		parts.push(uri.fsPath);
	} else if (typeof uri === 'string') {
		parts.push(uri);
	}
	if (typeof params.query === 'string') parts.push(params.query);
	if (typeof params.query_regex === 'string') parts.push(params.query_regex);
	if (typeof params.command === 'string') parts.push(params.command);
	return parts.join(' ').toLowerCase();
};

const textMatchesTool = (planText: string, toolSummary: string): boolean => {
	const plan = planText.toLowerCase();
	const tool = toolSummary.toLowerCase();
	if (plan.includes(tool) || tool.includes(plan)) return true;
	const tokens = tool.split(/[\s/\\._-]+/).filter(t => t.length > 3);
	return tokens.some(t => plan.includes(t));
};

export const markPlanItemDoneForTool = (plan: PlanMessage, toolName: ToolName, toolParams: ToolCallParams<ToolName>): PlanMessage => {
	const toolSummary = getToolSummaryForPlanMatch(toolName, toolParams);
	const items = plan.items.map(item => ({ ...item }));

	let idx = items.findIndex(item => item.status === 'pending' && textMatchesTool(item.text, toolSummary));
	if (idx === -1) {
		idx = items.findIndex(item => item.status === 'pending');
	}
	if (idx !== -1) {
		items[idx] = { ...items[idx], status: 'done' };
	}
	return { role: 'plan', items };
};

export const skipRemainingPlanItems = (plan: PlanMessage): PlanMessage => ({
	role: 'plan',
	items: plan.items.map(item => item.status === 'pending' ? { ...item, status: 'skipped' } : item),
});

export const findLatestPlanMessageIdx = (messages: ChatMessage[]): number => {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'plan') return i;
	}
	return -1;
};
