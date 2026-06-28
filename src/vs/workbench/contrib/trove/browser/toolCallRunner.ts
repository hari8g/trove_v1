/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { isABuiltinToolName } from '../common/prompt/prompts.js';
import { getErrorMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, TerminalResolveReason, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITroveSettingsService } from '../common/troveSettingsService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { IAgentDeliveryService } from './agentDeliveryService.js';
import { trackFileEdit } from './agentEditHints.js';
import { isEditToolName } from './agentEditCompletionHints.js';
import { errorEditDiagnostic, logEditDiagnostic, uriPathForLog, warnEditDiagnostic } from './agentEditDiagnostics.js';
import { shouldSkipDuplicateFileRead, recordFileReadSize } from './fileReadDedup.js';
import { createReadOnlyCallCounts, trackReadOnlyCall } from './agentReadHints.js';
import { markSandboxCodeChange, markSandboxVerified, SandboxVerificationTracker } from './agentVerificationHints.js';
import { IToolsService } from './toolsService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IWorkspacePreviewService } from './workspacePreviewService.js';
import { isCompactableToolName } from './toolResultCompaction.js';
import type { ThreadStreamState } from './chatThreadService.js';

export type ToolCallLoopResult = {
	awaitingUserApproval?: boolean;
	interrupted?: boolean;
	status?: 'ok' | 'error' | 'invalid_params';
};

export type RunToolCallOpts = ({ preapproved: true; unvalidatedToolParams: RawToolParamsObj; validatedParams: ToolCallParams<ToolName> } | { preapproved: false; unvalidatedToolParams: RawToolParamsObj }) & {
	batchInsert?: boolean;
	fileEditCounts?: Map<string, number>;
	readOnlyCallCounts?: ReturnType<typeof createReadOnlyCallCounts>;
	sandboxVerificationTracker?: SandboxVerificationTracker;
};

const DIRECTORY_TREE_INVALIDATING_TOOLS = new Set<ToolName>([
	'edit_file',
	'rewrite_file',
	'create_file_or_folder',
	'delete_file_or_folder',
	'run_command',
	'run_persistent_command',
]);

export type ToolCallRunnerDeps = {
	toolsService: IToolsService;
	mcpService: IMCPService;
	settingsService: ITroveSettingsService;
	terminalToolService: ITerminalToolService;
	agentDeliveryService: IAgentDeliveryService;
	directoryStringService: IDirectoryStrService;
	workspacePreviewService: IWorkspacePreviewService;
	errWhenStringifying: (error: unknown) => string;
	addMessageToThread: (threadId: string, message: ChatMessage) => void;
	updateLatestTool: (threadId: string, tool: ChatMessage & { role: 'tool' }, opts?: { batchInsert?: boolean }) => void;
	setStreamState: (threadId: string, state: ThreadStreamState[string]) => void;
	getStreamState: (threadId: string) => ThreadStreamState[string] | undefined;
	addToolEditCheckpoint: (opts: { threadId: string; uri: URI }) => void;
	markPlanItemDone: (threadId: string, toolName: ToolName, toolParams: ToolCallParams<ToolName>) => void;
};

export const createRunToolCall = (deps: ToolCallRunnerDeps) => async (
	threadId: string,
	toolName: ToolName,
	toolId: string,
	mcpServerName: string | undefined,
	opts: RunToolCallOpts,
): Promise<ToolCallLoopResult> => {
	let toolParams: ToolCallParams<ToolName>;
	let toolResult!: ToolResult<ToolName>;
	let toolResultStr: string | undefined;

	const isBuiltInTool = isABuiltinToolName(toolName);

	if (!opts.preapproved) {
		try {
			if (isBuiltInTool) {
				toolParams = deps.toolsService.validateParams[toolName](opts.unvalidatedToolParams);
			} else {
				toolParams = opts.unvalidatedToolParams;
			}
		} catch (error) {
			const errorMessage = getErrorMessage(error);
			if (isEditToolName(toolName)) {
				errorEditDiagnostic('tool_validate_fail', {
					toolName,
					toolId,
					error: errorMessage,
					rawParamKeys: Object.keys(opts.unvalidatedToolParams).join(','),
				});
			}
			deps.addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName });
			return { status: 'invalid_params' };
		}
		if (toolName === 'edit_file') {
			deps.addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['edit_file']).uri });
		}
		if (toolName === 'rewrite_file') {
			deps.addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['rewrite_file']).uri });
		}
		if (isEditToolName(toolName)) {
			logEditDiagnostic('tool_validate_ok', {
				toolName,
				toolId,
				uri: uriPathForLog((toolParams as { uri?: URI }).uri),
			});
		}

		const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools';
		if (approvalType) {
			const { autoApprove, autoApproveAll } = deps.settingsService.state.globalSettings;
			const isApproved = autoApproveAll || autoApprove[approvalType];
			deps.addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName });
			if (!isApproved) {
				if (isEditToolName(toolName)) {
					warnEditDiagnostic('tool_approval_blocked', { toolName, toolId, approvalType });
				}
				return { awaitingUserApproval: true };
			}
		}
	} else {
		toolParams = opts.validatedParams;
	}

	let skippedFileReadMessage: string | undefined;
	if (toolName === 'read_file' && opts.readOnlyCallCounts) {
		const readParams = toolParams as BuiltinToolCallParams['read_file'];
		const skip = shouldSkipDuplicateFileRead(
			opts.readOnlyCallCounts.fileReads,
			readParams.uri,
			readParams.startLine,
			readParams.endLine,
		);
		if (skip.skip) {
			skippedFileReadMessage = skip.message;
		}
	}

	if (opts.readOnlyCallCounts) {
		trackReadOnlyCall(opts.readOnlyCallCounts, toolName, opts.unvalidatedToolParams);
	}

	const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: toolName === 'run_command' || toolName === 'run_persistent_command' ? '(starting terminal sandbox…)' : '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const;
	deps.updateLatestTool(threadId, runningTool, { batchInsert: opts.batchInsert });

	if (isEditToolName(toolName)) {
		logEditDiagnostic('tool_dispatch', {
			toolName,
			toolId,
			uri: uriPathForLog((toolParams as { uri?: URI }).uri),
		});
	}

	let interrupted = false;
	let resolveInterruptor: (r: () => void) => void = () => { };
	const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res; });
	let liveOutputDisposable: IDisposable | undefined;
	try {
		const initialToolContent = toolName === 'run_command' || toolName === 'run_persistent_command'
			? '(starting terminal sandbox…)'
			: 'interrupted...';
		deps.setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: initialToolContent, rawParams: opts.unvalidatedToolParams, mcpServerName } });

		if (toolName === 'run_command' || toolName === 'run_persistent_command') {
			const terminalKey = toolName === 'run_command'
				? (toolParams as BuiltinToolCallParams['run_command']).terminalId
				: (toolParams as BuiltinToolCallParams['run_persistent_command']).persistentTerminalId;
			liveOutputDisposable = deps.terminalToolService.registerLiveOutputListener(terminalKey, (output) => {
				const preview = output.length > 12_000 ? '…\n' + output.slice(-12_000) : output;
				const content = preview.trim() ? preview : '(waiting for terminal output…)';
				const command = (toolParams as { command?: string }).command ?? '';
				deps.agentDeliveryService.handleLiveTerminalOutput(threadId, command, output);
				deps.updateLatestTool(threadId, { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content, result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName }, { batchInsert: opts.batchInsert });
				const stream = deps.getStreamState(threadId);
				if (stream?.isRunning === 'tool') {
					deps.setStreamState(threadId, { isRunning: 'tool', interrupt: stream.interrupt, toolInfo: { ...stream.toolInfo, content } });
				}
			});
		}

		if (isBuiltInTool) {
			if (skippedFileReadMessage !== undefined) {
				resolveInterruptor(() => { });
			} else {
				const callPromise = deps.toolsService.callTool[toolName](toolParams as never);

				if (toolName === 'run_command' || toolName === 'run_persistent_command') {
					callPromise.then(({ interruptTool }) => {
						resolveInterruptor(() => { interrupted = true; interruptTool?.(); });
					}).catch(() => { resolveInterruptor(() => { }); });
				}

				const { result, interruptTool } = await callPromise;
				if (toolName !== 'run_command' && toolName !== 'run_persistent_command') {
					resolveInterruptor(() => { interrupted = true; interruptTool?.(); });
				}

				toolResult = await result;
			}
		} else {
			const mcpTools = deps.mcpService.getMCPTools();
			const mcpTool = mcpTools?.find(t => t.name === toolName);
			if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`); }

			resolveInterruptor(() => { });

			toolResult = (await deps.mcpService.callMCPTool({
				serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
				toolName,
				params: toolParams,
			})).result;
		}

		if (interrupted) { return { interrupted: true }; }
	} catch (error) {
		resolveInterruptor(() => { });
		if (interrupted) { return { interrupted: true }; }

		const errorMessage = getErrorMessage(error);
		if (isEditToolName(toolName)) {
			errorEditDiagnostic('tool_execute_error', { toolName, toolId, error: errorMessage });
		}
		deps.updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName }, { batchInsert: opts.batchInsert });
		return { status: 'error' };
	} finally {
		liveOutputDisposable?.dispose();
	}

	try {
		if (skippedFileReadMessage !== undefined) {
			toolResultStr = skippedFileReadMessage;
		} else if (isBuiltInTool) {
			toolResultStr = deps.toolsService.stringOfResult[toolName](toolParams as never, toolResult as never);
		} else {
			toolResultStr = deps.mcpService.stringifyResult(toolResult as RawMCPToolCall);
		}
	} catch (error) {
		const errorMessage = deps.errWhenStringifying(error);
		deps.updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName }, { batchInsert: opts.batchInsert });
		return { status: 'error' };
	}

	deps.updateLatestTool(threadId, {
		role: 'tool',
		type: 'success',
		params: toolParams,
		result: skippedFileReadMessage !== undefined
			? { fileContents: '', totalFileLen: 0, totalNumLines: 0, hasNextPage: false }
			: toolResult,
		name: toolName,
		content: toolResultStr!,
		id: toolId,
		rawParams: opts.unvalidatedToolParams,
		mcpServerName,
		compactable: isCompactableToolName(toolName),
	}, { batchInsert: opts.batchInsert });

	if (toolName === 'read_file' && opts.readOnlyCallCounts && toolResult && typeof toolResult === 'object' && 'totalFileLen' in toolResult) {
		const readParams = toolParams as BuiltinToolCallParams['read_file'];
		recordFileReadSize(opts.readOnlyCallCounts.fileReads, readParams.uri, (toolResult as { totalFileLen: number }).totalFileLen);
	}

	if (isEditToolName(toolName)) {
		logEditDiagnostic('tool_execute_done', {
			toolName,
			toolId,
			uri: uriPathForLog((toolParams as { uri?: URI }).uri),
		});
	}

	if (DIRECTORY_TREE_INVALIDATING_TOOLS.has(toolName)) {
		deps.directoryStringService.invalidateCache();
	}

	deps.markPlanItemDone(threadId, toolName, toolParams);

	if (opts.fileEditCounts && (toolName === 'edit_file' || toolName === 'rewrite_file')) {
		trackFileEdit(opts.fileEditCounts, toolName, toolParams as Record<string, unknown>);
		if (opts.sandboxVerificationTracker) {
			markSandboxCodeChange(opts.sandboxVerificationTracker);
		}
		if (deps.workspacePreviewService.getActivePreviewUrl()) {
			deps.workspacePreviewService.scheduleReloadAfterWebChange();
		}
	} else if (opts.sandboxVerificationTracker && toolName === 'create_file_or_folder') {
		const createParams = toolParams as BuiltinToolCallParams['create_file_or_folder'];
		if (!createParams.isFolder) {
			markSandboxCodeChange(opts.sandboxVerificationTracker);
		}
	}

	if (toolName === 'run_command') {
		const runParams = toolParams as BuiltinToolCallParams['run_command'];
		const runResult = toolResult as { result: string; resolveReason: TerminalResolveReason; autoPersistentTerminalId?: string };
		if (opts.sandboxVerificationTracker) {
			markSandboxVerified(opts.sandboxVerificationTracker, runParams.command, runResult.result, runResult.resolveReason);
		}
		void deps.agentDeliveryService.handleTerminalToolResult(
			threadId,
			'run_command',
			runParams,
			runResult,
		);
	} else if (toolName === 'run_persistent_command') {
		void deps.agentDeliveryService.handleTerminalToolResult(
			threadId,
			'run_persistent_command',
			toolParams as BuiltinToolCallParams['run_persistent_command'],
			toolResult as { result: string; resolveReason: TerminalResolveReason },
		);
	}

	return { status: 'ok' };
};
