/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { isABuiltinToolName } from '../common/prompt/prompts.js';
import { RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { BuiltinToolName, ToolName } from '../common/toolsServiceTypes.js';
import { ChatMode, ModelSelection, ModelSelectionOptions, OverridesOfModel } from '../common/troveSettingsTypes.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';

export const READ_ONLY_BATCH_TOOL_NAMES: ReadonlySet<BuiltinToolName> = new Set([
	'read_file',
	'ls_dir',
	'get_dir_tree',
	'search_pathnames_only',
	'search_for_files',
	'search_in_file',
	'search_codebase',
]);

export const MAX_ADDITIONAL_READ_TOOLS = 4;
const DISCOVERY_OUTPUT_TOKEN_CAP = 200;

export const isReadOnlyBatchTool = (toolName: ToolName): boolean => {
	return isABuiltinToolName(toolName) && READ_ONLY_BATCH_TOOL_NAMES.has(toolName as BuiltinToolName);
};

export const toolCallDedupKey = (name: string, rawParams: RawToolParamsObj): string => {
	const sorted = Object.keys(rawParams).sort().reduce<RawToolParamsObj>((acc, key) => {
		acc[key as keyof RawToolParamsObj] = rawParams[key as keyof RawToolParamsObj];
		return acc;
	}, {});
	return `${name}:${JSON.stringify(sorted)}`;
};

export type ParsedDiscoveryToolCall = {
	name: BuiltinToolName;
	rawParams: RawToolParamsObj;
};

/** Parse discovery LLM output — one JSON tool call per line, or DONE. */
export const parseDiscoveryToolLines = (text: string): ParsedDiscoveryToolCall[] => {
	const results: ParsedDiscoveryToolCall[] = [];
	const seen = new Set<string>();

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('//') || line.startsWith('#')) {
			continue;
		}
		if (/^done\.?$/i.test(line)) {
			break;
		}

		const jsonStart = line.indexOf('{');
		const jsonSlice = jsonStart >= 0 ? line.slice(jsonStart) : line;

		try {
			const parsed = JSON.parse(jsonSlice) as { name?: string; rawParams?: RawToolParamsObj; params?: RawToolParamsObj };
			const name = parsed.name;
			const rawParams = parsed.rawParams ?? parsed.params;
			if (!name || !rawParams || typeof rawParams !== 'object') {
				continue;
			}
			if (!isReadOnlyBatchTool(name)) {
				continue;
			}

			const key = toolCallDedupKey(name, rawParams);
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);

			results.push({ name: name as BuiltinToolName, rawParams });
			if (results.length >= MAX_ADDITIONAL_READ_TOOLS) {
				break;
			}
		} catch {
			// ignore malformed lines
		}
	}

	return results;
};

const buildDiscoverySystemMessage = (primary: RawToolCallObj): string => {
	return [
		'You help a coding agent batch read-only workspace tools.',
		`The agent is already calling: ${primary.name} with params ${JSON.stringify(primary.rawParams)}.`,
		'',
		'List up to ' + MAX_ADDITIONAL_READ_TOOLS + ' ADDITIONAL read-only tool calls to make in parallel at this step.',
		'Allowed tools: read_file, ls_dir, get_dir_tree, search_pathnames_only, search_for_files, search_in_file, search_codebase.',
		'',
		'Output ONE JSON object per line (no markdown, no prose):',
		'{"name":"read_file","rawParams":{"uri":"path/to/file.ts"}}',
		'',
		'If no additional reads are needed, output exactly: DONE',
	].join('\n');
};

const summarizeUserTask = (messages: { role: string; content?: string; displayContent?: string }[]): string => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'user') {
			const text = ('displayContent' in m && m.displayContent) ? m.displayContent : m.content;
			if (text?.trim()) {
				return text.trim().slice(0, 1200);
			}
		}
	}
	return '(No user message found)';
};

const withDiscoveryTokenCap = (
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
				reservedOutputTokenSpace: DISCOVERY_OUTPUT_TOKEN_CAP,
			},
		},
	} as OverridesOfModel;
};

export const discoverAdditionalReadTools = async (opts: {
	llmMessageService: ILLMMessageService;
	convertToLLMMessageService: IConvertToLLMMessageService;
	modelSelection: ModelSelection;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	chatMode: ChatMode;
	primaryToolCall: RawToolCallObj;
	recentMessages: { role: string; content?: string; displayContent?: string }[];
	excludeKeys: Set<string>;
}): Promise<RawToolCallObj[]> => {
	const userTask = summarizeUserTask(opts.recentMessages);
	const systemMessage = buildDiscoverySystemMessage(opts.primaryToolCall);

	const { messages, separateSystemMessage } = opts.convertToLLMMessageService.prepareLLMSimpleMessages({
		simpleMessages: [{
			role: 'user',
			content: 'User task:\n' + userTask + '\n\nList additional read-only tools needed now (or DONE).',
		}],
		systemMessage,
		modelSelection: opts.modelSelection,
		featureName: 'Chat',
	});

	const discoveryOverrides = withDiscoveryTokenCap(opts.overridesOfModel, opts.modelSelection);

	const fullText = await new Promise<string>((resolve, reject) => {
		const requestId = opts.llmMessageService.sendLLMMessage({
			messagesType: 'chatMessages',
			chatMode: opts.chatMode,
			messages,
			separateSystemMessage,
			modelSelection: opts.modelSelection,
			modelSelectionOptions: opts.modelSelectionOptions,
			overridesOfModel: discoveryOverrides,
			logging: { loggingName: 'Read Tool Batch Discovery' },
			onText: () => { },
			onFinalMessage: ({ fullText }) => resolve(fullText),
			onError: ({ message }) => reject(new Error(message)),
			onAbort: () => reject(new Error('Discovery aborted')),
		});
		if (!requestId) {
			reject(new Error('Could not start read-tool discovery'));
		}
	});

	const parsed = parseDiscoveryToolLines(fullText);
	const additional: RawToolCallObj[] = [];

	for (const item of parsed) {
		const key = toolCallDedupKey(item.name, item.rawParams);
		if (opts.excludeKeys.has(key)) {
			continue;
		}
		additional.push({
			name: item.name,
			rawParams: item.rawParams,
			doneParams: Object.keys(item.rawParams) as RawToolCallObj['doneParams'],
			id: `batch-${generateUuid()}`,
			isDone: true,
		});
		if (additional.length >= MAX_ADDITIONAL_READ_TOOLS) {
			break;
		}
	}

	return additional;
};

export const buildReadToolBatch = (
	primary: RawToolCallObj,
	additional: RawToolCallObj[],
): RawToolCallObj[] => {
	const batch: RawToolCallObj[] = [primary];
	const seen = new Set([toolCallDedupKey(primary.name, primary.rawParams)]);

	for (const tool of additional) {
		const key = toolCallDedupKey(tool.name, tool.rawParams);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		batch.push(tool);
	}

	return batch.slice(0, 1 + MAX_ADDITIONAL_READ_TOOLS);
};
