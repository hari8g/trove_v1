/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { buildRiafAgentPrompt } from '../common/riaf/riafPrompts.js';
import {
	buildRiafConfig,
	IRiafAgentService,
	RIAF_USER_DISPLAY_MESSAGE,
	RiafConfig,
	RiafRunState,
} from '../common/riaf/riafTypes.js';
import { ChatMode, GlobalSettings } from '../common/troveSettingsTypes.js';

/** Raised limits for the duration of a RIAF run (clamped by getAgentLoopLimits). */
export const RIAF_MAX_READONLY_CALLS = 50;
export const RIAF_MAX_AGENT_ITERATIONS = 40;

export type RiafSettingsSnapshot = {
	chatMode: ChatMode;
	autoApproveEdits: boolean | undefined;
	maxReadOnlyCalls: number;
	maxAgentIterations: number;
};

export type RiafChatThreadPort = {
	readonly state: { currentThreadId: string };
	readonly onDidFinishAgentRun: Event<{ threadId: string; pendingDiffCount: number; filesChanged: string[] }>;
	openNewThread(): void;
	addUserMessageAndStreamResponse(opts: { userMessage: string; threadId: string; displayMessage?: string }): Promise<void>;
	abortRunning(threadId: string): Promise<void>;
};

export type RiafSettingsPort = {
	readonly state: { globalSettings: GlobalSettings };
	setGlobalSetting<K extends keyof GlobalSettings>(name: K, value: GlobalSettings[K]): void;
};

export type RiafWorkspacePort = {
	getWorkspace(): { folders: ReadonlyArray<{ uri: URI; name: string }> };
};

export type RiafFilePort = {
	exists(uri: URI): Promise<boolean>;
};

export const snapshotRiafSettings = (globalSettings: GlobalSettings): RiafSettingsSnapshot => ({
	chatMode: globalSettings.chatMode,
	autoApproveEdits: globalSettings.autoApprove.edits,
	maxReadOnlyCalls: globalSettings.maxReadOnlyCalls,
	maxAgentIterations: globalSettings.maxAgentIterations,
});

export const buildRiafSettingsPatches = (
	globalSettings: GlobalSettings,
): { snapshot: RiafSettingsSnapshot; overrides: Array<{ name: keyof GlobalSettings; value: GlobalSettings[keyof GlobalSettings] }> } => {
	const snapshot = snapshotRiafSettings(globalSettings);
	return {
		snapshot,
		overrides: [
			{ name: 'chatMode', value: 'agent' },
			{ name: 'autoApprove', value: { ...globalSettings.autoApprove, edits: true } },
			{ name: 'maxReadOnlyCalls', value: RIAF_MAX_READONLY_CALLS },
			{ name: 'maxAgentIterations', value: RIAF_MAX_AGENT_ITERATIONS },
		],
	};
};

export const buildRiafSettingsRestorePatches = (
	globalSettings: GlobalSettings,
	snapshot: RiafSettingsSnapshot,
): Array<{ name: keyof GlobalSettings; value: GlobalSettings[keyof GlobalSettings] }> => ([
	{ name: 'chatMode', value: snapshot.chatMode },
	{ name: 'autoApprove', value: { ...globalSettings.autoApprove, edits: snapshot.autoApproveEdits } },
	{ name: 'maxReadOnlyCalls', value: snapshot.maxReadOnlyCalls },
	{ name: 'maxAgentIterations', value: snapshot.maxAgentIterations },
]);

export class RiafAgentRunController extends Disposable implements IRiafAgentService {
	readonly _serviceBrand: undefined;

	private _state: RiafRunState = { status: 'idle' };
	private _outputFileName: string;
	private _settingsSnapshot: RiafSettingsSnapshot | null = null;
	private _userAborted = false;

	private readonly _onDidChangeState = this._register(new Emitter<RiafRunState>());
	readonly onDidChangeState: Event<RiafRunState> = this._onDidChangeState.event;

	constructor(
		private readonly _chatThread: RiafChatThreadPort,
		private readonly _settings: RiafSettingsPort,
		private readonly _workspace: RiafWorkspacePort,
		private readonly _files: RiafFilePort,
	) {
		super();
		this._outputFileName = this._deriveOutputFileName();

		this._register(
			this._chatThread.onDidFinishAgentRun(async ({ threadId }) => {
				if (this._state.status !== 'running' || this._state.threadId !== threadId) {
					return;
				}
				await this._handleRunFinished(threadId);
			}),
		);
	}

	get state(): RiafRunState {
		return this._state;
	}

	get expectedOutputFileName(): string {
		return this._outputFileName;
	}

	private _deriveOutputFileName(override?: Partial<RiafConfig>): string {
		const folder = this._workspace.getWorkspace().folders[0];
		return buildRiafConfig(folder?.name ?? 'repo', override).outputFileName;
	}

	private _setState(state: RiafRunState): void {
		this._state = state;
		this._onDidChangeState.fire(state);
	}

	private async _applyRiafSettingsOverrides(): Promise<void> {
		const { snapshot, overrides } = buildRiafSettingsPatches(this._settings.state.globalSettings);
		this._settingsSnapshot = snapshot;
		for (const patch of overrides) {
			await this._settings.setGlobalSetting(patch.name, patch.value as GlobalSettings[typeof patch.name]);
		}
	}

	private async _restoreSettings(): Promise<void> {
		const snap = this._settingsSnapshot;
		if (!snap) {
			return;
		}
		this._settingsSnapshot = null;
		const patches = buildRiafSettingsRestorePatches(this._settings.state.globalSettings, snap);
		for (const patch of patches) {
			await this._settings.setGlobalSetting(patch.name, patch.value as GlobalSettings[typeof patch.name]);
		}
	}

	private _outputUri(): URI | null {
		const folder = this._workspace.getWorkspace().folders[0];
		if (!folder) {
			return null;
		}
		return URI.joinPath(folder.uri, this._outputFileName);
	}

	private async _handleRunFinished(threadId: string): Promise<void> {
		if (this._userAborted) {
			return;
		}
		const uri = this._outputUri();
		const outputPath = uri?.fsPath ?? '';
		await this._restoreSettings();

		if (uri && await this._files.exists(uri)) {
			this._setState({ status: 'done', threadId, outputPath });
		} else {
			this._setState({
				status: 'error',
				threadId,
				message: `Agent run finished but ${this._outputFileName} was not written. Check the thread for details.`,
			});
		}
	}

	async startRun(configOverride?: Partial<RiafConfig>): Promise<void> {
		if (this._state.status === 'running') {
			return;
		}

		const root = this._workspace.getWorkspace().folders[0]?.uri.fsPath;
		if (!root) {
			this._setState({ status: 'error', threadId: '', message: 'No workspace folder open.' });
			return;
		}

		const folder = this._workspace.getWorkspace().folders[0]!;
		const config = buildRiafConfig(folder.name, configOverride);
		this._outputFileName = config.outputFileName;

		this._chatThread.openNewThread();
		const threadId = this._chatThread.state.currentThreadId;

		await this._applyRiafSettingsOverrides();
		this._setState({ status: 'running', threadId });

		try {
			await this._chatThread.addUserMessageAndStreamResponse({
				userMessage: buildRiafAgentPrompt(root, folder.name, config),
				displayMessage: RIAF_USER_DISPLAY_MESSAGE,
				threadId,
			});
		} catch (err) {
			await this._restoreSettings();
			this._setState({
				status: 'error',
				threadId,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async abort(): Promise<void> {
		if (this._state.status !== 'running') {
			return;
		}
		const { threadId } = this._state;
		this._userAborted = true;
		await this._chatThread.abortRunning(threadId);
		await this._restoreSettings();
		this._setState({ status: 'idle' });
		this._userAborted = false;
	}
}
