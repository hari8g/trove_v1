/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js';
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IRepoIntelligenceMainService, REPO_INTEL_PROFILE_STALE_MS, WorkspaceProfile } from '../../common/repoIntelligenceTypes.js';
import { TROVE_SETTINGS_STORAGE_KEY } from '../../common/storageKeys.js';
import { TroveSettingsState } from '../../common/troveSettingsService.js';
import { IMetricsService } from '../../common/metricsService.js';
import { sendLLMMessage } from '../llmMessage/sendLLMMessage.js';
import { detectCommands } from './commandDetector.js';
import { getRepoIntelligenceDbPath, hashWorkspaceRoot, RepoIntelligenceDb } from './repoIntelligenceDb.js';
import { RawScanResult, scanWorkspace } from './workspaceScanner.js';

const ARCH_SUMMARY_SYSTEM_PROMPT = `You are a software architect. Given scan data about a codebase, write a concise 2-4 sentence architecture summary describing the project's structure, main components, and technology patterns. Output plain text only, no markdown.`;

const PURPOSE_SUMMARY_SYSTEM_PROMPT = `You are a software analyst. Given scan data about a codebase, write a concise 1-2 sentence description of what this project does and its primary purpose. Output plain text only, no markdown.`;

const buildScanContext = (scan: RawScanResult, commands: ReturnType<typeof detectCommands>, workspaceRoot: string): string => {
	const topFiles = scan.fileMeta
		.filter(f => f.language)
		.slice(0, 30)
		.map(f => f.filePath);

	return JSON.stringify({
		workspaceRoot,
		languages: scan.languages,
		frameworks: scan.frameworks.map(f => f.name),
		packageManagers: scan.packageManagers,
		fileCount: scan.fileCount,
		totalLoc: scan.totalLoc,
		buildCommands: commands.buildCommands.slice(0, 3).map(c => c.command),
		testCommands: commands.testCommands.slice(0, 3).map(c => c.command),
		sampleFiles: topFiles,
	}, null, 2);
};

export class RepoIntelligenceMainService extends Disposable implements IRepoIntelligenceMainService {
	readonly _serviceBrand: undefined;

	private readonly _db: RepoIntelligenceDb;
	private readonly _scanInProgress = new Map<string, Promise<WorkspaceProfile>>();

	constructor(
		@IEnvironmentMainService private readonly _environmentService: IEnvironmentMainService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IApplicationStorageMainService private readonly _appStorage: IApplicationStorageMainService,
		@IEncryptionMainService private readonly _encryptionService: IEncryptionMainService,
	) {
		super();
		const dbPath = getRepoIntelligenceDbPath(this._environmentService.userDataPath);
		this._db = new RepoIntelligenceDb(dbPath);
		this._db.init().catch(err => console.error('[RepoIntelligence] DB init failed:', err));
	}

	override dispose(): void {
		this._db.close();
		super.dispose();
	}

	async getProfile(workspaceRoot: string): Promise<WorkspaceProfile | null> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();

		const existing = await this._db.getProfile(hash);
		if (existing) {
			const isExpired = Date.now() - existing.lastScannedAt > REPO_INTEL_PROFILE_STALE_MS;
			if (!existing.isStale && !isExpired) {
				return existing;
			}
		}

		return this._ensureScan(workspaceRoot);
	}

	async refreshProfile(workspaceRoot: string): Promise<WorkspaceProfile> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		await this._db.init();
		await this._db.markStale(hash);
		this._scanInProgress.delete(workspaceRoot);
		return this._ensureScan(workspaceRoot);
	}

	private async _ensureScan(workspaceRoot: string): Promise<WorkspaceProfile> {
		const inProgress = this._scanInProgress.get(workspaceRoot);
		if (inProgress) return inProgress;

		const promise = this._scanWorkspace(workspaceRoot);
		this._scanInProgress.set(workspaceRoot, promise);
		try {
			return await promise;
		} finally {
			this._scanInProgress.delete(workspaceRoot);
		}
	}

	private async _scanWorkspace(workspaceRoot: string): Promise<WorkspaceProfile> {
		const hash = hashWorkspaceRoot(workspaceRoot);
		const scan = scanWorkspace(workspaceRoot);
		const commands = detectCommands(workspaceRoot);

		let profile: WorkspaceProfile = {
			workspaceRoot,
			lastScannedAt: Date.now(),
			languageStack: scan.languages,
			frameworks: scan.frameworks,
			packageManagers: scan.packageManagers,
			// Store start scripts alongside build in the same JSON column (purpose distinguishes them)
			buildCommands: [...commands.buildCommands, ...commands.startCommands],
			testCommands: commands.testCommands,
			lintCommands: commands.lintCommands,
			typecheckCommands: commands.typecheckCommands,
			projectPurpose: null,
			architectureSummary: null,
			fileCount: scan.fileCount,
			totalLoc: scan.totalLoc,
			isStale: false,
		};

		await this._db.upsertProfile(hash, profile, scan.fileMeta);

		const existing = await this._db.getProfile(hash);
		if (existing?.projectPurpose && existing?.architectureSummary) {
			profile = { ...profile, projectPurpose: existing.projectPurpose, architectureSummary: existing.architectureSummary };
			return profile;
		}

		try {
			const scanContext = buildScanContext(scan, commands, workspaceRoot);
			const [architectureSummary, projectPurpose] = await Promise.all([
				this._callLLMForSummary(ARCH_SUMMARY_SYSTEM_PROMPT, scanContext),
				this._callLLMForSummary(PURPOSE_SUMMARY_SYSTEM_PROMPT, scanContext),
			]);

			if (architectureSummary || projectPurpose) {
				await this._db.updateSummaries(hash, projectPurpose, architectureSummary);
				profile = { ...profile, projectPurpose, architectureSummary };
			}
		} catch (err) {
			console.error('[RepoIntelligence] LLM summary generation failed:', err);
		}

		return profile;
	}

	private async _readVoidSettings(): Promise<TroveSettingsState | null> {
		try {
			const encryptedState = this._appStorage.get(TROVE_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION);
			if (!encryptedState) return null;
			const stateStr = await this._encryptionService.decrypt(encryptedState);
			return JSON.parse(stateStr) as TroveSettingsState;
		} catch {
			return null;
		}
	}

	private async _callLLMForSummary(systemPrompt: string, userContent: string): Promise<string | null> {
		const settings = await this._readVoidSettings();
		if (!settings) return null;

		const modelSelection = settings.modelSelectionOfFeature['Chat'];
		if (!modelSelection) return null;

		const modelSelectionOptions = settings.optionsOfModelSelection['Chat']?.[modelSelection.providerName]?.[modelSelection.modelName];

		return new Promise<string | null>((resolve) => {
			const abortRef = { current: null as (() => void) | null };
			const timeout = setTimeout(() => {
				abortRef.current?.();
				resolve(null);
			}, 30_000);

			sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: userContent }],
				separateSystemMessage: systemPrompt,
				chatMode: null,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel: settings.overridesOfModel,
				settingsOfProvider: settings.settingsOfProvider,
				mcpTools: undefined,
				abortRef,
				onText: () => { },
				onFinalMessage: ({ fullText }) => {
					clearTimeout(timeout);
					resolve(fullText.trim() || null);
				},
				onError: () => {
					clearTimeout(timeout);
					resolve(null);
				},
				logging: { loggingName: 'RepoIntelligence - Summary' },
			}, this._metricsService).catch(() => {
				clearTimeout(timeout);
				resolve(null);
			});
		});
	}
}
