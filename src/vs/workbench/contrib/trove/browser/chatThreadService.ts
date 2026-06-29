/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { chat_userMessageContent, findUnresolvedAtMentionsInText, validateStagingSelections } from '../common/prompt/prompts.js';
import { AnthropicReasoning, getErrorMessage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ChatMode, FeatureName, ModelSelection, ModelSelectionOptions, OverridesOfModel } from '../common/troveSettingsTypes.js';
import { ITroveSettingsService } from '../common/troveSettingsService.js';
import { getIsReasoningEnabledState } from '../common/modelCapabilities.js';
import { BuiltinToolCallParams, ToolCallParams, ToolName } from '../common/toolsServiceTypes.js';
import { IToolsService } from './toolsService.js';
import { IAgentDeliveryService } from './agentDeliveryService.js';
import { IWorkspacePreviewService } from './workspacePreviewService.js';
import { buildReadToolBatch, discoverAdditionalReadTools, isReadOnlyBatchTool, toolCallDedupKey } from './parallelReadToolBatch.js';
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js';
import { completeRemainingPlanItems, findLatestPlanMessageIdx, markPlanItemDoneForTool, resolveAgentPlanForRun, skipRemainingPlanItems } from './agentPlan.js';
import { getAgentLoopLimits } from './agentLoopSettings.js';
import { getLlmStreamStallTimeoutMs } from './agentLoopLimits.js';
import { shouldGenerateAgentPlan, shouldUseParallelReadBatching } from '../common/lightAgent.js';
import { buildRepeatFileReadHint, FileReadRecord } from './fileReadDedup.js';
import { buildRepeatEditHint, buildLargeFileEditHint } from './agentEditHints.js';
import { buildAgentTailHints, buildExplorationBudgetHint, buildRepeatReadHint, buildCrossQueryFileReadHint, createReadOnlyCallCounts } from './agentReadHints.js';
import {
	buildSandboxVerificationHint,
	createSandboxVerificationTracker,
	MAX_SANDBOX_VERIFICATION_NUDGES,
	needsSandboxVerification,
} from './agentVerificationHints.js';
import {
	buildEditCompletionHint,
	createEditCompletionTracker,
	isEditToolName,
	isMissingEditContentError,
	markInterruptedEditTool,
	markTruncatedEditTool,
	needsEditCompletion,
	MAX_EDIT_COMPLETION_NUDGES,
} from './agentEditCompletionHints.js';
import { AGENT_ANTHROPIC_OUTPUT_TOKENS, isLikelyOutputTruncated } from '../common/agentOutputTokenLimits.js';
import {
	errorEditDiagnostic,
	logEditDiagnostic,
	shouldTraceEditToolCall,
	summarizeEditToolCall,
	warnEditDiagnostic,
} from './agentEditDiagnostics.js';
import { getLLMRetryDelayMs, getMaxLLMRetryAttempts, isRateLimitLLMError, isStreamStallLLMError, shouldForceAggressiveTrimOnRetry, getProviderRateLimitCooldownMs, recordProviderRateLimitHit, formatRateLimitCooldownMessage, clearProviderRateLimitCooldown } from './llmRateLimit.js';
import { QueuedUserMessage } from '../common/chatMessageQueueTypes.js';
import { extractRememberIntent, isRememberOnlyMessage, MEMORY_SAVED_CONFIRMATION } from './chatMemoryIntent.js';
import { addUsageToRunTotals, emptyAgentRunTokenTotals, formatAgentRunTokenSummary } from '../common/llmMessageUsage.js';
import { IUsageMeteringService } from './usageMeteringService.js';
import { ITroveCommandBarService } from './troveCommandBarService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CheckpointEntry, CodespanLocationLink, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { ITroveModelService } from '../common/troveModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { VoidFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { createRunToolCall, ToolCallLoopResult } from './toolCallRunner.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500

const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		if (newSelection.type === 'Image' && s.type === 'Image') {
			if (s.fileName === newSelection.fileName && s.dataUrl === newSelection.dataUrl) return i
			continue
		}
		if (newSelection.type === 'Pdf' && s.type === 'Pdf') {
			if (s.fileName === newSelection.fileName) return i
			continue
		}
		if (!('uri' in s) || !('uri' in newSelection) || !s.uri || !newSelection.uri) continue
		if (s.uri.fsPath !== newSelection.uri.fsPath) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i
		}
	}
	return null
}

/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string
	title?: string;

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}


	};
}

type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
}

export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| 'background' // running in background (non-blocking)
	| undefined

export type TroveSidebarTab = 'chat' | 'composer' | 'notepads';

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
		contextWasTrimmed?: boolean;
	} | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
		contextWasTrimmed?: boolean;
		idleStatus?: { title: string; detail?: string };
	} | {
		isRunning: 'background';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: Promise<() => void>;
	}
}

const newThreadObject = () => {
	const now = new Date().toISOString()
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType
}






export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>
	onDidFinishAgentRun: Event<{ threadId: string; pendingDiffCount: number; filesChanged: string[] }>

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	/** Always creates a fresh thread for an agent run (never reuses empty threads). Returns the new thread id. */
	openThreadForAgentRun(): string;
	switchToThread(threadId: string): void;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;
	renameThread(threadId: string, title: string): void;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;
	runCurrentThreadInBackground(): void;

	requestSidebarTab(tab: TroveSidebarTab): void;
	readonly onDidRequestSidebarTab: Event<TroveSidebarTab>;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse(opts: { userMessage: string, threadId: string, displayMessage?: string, _internalPrompt?: boolean }): Promise<void>;

	getMessageQueue(threadId: string): readonly QueuedUserMessage[];
	removeQueuedMessage(threadId: string, messageId: string): void;
	readonly onDidChangeMessageQueue: Event<{ threadId: string }>;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;

	// jump to history
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): void;

	focusCurrentChat: () => Promise<void>
	blurCurrentChat: () => Promise<void>
}

export const IChatThreadService = createDecorator<IChatThreadService>('troveChatThreadService');
class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	private readonly _onDidFinishAgentRun = new Emitter<{ threadId: string; pendingDiffCount: number; filesChanged: string[] }>();
	readonly onDidFinishAgentRun: Event<{ threadId: string; pendingDiffCount: number; filesChanged: string[] }> = this._onDidFinishAgentRun.event;

	private readonly _onDidChangeMessageQueue = this._register(new Emitter<{ threadId: string }>());
	readonly onDidChangeMessageQueue: Event<{ threadId: string }> = this._onDidChangeMessageQueue.event;

	private readonly _onDidRequestSidebarTab = this._register(new Emitter<TroveSidebarTab>());
	readonly onDidRequestSidebarTab: Event<TroveSidebarTab> = this._onDidRequestSidebarTab.event;

	readonly streamState: ThreadStreamState = {}
	private readonly _messageQueueByThread = new Map<string, QueuedUserMessage[]>();
	/** Persists file-read records across queries within the same thread so the dedup/skip logic works cross-turn. */
	private readonly _threadFileReadHistory = new Map<string, Map<string, FileReadRecord>>();
	/** Skip the pre-run agent plan step for internal/system prompts (e.g. RIAF). */
	private readonly _suppressAgentPlanByThread = new Map<string, boolean>();
	private _runToolCall!: ReturnType<typeof createRunToolCall>;
	state: ThreadsState // allThreads is persisted, currentThread is not

	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)



	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ITroveModelService private readonly _troveModelService: ITroveModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@ITroveSettingsService private readonly _settingsService: ITroveSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IAgentDeliveryService private readonly _agentDeliveryService: IAgentDeliveryService,
		@IWorkspacePreviewService private readonly _workspacePreviewService: IWorkspacePreviewService,
		@ITroveCommandBarService private readonly _commandBarService: ITroveCommandBarService,
		@ITerminalToolService private readonly _terminalToolService: ITerminalToolService,
		@IRepoIntelligenceService private readonly _repoIntelligenceService: IRepoIntelligenceService,
		@IUsageMeteringService private readonly _usageMeteringService: IUsageMeteringService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // default state

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // gets set in startNewThread()
		}

		// always be in a thread
		this.openNewThread()


		// keep track of user-modified files
		// const disposablesOfModelId: { [modelId: string]: IDisposable[] } = {}
		// this._register(
		// 	this._modelService.onModelAdded(e => {
		// 		if (!(e.id in disposablesOfModelId)) disposablesOfModelId[e.id] = []
		// 		disposablesOfModelId[e.id].push(
		// 			e.onDidChangeContent(() => { this._userModifiedFilesToCheckInCheckpoints.set(e.uri.fsPath, null) })
		// 		)
		// 	})
		// )
		// this._register(this._modelService.onModelRemoved(e => {
		// 	if (!(e.id in disposablesOfModelId)) return
		// 	disposablesOfModelId[e.id].forEach(d => d.dispose())
		// }))

		this._runToolCall = createRunToolCall({
			toolsService: this._toolsService,
			mcpService: this._mcpService,
			settingsService: this._settingsService,
			terminalToolService: this._terminalToolService,
			agentDeliveryService: this._agentDeliveryService,
			directoryStringService: this._directoryStringService,
			workspacePreviewService: this._workspacePreviewService,
			errWhenStringifying: (error) => this.toolErrMsgs.errWhenStringifying(error),
			addMessageToThread: (threadId, message) => this._addMessageToThread(threadId, message),
			updateLatestTool: (threadId, tool, opts) => this._updateLatestTool(threadId, tool, opts),
			setStreamState: (threadId, state) => this._setStreamState(threadId, state),
			getStreamState: (threadId) => this.streamState[threadId],
			addToolEditCheckpoint: (opts) => this._addToolEditCheckpoint(opts),
			markPlanItemDone: (threadId, toolName, toolParams) => this._markPlanItemDone(threadId, toolName, toolParams),
		});

	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus()
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur()
		}
	}



	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState
		this._onDidChangeCurrentThread.fire()
	}
	resetState = () => {
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // see constructor
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.from(value); // TODO URI.revive instead of this?
			}
			return value;
		});
	}

	private _readAllThreads(): ChatThreads | null {
		let threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			threadsStr = this._storageService.get('void.chatThreadStorageII', StorageScope.APPLICATION);
		}
		if (!threadsStr) {
			return null
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);

		return threads
	}

	private _storeAllThreads(threads: ChatThreads) {
		const serializedThreads = JSON.stringify(threads);
		this._storageService.store(
			THREAD_STORAGE_KEY,
			serializedThreads,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		}

		this.state = newState

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart Trove)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', })

			// if running now but stream state doesn't indicate it (happens if restart Trove), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName })
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) return

		let whenMountedResolver: (w: WhenMounted) => void
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res)

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w)
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
					if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
				},
			}
		}, true) // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		this.streamState[threadId] = state
		this._onDidChangeStreamState.fire({ threadId })
	}

	private _setIdleStatus(
		threadId: string,
		title: string,
		detail?: string,
		opts?: { interrupt?: 'not_needed' | Promise<() => void>; contextWasTrimmed?: boolean },
	): void {
		const prev = this.streamState[threadId]
		const interrupt = opts?.interrupt
			?? (prev?.isRunning === 'idle' && prev.interrupt !== 'not_needed' ? prev.interrupt : 'not_needed')
		const contextWasTrimmed = opts?.contextWasTrimmed
			?? (prev && 'contextWasTrimmed' in prev ? prev.contextWasTrimmed : undefined)

		this._setStreamState(threadId, {
			isRunning: 'idle',
			interrupt,
			idleStatus: { title, detail },
			...(contextWasTrimmed ? { contextWasTrimmed } : {}),
		})
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat'
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}



	private _swapOutStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false

		if (tool.id) {
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i]
				if (msg.role === 'tool' && msg.id === tool.id && msg.type !== 'invalid_params') {
					this._editMessageInThread(threadId, i, tool)
					return true
				}
			}
		}

		const lastMsg = messages[messages.length - 1]
		if (!lastMsg) return false

		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			this._editMessageInThread(threadId, messages.length - 1, tool)
			return true
		}
		return false
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }, opts?: { batchInsert?: boolean }) => {
		if (opts?.batchInsert && tool.type === 'running_now') {
			this._addMessageToThread(threadId, tool)
			return
		}
		const swapped = this._swapOutStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) return // should never happen

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps() })
			, threadId
		)
	}
	rejectLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params
		}
		else return

		const { name, id, rawParams, mcpServerName } = lastMsg

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName })
		this._setStreamState(threadId, undefined)
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	runCurrentThreadInBackground() {
		const threadId = this.state.currentThreadId;
		const current = this.streamState[threadId];
		if (!current?.isRunning || current.isRunning === 'background') return;
		if (current.isRunning === 'idle' || current.isRunning === 'LLM' || current.isRunning === 'tool' || current.isRunning === 'awaiting_user') {
			const interrupt = 'interrupt' in current ? current.interrupt : Promise.resolve(() => {});
			this._setStreamState(threadId, { isRunning: 'background', interrupt: interrupt instanceof Promise ? interrupt : Promise.resolve(() => {}) });
			this._notificationService.notify({
				severity: Severity.Info,
				message: `Running in background…`,
				source: 'Trove Agent',
			});
		}
	}

	requestSidebarTab(tab: TroveSidebarTab): void {
		this._onDidRequestSidebarTab.fire(tab);
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
			if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName })
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}
		else if (this.streamState[threadId]?.isRunning === 'background') {
			// abort a background run
		}

		this._addUserCheckpoint({ threadId })

		// Leave plan checklist items pending so a "continue" message can resume them.

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()

		this._terminalToolService.disposeSandboxSession()


		this._setStreamState(threadId, undefined)
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: any) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}



	private async _runReadOnlyToolBatch({
		threadId,
		primaryToolCall,
		chatMode,
		modelSelection,
		modelSelectionOptions,
		overridesOfModel,
		chatMessages,
		readOnlyCallCounts,
	}: {
		threadId: string;
		primaryToolCall: RawToolCallObj;
		chatMode: ChatMode;
		modelSelection: ModelSelection | null;
		modelSelectionOptions: ModelSelectionOptions | undefined;
		overridesOfModel: OverridesOfModel | undefined;
		chatMessages: ChatMessage[];
		readOnlyCallCounts?: ReturnType<typeof createReadOnlyCallCounts>;
	}): Promise<ToolCallLoopResult> {
		if (!modelSelection) {
			return this._runToolCall(threadId, primaryToolCall.name, primaryToolCall.id, undefined, { preapproved: false, unvalidatedToolParams: primaryToolCall.rawParams, readOnlyCallCounts })
		}

		let additional: RawToolCallObj[] = []
		try {
			this._setIdleStatus(threadId, 'Planning parallel reads', 'Checking whether additional read-only tools should run together')
			additional = await discoverAdditionalReadTools({
				llmMessageService: this._llmMessageService,
				convertToLLMMessageService: this._convertToLLMMessagesService,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel,
				chatMode,
				primaryToolCall,
				recentMessages: chatMessages,
				excludeKeys: new Set([toolCallDedupKey(primaryToolCall.name, primaryToolCall.rawParams)]),
			})
		} catch (err) {
			console.error('[Trove] Read-tool batch discovery failed; continuing with primary read only.', err);
			additional = []
		}

		const batch = buildReadToolBatch(primaryToolCall, additional)
		const useBatchInsert = batch.length > 1

		const results = await Promise.all(batch.map(toolCall => {
			return this._runToolCall(
				threadId,
				toolCall.name,
				toolCall.id,
				undefined,
				{ preapproved: false, unvalidatedToolParams: toolCall.rawParams, batchInsert: useBatchInsert, readOnlyCallCounts },
			)
		}))

		if (results.some(r => r.interrupted)) {
			return { interrupted: true }
		}
		if (results.some(r => r.awaitingUserApproval)) {
			return { awaitingUserApproval: true }
		}
		if (results.some(r => r.status === 'error' || r.status === 'invalid_params')) {
			return { status: 'error' }
		}
		return { status: 'ok' }
	}




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
	}) {


		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings // should not change as we loop even if user changes it, so it goes here
		const { overridesOfModel } = this._settingsService.state
		const agentLoopLimits = getAgentLoopLimits(this._settingsService.state.globalSettings)

		let nMessagesSent = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined
		const runTokenTotals = emptyAgentRunTokenTotals()
		const fileEditCounts = new Map<string, number>()
		const readOnlyCallCounts = createReadOnlyCallCounts()
		// Seed with file reads accumulated from earlier queries in this thread so
		// shouldSkipDuplicateFileRead and buildRepeatFileReadHint work cross-turn.
		const prevFileReads = this._threadFileReadHistory.get(threadId)
		if (prevFileReads) {
			for (const [key, record] of prevFileReads) {
				readOnlyCallCounts.fileReads.set(key, { count: record.count, ranges: [...record.ranges], totalFileLen: record.totalFileLen })
			}
		}
		const sandboxVerificationTracker = createSandboxVerificationTracker()
		const editCompletionTracker = createEditCompletionTracker()
		let sandboxVerificationHint = ''
		let editCompletionHint = ''
		let lastLlmOutputTokens: number | undefined
		let consecutiveToolFails = 0

		try {
		// before enter loop, call tool
		if (callThisToolFirst) {
			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params, fileEditCounts, readOnlyCallCounts, sandboxVerificationTracker })
			if (interrupted) {
				this._setStreamState(threadId, undefined)
				this._addUserCheckpoint({ threadId })

			}
		}
		this._setIdleStatus(threadId, 'Starting agent', `${chatMode} mode`)

		// generate structured plan before tool-use loop (agent mode only)
		const suppressAgentPlan = this._suppressAgentPlanByThread.get(threadId) === true
		this._suppressAgentPlanByThread.delete(threadId)
		if (chatMode === 'agent' && modelSelection && shouldGenerateAgentPlan(this._settingsService.state.globalSettings) && !suppressAgentPlan) {
			const chatMessages = this.state.allThreads[threadId]?.messages ?? []
			const planResolution = await resolveAgentPlanForRun({
				llmMessageService: this._llmMessageService,
				convertToLLMMessageService: this._convertToLLMMessagesService,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel,
				chatMode,
				chatMessages,
				threadId,
				usageMeteringService: this._usageMeteringService,
				fileReadHistory: this._threadFileReadHistory.get(threadId),
			})
			if (planResolution.action === 'reactivate') {
				this._setIdleStatus(threadId, 'Resuming plan', 'Continuing from the previous checklist')
				this._editMessageInThread(threadId, planResolution.planMessageIdx, planResolution.plan)
			} else if (planResolution.action === 'reuse') {
				this._setIdleStatus(threadId, 'Resuming plan', 'Continuing the existing checklist')
			} else if (planResolution.action === 'generate') {
				this._setIdleStatus(threadId, 'Generating plan', 'Asking the model to outline next steps')
				if (planResolution.priorPlanMessageIdx !== undefined) {
					const priorPlan = chatMessages[planResolution.priorPlanMessageIdx]
					if (priorPlan?.role === 'plan') {
						this._editMessageInThread(threadId, planResolution.priorPlanMessageIdx, skipRemainingPlanItems(priorPlan))
					}
				}
				this._addMessageToThread(threadId, planResolution.plan)
			}
			// action === 'none': plan generation failed or disabled — agent loop continues without blocking
		}

		let precomputedRunContext: import('./convertToLLMMessageService.js').RunContextBlocks | undefined
		if (modelSelection) {
			this._setIdleStatus(threadId, 'Building workspace context', 'Loading directory tree, rules, and memory')
			precomputedRunContext = await this._convertToLLMMessagesService.buildRunContext({ chatMode, modelSelection })
		}

		// tool use loop
		while (shouldSendAnotherMessage) {
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

			if (nMessagesSent > agentLoopLimits.maxAgentIterations) {
				this._addMessageToThread(threadId, {
					role: 'assistant',
					displayContent: `Stopped after ${agentLoopLimits.maxAgentIterations} agent steps. Ask me to continue if you need more work done.`,
					reasoning: '',
					anthropicReasoning: null,
				})
				this._metricsService.capture('Agent Loop Done (Max Iterations)', { nMessagesSent, chatMode })
				break
			}

			this._setIdleStatus(
				threadId,
				'Preparing model call',
				nMessagesSent > 1 ? `Agent turn ${nMessagesSent} · assembling conversation history` : 'Assembling conversation history',
				{ interrupt: idleInterruptor },
			)

			const chatMessages = this.state.allThreads[threadId]?.messages ?? []
			const globalSettings = this._settingsService.state.globalSettings
			const agentTailHints = buildAgentTailHints({
				repeatEditHint: buildRepeatEditHint(fileEditCounts),
				repeatReadHint: buildRepeatReadHint(readOnlyCallCounts),
				repeatFileReadHint: buildRepeatFileReadHint(readOnlyCallCounts.fileReads),
				largeFileEditHint: chatMode === 'agent' ? buildLargeFileEditHint(readOnlyCallCounts.fileReads) : '',
				explorationBudgetHint: buildExplorationBudgetHint(readOnlyCallCounts, agentLoopLimits.maxReadOnlyCalls, globalSettings),
				sandboxVerificationHint,
				editCompletionHint,
				crossQueryFileReadHint: buildCrossQueryFileReadHint(readOnlyCallCounts.fileReads, nMessagesSent),
			})
			sandboxVerificationHint = ''
			editCompletionHint = ''

			let messages: Awaited<ReturnType<IConvertToLLMMessageService['prepareLLMChatMessages']>>['messages'] = []
			let separateSystemMessage: string | undefined
			let volatileSystemMessage: string | undefined
			let contextWasTrimmed = false
			const prepareMessagesForTurn = async (forceAggressiveTrim?: boolean) => {
				const prepared = await this._convertToLLMMessagesService.prepareLLMChatMessages({
					chatMessages: this.state.allThreads[threadId]?.messages ?? [],
					modelSelection,
					chatMode,
					precomputedRunContext,
					agentTailHints,
					forceAggressiveTrim: forceAggressiveTrim || (chatMode === 'agent' && nMessagesSent > 2),
					threadId,
				})
				messages = prepared.messages
				separateSystemMessage = prepared.separateSystemMessage
				volatileSystemMessage = prepared.volatileSystemMessage
				contextWasTrimmed = prepared.contextWasTrimmed
			}
			await prepareMessagesForTurn()

			if (modelSelection) {
				const cooldownMs = getProviderRateLimitCooldownMs(modelSelection.providerName, modelSelection.modelName)
				if (cooldownMs > 0) {
					this._setStreamState(threadId, {
						isRunning: undefined,
						error: {
							message: formatRateLimitCooldownMessage(cooldownMs),
							fullError: null,
						},
					})
					break
				}
			}

			if (nMessagesSent === 1 && modelSelection) {
				this._metricsService.capture('Prompt Cache Config', {
					enablePromptCache: this._settingsService.state.globalSettings.enablePromptCache,
					provider: modelSelection.providerName,
					model: modelSelection.modelName,
				})
			}

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			const budgetUSD = this._usageMeteringService.getBudgetLimitUSD()
			if (budgetUSD !== null) {
				const spent = this._usageMeteringService.getSession().totalCostUSD
				if (spent >= budgetUSD) {
					this._setStreamState(threadId, {
						isRunning: undefined,
						error: {
							message: `Budget of $${budgetUSD.toFixed(2)} reached ($${spent.toFixed(4)} spent). Reset in Settings → Usage.`,
							fullError: null,
						},
					})
					break
				}
			}

			let shouldRetryLLM = true
			let nAttempts = 0
			while (shouldRetryLLM) {
				shouldRetryLLM = false
				nAttempts += 1

				type ResTypes =
					| { type: 'llmDone', toolCall?: RawToolCallObj, info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null } }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
					| { type: 'llmAborted' }

				let resolveMessage: (res: ResTypes) => void
				const messageIsDonePromise = new Promise<ResTypes>((res) => { resolveMessage = res })
				let stallTimer: ReturnType<typeof setTimeout> | undefined
				let messageResolved = false
				let editStreamStarted = false
				let toolStreamStarted = false
				const isReasoningEnabledForStall = modelSelection
					? getIsReasoningEnabledState('Chat', modelSelection.providerName, modelSelection.modelName, modelSelectionOptions, overridesOfModel)
					: false
				const resolveMessageOnce = (res: ResTypes) => {
					if (messageResolved) {
						return
					}
					messageResolved = true
					if (stallTimer) {
						clearTimeout(stallTimer)
					}
					resolveMessage(res)
				}
				const resetStallTimer = () => {
					if (stallTimer) {
						clearTimeout(stallTimer)
					}
					const stallTimeoutMs = getLlmStreamStallTimeoutMs(agentLoopLimits.llmStreamStallTimeoutMs, {
						editToolStreaming: editStreamStarted,
						toolStreaming: toolStreamStarted,
						reasoningEnabled: isReasoningEnabledForStall,
					})
					const stallSec = Math.round(stallTimeoutMs / 1000)
					stallTimer = setTimeout(() => {
						this._metricsService.capture('LLM Stream Stall', { nMessagesSent, chatMode, editToolStreaming: editStreamStarted, toolStreaming: toolStreamStarted, reasoningEnabled: isReasoningEnabledForStall })
						// Resolve BEFORE abort so onAbort does not win the race and kill the agent loop.
						resolveMessageOnce({
							type: 'llmError',
							error: {
								message: editStreamStarted
									? `Edit generation stalled — no tokens received for ${stallSec} seconds. Retrying…`
									: toolStreamStarted
										? `Tool generation stalled — no tokens received for ${stallSec} seconds. Retrying…`
										: isReasoningEnabledForStall
											? `Model thinking stalled — no tokens received for ${stallSec} seconds. Retrying…`
											: `Model stream stalled — no tokens received for ${stallSec} seconds.`,
								fullError: null,
							},
						})
						if (llmCancelToken) {
							this._llmMessageService.abort(llmCancelToken)
						}
					}, stallTimeoutMs)
				}

				this._setIdleStatus(
					threadId,
					'Waiting for model response',
					contextWasTrimmed
						? 'Sending trimmed context'
						: `${chatMode} mode · request in flight`,
					{ interrupt: idleInterruptor, contextWasTrimmed },
				)

				let llmCancelToken: string | null = null
				let lastEditStreamSignature = ''
				llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
					separateSystemMessage: separateSystemMessage,
					volatileSystemMessage,
					threadId,
					onText: ({ fullText, fullReasoning, toolCall }) => {
						resetStallTimer()
						if (toolCall?.name) {
							toolStreamStarted = true
						}
						if (shouldTraceEditToolCall(toolCall)) {
							const signature = `${toolCall!.name}|${toolCall!.isDone}|${toolCall!.doneParams.join(',')}|${Object.keys(toolCall!.rawParams).join(',')}`
							if (signature !== lastEditStreamSignature) {
								const stage = editStreamStarted ? 'stream_progress' : 'stream_start'
								editStreamStarted = true
								lastEditStreamSignature = signature
								logEditDiagnostic(stage, { turn: nMessagesSent, ...summarizeEditToolCall(toolCall) })
							}
						}
						this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCall ?? null }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }), contextWasTrimmed })
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCall, anthropicReasoning, usage }) => {
						if (toolCall && isEditToolName(toolCall.name)) {
							logEditDiagnostic('llm_final', {
								turn: nMessagesSent,
								textLen: fullText.length,
								outputTokens: usage?.outputTokens,
								...summarizeEditToolCall(toolCall),
							})
						} else if (lastEditStreamSignature) {
							warnEditDiagnostic('llm_final', {
								turn: nMessagesSent,
								textLen: fullText.length,
								outputTokens: usage?.outputTokens,
								hadStreamedEdit: true,
								hasToolCall: false,
								lastStreamSignature: lastEditStreamSignature,
							})
						}
						addUsageToRunTotals(runTokenTotals, usage)
						lastLlmOutputTokens = usage?.outputTokens
						if (usage && modelSelection) {
							this._usageMeteringService.recordTurn({
								usage,
								providerName: modelSelection.providerName,
								modelName: modelSelection.modelName,
								threadId,
							})
						}
						resolveMessageOnce({ type: 'llmDone', toolCall, info: { fullText, fullReasoning, anthropicReasoning } })
					},
					onError: async (error) => {
						if (editStreamStarted) {
							errorEditDiagnostic('llm_final', {
								turn: nMessagesSent,
								phase: 'error',
								error: error.message,
								hadStreamedEdit: true,
							})
						}
						resolveMessageOnce({ type: 'llmError', error: error })
					},
					onAbort: () => {
						if (editStreamStarted) {
							warnEditDiagnostic('llm_final', {
								turn: nMessagesSent,
								phase: 'aborted',
								hadStreamedEdit: true,
							})
						}
						resolveMessageOnce({ type: 'llmAborted' })
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode })
					},
				})

				// mark as streaming
				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } })
					break
				}

				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken!)), contextWasTrimmed })
				resetStallTimer()
				const llmRes = await messageIsDonePromise

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					return
				}

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					this._setStreamState(threadId, undefined)
					return
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					const { error } = llmRes
					if (editStreamStarted && error && isStreamStallLLMError(error)) {
						const toolCallSoFar = this.streamState[threadId]?.llmInfo?.toolCallSoFar
						if (toolCallSoFar && isEditToolName(toolCallSoFar.name)) {
							markInterruptedEditTool(editCompletionTracker)
						}
					}
					if (error && isRateLimitLLMError(error) && modelSelection) {
						recordProviderRateLimitHit(modelSelection.providerName, error, modelSelection.modelName)
					}
					const maxRetries = error ? getMaxLLMRetryAttempts(error) : CHAT_RETRIES
					if (nAttempts < maxRetries) {
						shouldRetryLLM = true
						if (error && shouldForceAggressiveTrimOnRetry(error)) {
							await prepareMessagesForTurn(true)
							this._metricsService.capture('Context Trim Retry', { nMessagesSent, chatMode, nAttempts, reason: isRateLimitLLMError(error) ? 'rate_limit' : 'overflow' })
						}
						const retryDelayMs = error ? getLLMRetryDelayMs(error, nAttempts, RETRY_DELAY) : RETRY_DELAY
						const retryReason = error && isRateLimitLLMError(error)
							? `Rate limit — waiting ${Math.ceil(retryDelayMs / 1000)}s (context trimmed)`
							: `Attempt ${nAttempts + 1} of ${maxRetries} after a transient error`
						this._setIdleStatus(
							threadId,
							'Retrying model request',
							retryReason,
							{ interrupt: idleInterruptor },
						)
						await timeout(retryDelayMs)
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined)
							return
						}
						continue
					}
					else {
						const { error } = llmRes
						if (error && isRateLimitLLMError(error) && modelSelection) {
							recordProviderRateLimitHit(modelSelection.providerName, error, modelSelection.modelName)
						}
						// Stream stall during edit generation — nudge retry instead of ending the run.
						if (editStreamStarted && error && isStreamStallLLMError(error)
							&& editCompletionTracker.nudgeCount < MAX_EDIT_COMPLETION_NUDGES
						) {
							const toolCallSoFar = this.streamState[threadId].llmInfo.toolCallSoFar
							if (toolCallSoFar && isEditToolName(toolCallSoFar.name)) {
								this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
							}
							editCompletionTracker.nudgeCount += 1
							editCompletionTracker.interruptedEditTool = true
							editCompletionHint = buildEditCompletionHint({ interruptedEditTool: true })
							shouldSendAnotherMessage = true
							warnEditDiagnostic('completion_nudge', { turn: nMessagesSent, reason: 'stream_stall_exhausted' })
							break
						}
						const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
						if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })

						const userMessage = error && isRateLimitLLMError(error)
							? `${error.message}\n\n${formatRateLimitCooldownMessage(getProviderRateLimitCooldownMs(modelSelection?.providerName ?? '', modelSelection?.modelName))}`
							: error?.message
						this._setStreamState(threadId, { isRunning: undefined, error: { message: userMessage ?? 'Model request failed.', fullError: error?.fullError ?? null } })
						this._addUserCheckpoint({ threadId })
						return
					}
				}

				// llm res success
				const { toolCall, info } = llmRes
				if (modelSelection) {
					clearProviderRateLimitCooldown(modelSelection.providerName, modelSelection.modelName)
				}

				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning })

				this._setIdleStatus(threadId, 'Processing model response', toolCall ? 'Preparing tool call' : 'Finishing turn')

				// Model streamed edit_file/rewrite_file ("Generating edit…") but finalMessage had no tool call
				if (!toolCall) {
					const toolCallSoFar = this.streamState[threadId]?.llmInfo?.toolCallSoFar
					if (toolCallSoFar && isEditToolName(toolCallSoFar.name)) {
						warnEditDiagnostic('stream_interrupted', {
							turn: nMessagesSent,
							...summarizeEditToolCall(toolCallSoFar),
						})
						this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
						markInterruptedEditTool(editCompletionTracker)
					}
				}

				// call tool if there is one
				if (toolCall) {
					const mcpTools = this._mcpService.getMCPTools()

					let toolResult: ToolCallLoopResult
					if (isReadOnlyBatchTool(toolCall.name) && shouldUseParallelReadBatching(this._settingsService.state.globalSettings)) {
						toolResult = await this._runReadOnlyToolBatch({
							threadId,
							primaryToolCall: toolCall,
							chatMode,
							modelSelection,
							modelSelectionOptions,
							overridesOfModel,
							chatMessages,
							readOnlyCallCounts,
						})
					} else {
						const mcpTool = mcpTools?.find(t => t.name === toolCall.name)
						toolResult = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, { preapproved: false, unvalidatedToolParams: toolCall.rawParams, fileEditCounts, readOnlyCallCounts, sandboxVerificationTracker })
					}

					if (toolResult.interrupted) {
						this._setStreamState(threadId, undefined)
						return
					}
					if (toolResult.awaitingUserApproval) {
						isRunningWhenEnd = 'awaiting_user'
					} else if (toolResult.status === 'error' || toolResult.status === 'invalid_params') {
						if (toolResult.status === 'invalid_params' && isEditToolName(toolCall.name)) {
							const lastToolMsg = this.state.allThreads[threadId]?.messages.filter(m => m.role === 'tool').at(-1)
							const validateError = lastToolMsg?.role === 'tool' && lastToolMsg.type === 'invalid_params' ? lastToolMsg.content : ''
							if (isMissingEditContentError(toolCall.name, validateError)
								|| isLikelyOutputTruncated(lastLlmOutputTokens, AGENT_ANTHROPIC_OUTPUT_TOKENS)
								|| isLikelyOutputTruncated(lastLlmOutputTokens, 8192)
							) {
								markTruncatedEditTool(editCompletionTracker)
								editCompletionHint = buildEditCompletionHint({ interruptedEditTool: false, truncatedEditTool: true })
								warnEditDiagnostic('completion_nudge', {
									turn: nMessagesSent,
									reason: 'truncated_edit_params',
									outputTokens: lastLlmOutputTokens,
								})
							}
						}
						consecutiveToolFails += 1
						if (consecutiveToolFails >= agentLoopLimits.maxConsecutiveToolFails) {
							this._addMessageToThread(threadId, {
								role: 'assistant',
								displayContent: `Stopped after ${agentLoopLimits.maxConsecutiveToolFails} consecutive tool failures. Review the errors above and try again.`,
								reasoning: '',
								anthropicReasoning: null,
							})
							this._metricsService.capture('Agent Loop Done (Consecutive Tool Failures)', { nMessagesSent, chatMode, consecutiveToolFails })
							break
						}
						shouldSendAnotherMessage = true
					} else {
						consecutiveToolFails = 0
						shouldSendAnotherMessage = true
					}

					this._setIdleStatus(threadId, 'Continuing agent', 'Tools finished · preparing next model call')
				} else {
					const lastUserMessage = [...chatMessages].reverse().find(m => m.role === 'user')
					const userMessageText = lastUserMessage?.role === 'user' ? lastUserMessage.content : ''
					const inRateLimitCooldown = modelSelection && getProviderRateLimitCooldownMs(modelSelection.providerName, modelSelection.modelName) > 0

					if (
						!inRateLimitCooldown
						&& needsEditCompletion({
							tracker: editCompletionTracker,
							fileEditCounts,
							readOnlyCallCount: readOnlyCallCounts.total,
							userMessage: userMessageText,
							chatMode,
						})
					) {
						const interrupted = editCompletionTracker.interruptedEditTool
						const truncated = editCompletionTracker.truncatedEditTool
						editCompletionTracker.nudgeCount += 1
						editCompletionTracker.interruptedEditTool = false
						editCompletionTracker.truncatedEditTool = false
						editCompletionHint = buildEditCompletionHint({ interruptedEditTool: interrupted, truncatedEditTool: truncated })
						shouldSendAnotherMessage = true
						logEditDiagnostic('completion_nudge', {
							turn: nMessagesSent,
							nudgeCount: editCompletionTracker.nudgeCount,
							interruptedEditTool: interrupted,
							readOnlyCalls: readOnlyCallCounts.total,
						})
						this._metricsService.capture('Agent Loop Edit Completion Nudge', {
							nMessagesSent,
							nudgeCount: editCompletionTracker.nudgeCount,
							interruptedEditTool: interrupted,
							readOnlyCalls: readOnlyCallCounts.total,
						})
						this._setIdleStatus(threadId, 'Edit required', interrupted ? 'Previous edit was interrupted — retrying' : 'Exploration done — file edit still required')
					} else if (
						chatMode === 'agent'
						&& needsSandboxVerification(sandboxVerificationTracker, fileEditCounts, this._repoIntelligenceService.getProfileSync())
						&& sandboxVerificationTracker.nudgeCount < MAX_SANDBOX_VERIFICATION_NUDGES
						&& !inRateLimitCooldown
					) {
						sandboxVerificationTracker.nudgeCount += 1
						sandboxVerificationHint = buildSandboxVerificationHint(this._repoIntelligenceService.getProfileSync())
						shouldSendAnotherMessage = true
						this._metricsService.capture('Agent Loop Verification Nudge', {
							nMessagesSent,
							nudgeCount: sandboxVerificationTracker.nudgeCount,
						})
						this._setIdleStatus(threadId, 'Sandbox verification required', 'Code changes need build/test/preview in terminal sandbox')
					}
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

		// add checkpoint before the next user message
		if (!isRunningWhenEnd) {
			this._completeRemainingPlanItems(threadId)
			const filesChanged = this._commandBarService.sortedURIs.map(uri => uri.fsPath)
			const pendingDiffCount = filesChanged.length
			if (pendingDiffCount > 1) {
				this._agentDeliveryService.setPendingDiffs(threadId, pendingDiffCount, filesChanged)
			}
			this._agentDeliveryService.finalizeDelivery(threadId)
			const nextSteps = this._agentDeliveryService.getNextStepsMessage(threadId)
			if (nextSteps) {
				this._addMessageToThread(threadId, {
					role: 'assistant',
					displayContent: nextSteps,
					reasoning: '',
					anthropicReasoning: null,
				})
			}
			this._onDidFinishAgentRun.fire({ threadId, pendingDiffCount, filesChanged })
			this._addUserCheckpoint({ threadId })
			this._terminalToolService.disposeSandboxSession()
			void this._processNextQueuedMessage(threadId)
		}

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', {
			nMessagesSent,
			chatMode,
			readOnlyCalls: readOnlyCallCounts.total,
			consecutiveToolFails,
			...(runTokenTotals.turns > 0 ? {
				tokenTurns: runTokenTotals.turns,
				tokenInput: runTokenTotals.totalInputTokens,
				tokenOutput: runTokenTotals.totalOutputTokens,
				tokenCacheRead: runTokenTotals.totalCacheReadTokens,
			} : {}),
		})
		} finally {
			if (runTokenTotals.turns > 0) {
				console.info(formatAgentRunTokenSummary(runTokenTotals))
			}
			// Persist the file reads so the next query in this thread can skip re-reads.
			if (readOnlyCallCounts.fileReads.size > 0) {
				const snapshot = new Map<string, FileReadRecord>()
				for (const [key, record] of readOnlyCallCounts.fileReads) {
					snapshot.set(key, { count: record.count, ranges: [...record.ranges], totalFileLen: record.totalFileLen })
				}
				this._threadFileReadHistory.set(threadId, snapshot)
			}
		}
	}


	private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
		this._addMessageToThread(threadId, checkpoint)
		// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _markPlanItemDone(threadId: string, toolName: ToolName, toolParams: ToolCallParams<ToolName>) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const planIdx = findLatestPlanMessageIdx(thread.messages)
		if (planIdx === -1) return
		const planMessage = thread.messages[planIdx]
		if (planMessage.role !== 'plan') return
		this._editMessageInThread(threadId, planIdx, markPlanItemDoneForTool(planMessage, toolName, toolParams))
	}

	private _completeRemainingPlanItems(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const planIdx = findLatestPlanMessageIdx(thread.messages)
		if (planIdx === -1) return
		const planMessage = thread.messages[planIdx]
		if (planMessage.role !== 'plan') return
		if (!planMessage.items.some(item => item.status === 'pending')) return
		this._editMessageInThread(threadId, planIdx, completeRemainingPlanItems(planMessage))
	}

	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voidFileSnapshot = checkpointMessage.voidFileSnapshotOfURI ? checkpointMessage.voidFileSnapshotOfURI[fsPath] ?? null : null
		if (!opts.includeUserModifiedChanges) { return { voidFileSnapshot, } }

		const userModifiedVoidFileSnapshot = fsPath in checkpointMessage.userModifications.voidFileSnapshotOfURI ? checkpointMessage.userModifications.voidFileSnapshotOfURI[fsPath] ?? null : null
		return { voidFileSnapshot: userModifiedVoidFileSnapshot ?? voidFileSnapshot, }
	}

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1
		if (lastCheckpointIdx === -1) return

		const voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } = {}

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {}
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._troveModelService.getModelFromFsPath(fsPath)
			if (!model) continue
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null
			if (!checkpoint2) continue
			if (checkpoint2.role !== 'checkpoint') continue
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false })
			if (!res) continue
			const { voidFileSnapshot: oldVoidFileSnapshot } = res

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voidFileSnapshot = this._editCodeService.getVoidFileSnapshot(URI.file(fsPath))
			if (oldVoidFileSnapshot === voidFileSnapshot) continue
			voidFileSnapshotOfURI[fsPath] = voidFileSnapshot
		}

		// // add a change for all user-edited files (that aren't in the history)
		// for (const fsPath of this._userModifiedFilesToCheckInCheckpoints.keys()) {
		// 	if (fsPath in lastIdxOfURI) continue // if already visisted, don't visit again
		// 	const { model } = this._troveModelService.getModelFromFsPath(fsPath)
		// 	if (!model) continue
		// 	currStrOfFsPath[fsPath] = model.getValue(EndOfLinePreference.LF)
		// }

		return { voidFileSnapshotOfURI }
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {},
			userModifications: { voidFileSnapshotOfURI: {}, },
		})
	}
	// call this right after LLM edits a file
	private _addToolEditCheckpoint({ threadId, uri, }: { threadId: string, uri: URI }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const { model } = this._troveModelService.getModel(uri)
		if (!model) return // should never happen
		const diffAreasSnapshot = this._editCodeService.getVoidFileSnapshot(uri)
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'tool_edit',
			voidFileSnapshotOfURI: { [uri.fsPath]: diffAreasSnapshot },
			userModifications: { voidFileSnapshotOfURI: {} },
		})
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string, messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i]
			if (message.role === 'checkpoint') {
				return [message, i]
			}
		}
		return undefined
	}

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string, loIdx: number, hiIdx: number }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return { lastIdxOfURI: {} } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {}
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i]
			if (message?.role !== 'checkpoint') continue
			for (const fsPath in message.voidFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i
			}
		}
		return { lastIdxOfURI }
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const { currCheckpointIdx } = thread.state
		if (currCheckpointIdx === null) return

		const checkpoint = thread.messages[currCheckpointIdx]
		if (!checkpoint) return
		if (checkpoint.role !== 'checkpoint') return
		return [checkpoint, currCheckpointIdx]
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		const res = this._readCurrentCheckpoint(threadId)
		if (!res) return
		const [checkpoint, checkpointIdx] = res
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {}, },
		})
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1]
			if (lastMsg?.role !== 'checkpoint')
				this._addUserCheckpoint({ threadId })
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 })
		}
	}

	jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string, messageIdx: number, jumpToUserModified: boolean }) {

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId })

		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (this.streamState[threadId]?.isRunning) return

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx })
		if (c === undefined) return // should never happen

		const fromIdx = thread.state.currCheckpointIdx
		if (fromIdx === null) return // should never happen

		const [_, toIdx] = c
		if (toIdx === fromIdx) return

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId })

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx })

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k
				}
			}

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx })
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx })
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? `Error: ${error} ` : `A new Chat result is ready.`,
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'trove.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		p.then(() => {
			const wasBackground = this.streamState[threadId]?.isRunning === 'background';
			if (wasBackground || threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			const wasBackground = this.streamState[threadId]?.isRunning === 'background';
			if (wasBackground || threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
			throw e
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	getMessageQueue(threadId: string): readonly QueuedUserMessage[] {
		return this._messageQueueByThread.get(threadId) ?? []
	}

	removeQueuedMessage(threadId: string, messageId: string): void {
		const queue = this._messageQueueByThread.get(threadId)
		if (!queue?.length) return
		const next = queue.filter(m => m.id !== messageId)
		if (next.length === queue.length) return
		if (next.length === 0) {
			this._messageQueueByThread.delete(threadId)
		} else {
			this._messageQueueByThread.set(threadId, next)
		}
		this._onDidChangeMessageQueue.fire({ threadId })
	}

	private _enqueueUserMessage({ userMessage, displayMessage, _chatSelections, threadId }: { userMessage: string, displayMessage?: string, _chatSelections?: StagingSelectionItem[], threadId: string }): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const trimmed = userMessage.trim()
		if (!trimmed) return

		const selections = _chatSelections ?? thread.state.stagingSelections
		const queued: QueuedUserMessage = {
			id: generateUuid(),
			userMessage: trimmed,
			displayMessage,
			selections: [...selections],
			queuedAt: new Date().toISOString(),
		}
		const queue = this._messageQueueByThread.get(threadId) ?? []
		queue.push(queued)
		this._messageQueueByThread.set(threadId, queue)
		this._onDidChangeMessageQueue.fire({ threadId })
	}

	private async _processNextQueuedMessage(threadId: string): Promise<void> {
		const queue = this._messageQueueByThread.get(threadId)
		if (!queue?.length) return
		if (this.streamState[threadId]?.isRunning) return

		const next = queue.shift()!
		if (queue.length === 0) {
			this._messageQueueByThread.delete(threadId)
		}
		this._onDidChangeMessageQueue.fire({ threadId })

		await this._startUserMessageAndStreamResponse({
			userMessage: next.userMessage,
			displayMessage: next.displayMessage,
			_chatSelections: next.selections,
			threadId,
		})
	}

	private async _startUserMessageAndStreamResponse({ userMessage, displayMessage, _chatSelections, threadId, _internalPrompt }: { userMessage: string, displayMessage?: string, _chatSelections?: StagingSelectionItem[], threadId: string, _internalPrompt?: boolean }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const instructions = userMessage.trim()
		if (!instructions) {
			this._setStreamState(threadId, { isRunning: undefined, error: { message: 'Cannot send an empty message.', fullError: null } })
			return
		}

		this._agentDeliveryService.clearDelivery(threadId)

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			this._addUserCheckpoint({ threadId })
		}


		// add user's message to chat history
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections

		this._setIdleStatus(threadId, 'Preparing request', 'Validating selections and attachments')

		const selectionError = await validateStagingSelections(currSelns, { fileService: this._fileService })
		if (selectionError) {
			this._setStreamState(threadId, { isRunning: undefined, error: { message: selectionError, fullError: null } })
			return
		}

		if (!_internalPrompt) {
			const mentionError = await findUnresolvedAtMentionsInText(instructions, {
				fileService: this._fileService,
				workspaceFolderUris: this._workspaceContextService.getWorkspace().folders.map(f => f.uri),
			})
			if (mentionError) {
				this._setStreamState(threadId, { isRunning: undefined, error: { message: mentionError, fullError: null } })
				return
			}
		}

		this._setIdleStatus(threadId, 'Preparing request', 'Gathering workspace context for your message')

		let userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }) // user message + names of files (NOT content)
		if (!userMessageContent.trim()) {
			userMessageContent = instructions
		}
		const userHistoryElt: ChatMessage = { role: 'user', content: userMessageContent, displayContent: displayMessage ?? instructions, selections: [...currSelns], state: defaultMessageState }
		this._addMessageToThread(threadId, userHistoryElt)

		const rememberFact = extractRememberIntent(instructions)
		if (rememberFact) {
			try {
				await this._repoIntelligenceService.appendToUserMemory(rememberFact)
				if (isRememberOnlyMessage(instructions)) {
					this._addMessageToThread(threadId, {
						role: 'assistant',
						displayContent: MEMORY_SAVED_CONFIRMATION,
						reasoning: '',
						anthropicReasoning: null,
					})
					this._setThreadState(threadId, { currCheckpointIdx: null })
					void this._processNextQueuedMessage(threadId)
					return
				}
			} catch (err) {
				this._notificationService.error(`Could not save to Trove memory: ${getErrorMessage(err)}`)
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: null }) // no longer at a checkpoint because started streaming

		if (_internalPrompt) {
			this._suppressAgentPlanByThread.set(threadId, true)
		}

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), }),
			threadId,
		)

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom()
		})
	}


	async addUserMessageAndStreamResponse({ userMessage, displayMessage, _chatSelections, threadId, _internalPrompt }: { userMessage: string, displayMessage?: string, _chatSelections?: StagingSelectionItem[], threadId: string, _internalPrompt?: boolean }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) {
			throw new Error(`Chat thread not found: ${threadId}`)
		}

		const trimmed = userMessage.trim()
		if (!trimmed) {
			return
		}

		if (this.streamState[threadId]?.isRunning) {
			this._enqueueUserMessage({ userMessage: trimmed, displayMessage, _chatSelections, threadId })
			return
		}

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}

		await this._startUserMessageAndStreamResponse({ userMessage: trimmed, displayMessage, _chatSelections, threadId, _internalPrompt });

	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || [] // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		})

		// re-add the message and stream it
		this._startUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId })
	}

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) uris.push(uri)
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					if ('uri' in sel && sel.uri) {
						addURI(sel.uri)
					}
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri)
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			if (f) { return uri.fsPath.replace(f.uri.fsPath, '') }
			else { return undefined }
		}
		else {
			return undefined
		}
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._troveModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread()

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined
	}

	switchToThread(threadId: string) {
		this._setState({ currentThreadId: threadId })
	}


	openNewThread() {
		// if a thread with 0 messages already exists, switch to it
		const { allThreads: currentThreads } = this.state
		for (const threadId in currentThreads) {
			if (currentThreads[threadId]!.messages.length === 0) {
				// switch to the existing empty thread and exit
				this.switchToThread(threadId)
				return
			}
		}
		this.openThreadForAgentRun()
	}

	openThreadForAgentRun(): string {
		const { allThreads: currentThreads } = this.state
		const newThread = newThreadObject()
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id })
		return newThread.id
	}


	deleteThread(threadId: string): void {
		const { allThreads: currentThreads } = this.state

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];

		this._messageQueueByThread.delete(threadId)
		this._threadFileReadHistory.delete(threadId)
		this._suppressAgentPlanByThread.delete(threadId)

		// store the updated threads
		this._storeAllThreads(newThreads);
		this._setState({ ...this.state, allThreads: newThreads })
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}

	renameThread(threadId: string, title: string): void {
		const { allThreads: currentThreads } = this.state
		const thread = currentThreads[threadId]
		if (!thread) return

		const trimmedTitle = title.trim()
		const newThreads = {
			...currentThreads,
			[threadId]: {
				...thread,
				title: trimmedTitle || undefined,
				lastModified: new Date().toISOString(),
			},
		}
		this._storeAllThreads(newThreads)
		this._setState({ ...this.state, allThreads: newThreads })
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					message
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx)
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
