/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ChatMessage, PlanMessage } from '../common/chatThreadServiceTypes.js';
import { ChatMode, ModelSelection, ModelSelectionOptions, OverridesOfModel } from '../common/troveSettingsTypes.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import type { IUsageMeteringService } from './usageMeteringService.js';
import { ToolCallParams, ToolName } from '../common/toolsServiceTypes.js';

export const PLAN_OUTPUT_TOKEN_CAP = 300;
export const PLAN_GENERATION_TIMEOUT_MS = 45_000;

const PLAN_SYSTEM_MESSAGE = [
	'You help a coding agent plan its work before using tools.',
	'In 3-7 bullet points, list the concrete steps you will take to complete the user task.',
	'Use infinitive verb form (e.g. "Read Sidebar.tsx", "Create Spinner component").',
	'For styling/theming or multi-section updates to one file, plan ONE read and ONE combined edit — never multiple separate edits to the same file.',
	'Output only the bullet list — no intro, no prose, no markdown headings.',
	'One step per line, prefixed with "- ".',
].join('\n');

const READ_VERBS = ['read', 'open', 'inspect', 'view', 'look', 'examine', 'review', 'load'];
const SEARCH_VERBS = ['locate', 'find', 'search', 'identify', 'discover', 'resolve'];
const EDIT_VERBS = ['add', 'edit', 'write', 'modify', 'update', 'insert', 'change', 'fix', 'comment', 'append', 'prepend', 'replace', 'create'];
const SAVE_VERBS = ['save', 'persist', 'commit', 'apply'];
const VERIFY_VERBS = ['verify', 'confirm', 'check', 'test', 'ensure', 'validate', 'run'];
const CREATE_VERBS = ['create', 'add', 'make', 'generate', 'scaffold'];
const RUN_VERBS = ['run', 'execute', 'start', 'launch', 'test', 'build', 'install'];

type ToolCategory = 'read' | 'search' | 'edit' | 'create' | 'run' | 'delete' | 'other';

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
			const text = m.content?.trim() || m.displayContent?.trim();
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
	threadId: string;
	usageMeteringService?: IUsageMeteringService;
}): Promise<PlanMessage | null> => {
	const userTask = summarizeUserTask(opts.chatMessages);
	const { messages, separateSystemMessage } = opts.convertToLLMMessageService.prepareLLMSimpleMessages({
		simpleMessages: [{ role: 'user', content: `User task:\n${userTask}\n\nList the steps you will take.` }],
		systemMessage: PLAN_SYSTEM_MESSAGE,
		modelSelection: opts.modelSelection,
		featureName: 'Chat',
	});

	const planOverrides = withPlanTokenCap(opts.overridesOfModel, opts.modelSelection);

	const { reasoningCapabilities } = getModelCapabilities(
		opts.modelSelection.providerName,
		opts.modelSelection.modelName,
		planOverrides,
	);
	const reasoningSlider = reasoningCapabilities === false ? undefined : reasoningCapabilities?.reasoningSlider;
	const defaultBudget = reasoningSlider?.type === 'budget_slider' ? reasoningSlider.default : undefined;
	const effectiveBudget = opts.modelSelectionOptions?.reasoningBudget ?? defaultBudget;
	const planModelOptions: ModelSelectionOptions = {
		...opts.modelSelectionOptions,
		...(effectiveBudget ? { reasoningBudget: Math.min(effectiveBudget, 2048) } : {}),
	};

	let fullText = '';
	try {
		fullText = await Promise.race([
			new Promise<string>((resolve, reject) => {
				const requestId = opts.llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode: opts.chatMode,
					messages,
					separateSystemMessage,
					modelSelection: opts.modelSelection,
					modelSelectionOptions: planModelOptions,
					overridesOfModel: planOverrides,
					logging: { loggingName: 'Agent Plan' },
					onText: () => { },
					onFinalMessage: ({ fullText: text, usage }) => {
						if (usage && opts.usageMeteringService) {
							opts.usageMeteringService.recordTurn({
								usage,
								providerName: opts.modelSelection.providerName,
								modelName: opts.modelSelection.modelName,
								threadId: opts.threadId,
							});
						}
						resolve(text);
					},
					onError: ({ message }) => reject(new Error(message)),
					onAbort: () => reject(new Error('Plan generation aborted')),
				});
				if (!requestId) {
					reject(new Error('Could not start plan generation'));
				}
			}),
			new Promise<string>((_, reject) => {
				setTimeout(() => reject(new Error('Plan generation timed out')), PLAN_GENERATION_TIMEOUT_MS);
			}),
		]);
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

const basenameFromToolParams = (toolParams: ToolCallParams<ToolName>): string | undefined => {
	const params = toolParams as Record<string, unknown>;
	const uri = params.uri;
	if (uri instanceof URI) {
		return uri.fsPath.replace(/\\/g, '/').split('/').pop();
	}
	if (typeof uri === 'string') {
		return uri.replace(/\\/g, '/').split('/').pop();
	}
	return undefined;
};

const planMentionsFile = (planText: string, basename: string): boolean => {
	const plan = planText.toLowerCase();
	const file = basename.toLowerCase();
	if (plan.includes(file)) return true;
	const stem = file.replace(/\.[^.]+$/, '');
	return stem.length > 2 && plan.includes(stem);
};

const planHasVerb = (planText: string, verbs: string[]): boolean => {
	const plan = planText.toLowerCase();
	return verbs.some(v => plan.includes(v));
};

const getToolCategory = (toolName: ToolName): ToolCategory => {
	switch (toolName) {
		case 'read_file':
		case 'ls_dir':
		case 'get_dir_tree':
		case 'read_lint_errors':
		case 'search_in_file':
			return 'read';
		case 'search_pathnames_only':
		case 'search_for_files':
		case 'search_codebase':
		case 'search_web':
			return 'search';
		case 'edit_file':
		case 'rewrite_file':
			return 'edit';
		case 'create_file_or_folder':
			return 'create';
		case 'delete_file_or_folder':
			return 'delete';
		case 'run_command':
		case 'run_persistent_command':
		case 'open_persistent_terminal':
		case 'kill_persistent_terminal':
			return 'run';
		default:
			return 'other';
	}
};

const textMatchesTool = (planText: string, toolSummary: string): boolean => {
	const plan = planText.toLowerCase();
	const tool = toolSummary.toLowerCase();
	if (plan.includes(tool) || tool.includes(plan)) return true;
	const tokens = tool.split(/[\s/\\._-]+/).filter(t => t.length > 3);
	return tokens.some(t => plan.includes(t));
};

const scorePlanItemForTool = (
	planText: string,
	category: ToolCategory,
	toolSummary: string,
	basename?: string,
): number => {
	const plan = planText.toLowerCase();
	let score = 0;

	if (basename && planMentionsFile(planText, basename)) {
		score += 12;
	}

	const categoryVerbs: Record<ToolCategory, string[]> = {
		read: READ_VERBS,
		search: SEARCH_VERBS,
		edit: [...EDIT_VERBS, ...SAVE_VERBS],
		create: CREATE_VERBS,
		run: [...RUN_VERBS, ...VERIFY_VERBS],
		delete: ['delete', 'remove'],
		other: [],
	};
	for (const verb of categoryVerbs[category]) {
		if (plan.includes(verb)) score += 4;
	}

	const tokens = toolSummary.split(/[\s/\\._-]+/).filter(t => t.length > 3);
	score += tokens.filter(t => plan.includes(t)).length * 2;

	if (textMatchesTool(planText, toolSummary)) {
		score += 3;
	}

	return score;
};

const firstPendingIndex = (items: PlanMessage['items']): number =>
	items.findIndex(item => item.status === 'pending');

export const markPlanItemDoneForTool = (plan: PlanMessage, toolName: ToolName, toolParams: ToolCallParams<ToolName>): PlanMessage => {
	const toolSummary = getToolSummaryForPlanMatch(toolName, toolParams);
	const basename = basenameFromToolParams(toolParams);
	const category = getToolCategory(toolName);
	const items = plan.items.map(item => ({ ...item }));
	const markIndices = new Set<number>();

	if (category === 'edit') {
		for (let i = 0; i < items.length; i++) {
			if (items[i].status !== 'pending') continue;
			const text = items[i].text;
			const fileMatch = !basename || planMentionsFile(text, basename);
			const editMatch = planHasVerb(text, EDIT_VERBS) || planHasVerb(text, SAVE_VERBS);
			if (fileMatch && editMatch) {
				markIndices.add(i);
			}
		}
	}

	if (category === 'run' && basename) {
		for (let i = 0; i < items.length; i++) {
			if (items[i].status !== 'pending') continue;
			const text = items[i].text;
			if (planMentionsFile(text, basename) && planHasVerb(text, VERIFY_VERBS)) {
				markIndices.add(i);
			}
		}
	}

	if (markIndices.size === 0) {
		let bestIdx = -1;
		let bestScore = 0;
		for (let i = 0; i < items.length; i++) {
			if (items[i].status !== 'pending') continue;
			const score = scorePlanItemForTool(items[i].text, category, toolSummary, basename);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}

		if (bestIdx !== -1 && bestScore >= 4) {
			markIndices.add(bestIdx);
		} else {
			const looseIdx = items.findIndex(item => item.status === 'pending' && textMatchesTool(item.text, toolSummary));
			const idx = looseIdx !== -1 ? looseIdx : firstPendingIndex(items);
			if (idx !== -1) markIndices.add(idx);
		}
	}

	for (const idx of markIndices) {
		items[idx] = { ...items[idx], status: 'done' };
	}
	return { role: 'plan', items };
};

export const completeRemainingPlanItems = (plan: PlanMessage): PlanMessage => ({
	role: 'plan',
	items: plan.items.map(item => item.status === 'pending' ? { ...item, status: 'done' } : item),
});

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
