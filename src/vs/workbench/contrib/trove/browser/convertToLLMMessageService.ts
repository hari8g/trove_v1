import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage } from '../common/prompt/prompts.js';
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { ITroveSettingsService } from '../common/troveSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/troveSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { IContextGatheringService } from './contextGatheringService.js';
import { trimChatMessagesForContextWindow } from './contextWindowTrim.js';

export const EMPTY_MESSAGE = '(empty message)'



type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
}



const CHARS_PER_TOKEN = 4 // assume abysmal chars per token
const TRIM_TO_LEN = 120




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const findLastAssistantInOpenAIMessages = (messages: OpenAILLMChatMessage[]): OpenAILLMChatMessage | undefined => {
	for (let j = messages.length - 1; j >= 0; j--) {
		if (messages[j].role === 'assistant') {
			return messages[j];
		}
	}
	return undefined;
};

const findLastAssistantInAnthropicMessages = (messages: AnthropicLLMChatMessage[]): AnthropicLLMChatMessage | undefined => {
	for (let j = messages.length - 1; j >= 0; j--) {
		if (messages[j].role === 'assistant') {
			return messages[j];
		}
	}
	return undefined;
};

const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role !== 'tool') {
			newMessages.push(currMsg)
			continue
		}

		// attach tool call to the most recent assistant (supports batched parallel tool results)
		const prevMsg = findLastAssistantInOpenAIMessages(newMessages)
		if (prevMsg?.role === 'assistant') {
			const toolCall = {
				type: 'function' as const,
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			}
			prevMsg.tool_calls = [...(prevMsg.tool_calls ?? []), toolCall]
		} else {
			// orphaned tool after trimming — fold into user context instead of breaking the API
			newMessages.push({
				role: 'user',
				content: `[Tool result: ${currMsg.name}]\n${currMsg.content}`,
			})
			continue
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

/** Coerce message text to a plain string (guards against nested/malformed content). */
const toPlainText = (value: unknown): string => {
	if (typeof value === 'string') {
		return value;
	}
	if (value == null) {
		return '';
	}
	if (typeof value === 'object' && 'text' in value) {
		const nested = (value as { text?: unknown }).text;
		if (typeof nested === 'string') {
			return nested;
		}
	}
	return String(value);
};

const ensureAssistantContentIsBlocks = (msg: AnthropicLLMChatMessage & { role: 'assistant' }): void => {
	if (typeof msg.content === 'string') {
		const text = toPlainText(msg.content);
		msg.content = text ? [{ type: 'text', text }] : [];
	}
};

const sanitizeAnthropicContentBlocks = (messages: AnthropicLLMChatMessage[]): AnthropicLLMChatMessage[] => {
	for (const msg of messages) {
		if (typeof msg.content === 'string') {
			msg.content = toPlainText(msg.content) || EMPTY_MESSAGE;
			continue;
		}
		for (const block of msg.content) {
			if (block.type === 'text') {
				block.text = toPlainText(block.text) || EMPTY_MESSAGE;
			} else if (block.type === 'tool_result') {
				block.content = toPlainText(block.content);
			}
		}
	}
	return messages;
};

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: AnthropicLLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i];

		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const text = toPlainText(currMsg.content);
				newMessages.push({
					role: 'assistant',
					content: text
						? [...currMsg.anthropicReasoning, { type: 'text' as const, text }]
						: [...currMsg.anthropicReasoning],
				});
			} else {
				newMessages.push({
					role: 'assistant',
					content: toPlainText(currMsg.content),
				});
			}
			continue;
		}

		if (currMsg.role === 'user') {
			newMessages.push({
				role: 'user',
				content: toPlainText(currMsg.content),
			});
			continue;
		}

		if (currMsg.role === 'tool') {
			const prevAssistant = findLastAssistantInAnthropicMessages(newMessages);
			const toolResultContent = toPlainText(currMsg.content);
			let attachedToAssistant = false;

			if (prevAssistant?.role === 'assistant') {
				ensureAssistantContentIsBlocks(prevAssistant);
				if (Array.isArray(prevAssistant.content)) {
					prevAssistant.content.push({
						type: 'tool_use',
						id: currMsg.id,
						name: currMsg.name,
						input: currMsg.rawParams as Record<string, unknown>,
					});
				}
				attachedToAssistant = true;
			}

			const toolResultBlock = {
				type: 'tool_result' as const,
				tool_use_id: currMsg.id,
				content: toolResultContent,
			};

			const lastMsg = newMessages[newMessages.length - 1];
			// Merge parallel tool results into one user message (required by Anthropic)
			if (
				attachedToAssistant
				&& lastMsg?.role === 'user'
				&& Array.isArray(lastMsg.content)
				&& lastMsg.content.length > 0
				&& lastMsg.content.every(b => b.type === 'tool_result')
			) {
				lastMsg.content.push(toolResultBlock);
			} else if (attachedToAssistant) {
				newMessages.push({ role: 'user', content: [toolResultBlock] });
			} else {
				// Orphaned tool after history trimming
				newMessages.push({
					role: 'user',
					content: `[Tool result: ${currMsg.name}]\n${toolResultContent}`,
				});
			}
		}
	}

	return sanitizeAnthropicContentBlocks(newMessages);
};


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			if (next?.role === 'tool') {
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				const text = toPlainText(content)
				content = text ? [...c.anthropicReasoning, { type: 'text' as const, text }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool')
				c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`

			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
				llmChatMessages.push({
					role: 'user',
					content: c.content
				})
			else
				llmChatMessages[llmChatMessages.length - 1].content += '\n\n' + c.content
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined } => {

	reservedOutputTokenSpace = Math.max(
		contextWindow * 1 / 2, // reserve at least 1/4 of the token window length
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	)
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's global AI instructions setting):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({
		...m,
		content: m.role !== 'tool' ? toPlainText(m.content).trim() : toPlainText(m.content),
	}))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = message.content.length

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	const _findLargestByWeight = (messages_: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < messages.length; i += 1) {
			const m = messages[i]
			const w = weight(m, messages_, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return largestIndex
	}

	let totalLen = 0
	for (const m of messages) { totalLen += m.content.length }
	const charsNeedToTrim = totalLen - Math.max(
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN, // can be 0, in which case charsNeedToTrim=everything, bad
		5_000 // ensure we don't trim at least 5k chars (just a random small value)
	)


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingCharsToTrim = charsNeedToTrim
	let i = 0

	while (remainingCharsToTrim > 0) {
		i += 1
		if (i > 100) break

		const trimIdx = _findLargestByWeight(messages)
		const m = messages[trimIdx]

		// if can finish here, do
		const numCharsWillTrim = m.content.length - TRIM_TO_LEN
		if (numCharsWillTrim > remainingCharsToTrim) {
			// trim remainingCharsToTrim + '...'.length chars
			m.content = m.content.slice(0, m.content.length - remainingCharsToTrim - '...'.length).trim() + '...'
			break
		}

		remainingCharsToTrim -= numCharsWillTrim
		m.content = m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...'
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		const newFirstMessage = {
			role: 'user',
			content: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n${llmMessages[0].content}`
		} as const
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i]
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1]

		if (currMsg.role === 'tool') continue

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			currMsg.content = currMsg.content || EMPTY_MESSAGE
		}
		else {
			// allowed to be empty if has a tool in it or following it
			if (currMsg.content.find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				currMsg.content = currMsg.content.filter(c => !(c.type === 'text' && !c.text)) as any
				continue
			}
			if (nextMsg?.role === 'tool') continue

			// replace any empty text entries with empty msg, and make sure there's at least 1 entry
			for (const c of currMsg.content) {
				if (c.type === 'text') c.text = toPlainText(c.text) || EMPTY_MESSAGE
			}
			if (currMsg.content.length === 0) currMsg.content = [{ type: 'text', text: EMPTY_MESSAGE }]
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	let latestToolName: ToolName | undefined = undefined
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						latestToolName = c.name
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						if (!latestToolName) return null
						return { functionResponse: { id: c.tool_use_id, name: latestToolName, response: { output: c.content } } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	providerName: ProviderName
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined, contextWasTrimmed: boolean }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@ITroveSettingsService private readonly troveSettingsService: ITroveSettingsService,
		@IMCPService private readonly mcpService: IMCPService,
		@IRepoIntelligenceService private readonly _repoIntelligenceService: IRepoIntelligenceService,
		@IContextGatheringService private readonly _contextGatheringService: IContextGatheringService,
	) {
		super()
	}

	// Global AI instructions from Trove settings (not .troverules — those are injected via chat_systemMessage)
	private _getGlobalAIInstructions(): string {
		return this.troveSettingsService.state.globalSettings.aiInstructions?.trim() ?? '';
	}


	// system message
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined) => {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

		const openedURIs = this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath) || [];
		const activeURI = this.editorService.activeEditor?.resource?.fsPath;

		const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
			cutOffMessage: chatMode === 'agent' || chatMode === 'gather' ?
				`...Directories string cut off, use tools to read more...`
				: `...Directories string cut off, ask user for more if necessary...`
		})

		const includeXMLToolDefinitions = !specialToolFormat

		const mcpTools = this.mcpService.getMCPTools()

		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()
		let repoProfile = this._repoIntelligenceService.getProfileSync()
		if (!repoProfile && workspaceFolders[0]) {
			repoProfile = await this._repoIntelligenceService.getProfile(workspaceFolders[0])
		}
		const workspaceRules = this._repoIntelligenceService.getWorkspaceRules()
		const userMemory = this._repoIntelligenceService.getUserMemory()
		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, mcpTools, includeXMLToolDefinitions, repoProfile, workspaceRules, userMemory })
		return systemMessage
	}




	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[]): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'plan') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
					anthropicReasoning: m.anthropicReasoning,
				})
			}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
				})
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
				})
			}
		}
		return simpleLLMMessages
	}

	private _prependRecentlyViewedCodeToLatestUserMessage(messages: SimpleLLMMessage[]): void {
		const snippets = this._contextGatheringService.getCachedSnippets()
		if (!snippets.length) return

		const snippetBlock = `\n\n<recently_viewed_code>\n${snippets.slice(0, 4).join('\n---\n')}\n</recently_viewed_code>`
		let latestUserIdx = -1
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') {
				latestUserIdx = i
				break
			}
		}
		if (latestUserIdx !== -1) {
			messages[latestUserIdx].content = snippetBlock + messages[latestUserIdx].content
		}
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.troveSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.troveSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getGlobalAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined, contextWasTrimmed: false }

		const { overridesOfModel } = this.troveSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.troveSettingsService.state.globalSettings;
		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat)
		const systemMessage = disableSystemMessage ? '' : fullSystemMessage;

		const aiInstructions = this._getGlobalAIInstructions();

		const { messages: trimmedChatMessages, contextWasTrimmed } = trimChatMessagesForContextWindow({
			chatMessages,
			systemMessage,
			aiInstructions,
			contextWindow,
		})

		const modelSelectionOptions = this.troveSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		const llmMessages = this._chatMessagesToSimpleMessages(trimmedChatMessages)
		this._prependRecentlyViewedCodeToLatestUserMessage(llmMessages)

		const { messages, separateSystemMessage } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage, contextWasTrimmed };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		// Get combined AI instructions with the provided aiInstructions as the base
		const combinedInstructions = this._getGlobalAIInstructions();

		let prefix = `\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Try to avoid outputting comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/



