/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AgentDeliverySummary, AgentDeliveryStatus } from '../common/agentDeliveryTypes.js';
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js';
import { BuiltinToolCallParams, TerminalResolveReason } from '../common/toolsServiceTypes.js';
import { IWorkspacePreviewService } from './workspacePreviewService.js';
import { isDevServerCommand, isPackageInstallCommand, isLongRunningTerminalCommand, terminalCommandLooksSuccessful, DEV_SERVER_COMMAND_PATTERN } from '../common/prompt/prompts.js';
import { SERVER_READY_OUTPUT_PATTERN } from '../common/prompt/prompts.js';

const LOCALHOST_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'<>]*)?/gi;
const LOCALHOST_HOST_PORT_PATTERN = /(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/gi;

export interface IAgentDeliveryService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeDelivery: Event<{ threadId: string }>;

	getDelivery(threadId: string): AgentDeliverySummary | undefined;
	clearDelivery(threadId: string): void;

	/** Called on every terminal output chunk while a tool runs — opens preview as soon as server is ready. */
	handleLiveTerminalOutput(threadId: string, command: string, output: string): void;

	handleTerminalToolResult(
		threadId: string,
		toolName: 'run_command' | 'run_persistent_command',
		params: BuiltinToolCallParams['run_command'] | BuiltinToolCallParams['run_persistent_command'],
		result: { result: string; resolveReason: TerminalResolveReason; autoPersistentTerminalId?: string },
	): Promise<void>;

	finalizeDelivery(threadId: string): void;
	setPendingDiffs(threadId: string, pendingDiffCount: number, filesChanged: string[]): void;
}

export const IAgentDeliveryService = createDecorator<IAgentDeliveryService>('AgentDeliveryService');

const isLocalhostCurlCommand = (command: string): boolean =>
	/\b(curl|wget|httpie|httpx)\b/i.test(command) && /\b(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)\b/i.test(command);

const isBuildOrCompileCommand = (command: string): boolean =>
	isLongRunningTerminalCommand(command) && !isDevServerCommand(command);

const extractLocalhostUrl = (text: string, command?: string): string | undefined => {
	const plain = removeAnsiEscapeCodes(text);

	const fromCommand = command?.match(/(?:curl|wget|httpie|httpx)\s+['"]?(https?:\/\/[^\s'"]+|localhost[^\s'"]*)/i)?.[1];
	if (fromCommand) {
		if (fromCommand.startsWith('http')) return fromCommand.replace(/['"]$/, '');
		if (/^localhost/i.test(fromCommand)) return `http://${fromCommand.replace(/['"]$/, '')}`;
	}

	const urlMatches = plain.match(LOCALHOST_URL_PATTERN);
	if (urlMatches?.length) {
		const url = urlMatches[urlMatches.length - 1];
		return url.replace(/['",;)]+$/, '');
	}

	const ports = [...plain.matchAll(LOCALHOST_HOST_PORT_PATTERN)];
	if (ports.length) {
		const port = ports[ports.length - 1][1];
		return `http://localhost:${port}`;
	}

	return undefined;
};

const commandSucceeded = (command: string, output: string, resolveReason: TerminalResolveReason): boolean => {
	if (resolveReason.type === 'server_ready') return true
	if (resolveReason.type === 'timeout' && resolveReason.reason === 'snapshot') return true
	if (resolveReason.type === 'done' && resolveReason.exitCode === 0) {
		return terminalCommandLooksSuccessful(command, output, resolveReason.exitCode)
	}
	return false
}

const shortCommandLabel = (command: string): string => {
	const trimmed = command.trim();
	if (trimmed.length <= 64) return trimmed;
	return trimmed.slice(0, 61) + '...';
};

class AgentDeliveryService extends Disposable implements IAgentDeliveryService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeDelivery = this._register(new Emitter<{ threadId: string }>());
	readonly onDidChangeDelivery = this._onDidChangeDelivery.event;

	private readonly _deliveryByThread = new Map<string, AgentDeliverySummary>();

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IRepoIntelligenceService private readonly repoIntelligenceService: IRepoIntelligenceService,
		@IWorkspacePreviewService private readonly workspacePreviewService: IWorkspacePreviewService,
	) {
		super();
	}

	getDelivery(threadId: string): AgentDeliverySummary | undefined {
		return this._deliveryByThread.get(threadId);
	}

	clearDelivery(threadId: string): void {
		if (this._deliveryByThread.delete(threadId)) {
			this._onDidChangeDelivery.fire({ threadId });
		}
	}

	private _mergeDelivery(threadId: string, patch: Partial<AgentDeliverySummary> & { status: AgentDeliveryStatus }): AgentDeliverySummary {
		const prev = this._deliveryByThread.get(threadId);
		const next: AgentDeliverySummary = {
			status: patch.status,
			buildCommand: patch.buildCommand ?? prev?.buildCommand,
			serverCommand: patch.serverCommand ?? prev?.serverCommand,
			previewUrl: patch.previewUrl ?? prev?.previewUrl,
			buildLabel: patch.buildLabel ?? prev?.buildLabel,
			serverLabel: patch.serverLabel ?? prev?.serverLabel,
			previewOpenedInEditor: patch.previewOpenedInEditor ?? prev?.previewOpenedInEditor ?? false,
			updatedAt: new Date().toISOString(),
		};
		this._deliveryByThread.set(threadId, next);
		this._onDidChangeDelivery.fire({ threadId });
		return next;
	}

	private _suggestedServerCommand(): string | undefined {
		const profile = this.repoIntelligenceService.getProfileSync();
		const start = profile?.buildCommands.find(c => c.purpose === 'start');
		if (start) return start.command;
		const pm = profile?.packageManagers[0] ?? 'npm';
		for (const name of ['dev', 'start', 'serve', 'server']) {
			const candidate = `${pm} run ${name}`;
			if (DEV_SERVER_COMMAND_PATTERN.test(candidate)) return candidate;
		}
		return undefined;
	}

	private async _openPreviewInEditor(url: string): Promise<boolean> {
		const opened = await this.workspacePreviewService.openPreview(url);
		if (opened) {
			return true;
		}
		this.notificationService.warn(`Could not open ${url} in the workspace browser. Use "Open in editor" from the delivery card.`);
		return false;
	}

	handleLiveTerminalOutput(threadId: string, command: string, output: string): void {
		if (!command.trim() || !output.trim()) {
			return;
		}
		const isDev = isDevServerCommand(command);
		const isCurl = isLocalhostCurlCommand(command);
		if (!isDev && !isCurl) {
			return;
		}
		if (isDev && !SERVER_READY_OUTPUT_PATTERN.test(output) && !/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d{2,5}/i.test(output)) {
			return;
		}
		const delivery = this._deliveryByThread.get(threadId);
		if (delivery?.previewOpenedInEditor) {
			void this.workspacePreviewService.tryOpenFromTerminalOutput(output, command);
			return;
		}
		void this.workspacePreviewService.tryOpenFromTerminalOutput(output, command).then(opened => {
			if (!opened) return;
			const previewUrl = this.workspacePreviewService.getActivePreviewUrl();
			this._mergeDelivery(threadId, {
				status: isCurl ? 'verified' : 'server_running',
				serverCommand: isDev ? command : delivery?.serverCommand,
				serverLabel: isDev ? shortCommandLabel(command) : delivery?.serverLabel,
				previewUrl,
				previewOpenedInEditor: true,
			});
			if (isDev && previewUrl) {
				this.notificationService.info(`Dev server ready — opened ${previewUrl} in the editor.`);
			}
		});
	}

	async handleTerminalToolResult(
		threadId: string,
		toolName: 'run_command' | 'run_persistent_command',
		params: BuiltinToolCallParams['run_command'] | BuiltinToolCallParams['run_persistent_command'],
		result: { result: string; resolveReason: TerminalResolveReason; autoPersistentTerminalId?: string },
	): Promise<void> {
		const command = 'command' in params ? params.command : '';
		const { resolveReason, result: rawOutput } = result;
		const plainOutput = removeAnsiEscapeCodes(rawOutput);
		if (!commandSucceeded(command, plainOutput, resolveReason)) return;
		const url = extractLocalhostUrl(plainOutput, command);

		// Localhost curl / HTTP check succeeded
		if (isLocalhostCurlCommand(command) && resolveReason.type === 'done' && resolveReason.exitCode === 0) {
			const previewUrl = url ?? extractLocalhostUrl(plainOutput);
			let previewOpenedInEditor = false;
			if (previewUrl) {
				previewOpenedInEditor = await this._openPreviewInEditor(previewUrl);
				if (previewOpenedInEditor) {
					this.notificationService.info(`Verified — opened ${previewUrl} in the editor.`);
				}
			}
			this._mergeDelivery(threadId, {
				status: 'verified',
				previewUrl,
				previewOpenedInEditor,
			});
			return;
		}

		// Dev server started
		if (isDevServerCommand(command) || toolName === 'run_persistent_command') {
			const previewUrl = url;
			let previewOpenedInEditor = false;
			if (previewUrl && (resolveReason.type === 'server_ready' || resolveReason.type === 'timeout')) {
				previewOpenedInEditor = await this._openPreviewInEditor(previewUrl);
			}
			this._mergeDelivery(threadId, {
				status: previewUrl && previewOpenedInEditor ? 'verified' : 'server_running',
				serverCommand: command,
				serverLabel: shortCommandLabel(command),
				previewUrl,
				previewOpenedInEditor,
			});
			return;
		}

		// Package install succeeded in sandbox (writes to real workspace)
		if (isPackageInstallCommand(command) && resolveReason.type === 'done') {
			const serverCommand = this._suggestedServerCommand();
			this._mergeDelivery(threadId, {
				status: 'build_succeeded',
				buildCommand: command,
				buildLabel: shortCommandLabel(command),
				serverCommand,
				serverLabel: serverCommand ? shortCommandLabel(serverCommand) : undefined,
			});
			return;
		}

		// Build / compile / test succeeded in sandbox (terminal auto-closed)
		if (isBuildOrCompileCommand(command) && resolveReason.type === 'done') {
			const serverCommand = this._suggestedServerCommand();
			this._mergeDelivery(threadId, {
				status: 'build_succeeded',
				buildCommand: command,
				buildLabel: shortCommandLabel(command),
				serverCommand,
				serverLabel: serverCommand ? shortCommandLabel(serverCommand) : undefined,
				previewUrl: url,
			});
		}
	}

	finalizeDelivery(threadId: string): void {
		const delivery = this._deliveryByThread.get(threadId);
		if (!delivery) return;

		if (delivery.previewUrl && !delivery.previewOpenedInEditor
			&& (delivery.status === 'server_running' || delivery.status === 'verified' || delivery.status === 'build_succeeded')) {
			void this._openPreviewInEditor(delivery.previewUrl).then(opened => {
				if (opened) {
					this._mergeDelivery(threadId, {
						status: delivery.status,
						previewOpenedInEditor: true,
						previewUrl: delivery.previewUrl,
					});
				}
			});
			return;
		}

		if (delivery.status === 'server_running' && delivery.previewUrl && !delivery.previewOpenedInEditor) {
			this._onDidChangeDelivery.fire({ threadId });
		}
	}

	setPendingDiffs(threadId: string, pendingDiffCount: number, filesChanged: string[]): void {
		const prev = this._deliveryByThread.get(threadId);
		const next: AgentDeliverySummary = {
			status: prev?.status ?? 'build_succeeded',
			buildCommand: prev?.buildCommand,
			serverCommand: prev?.serverCommand,
			previewUrl: prev?.previewUrl,
			buildLabel: prev?.buildLabel,
			serverLabel: prev?.serverLabel,
			previewOpenedInEditor: prev?.previewOpenedInEditor ?? false,
			updatedAt: new Date().toISOString(),
			pendingDiffCount,
			filesChanged,
		};
		this._deliveryByThread.set(threadId, next);
		this._onDidChangeDelivery.fire({ threadId });
	}
}

registerSingleton(IAgentDeliveryService, AgentDeliveryService, InstantiationType.Delayed);
