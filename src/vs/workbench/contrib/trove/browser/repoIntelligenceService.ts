/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IRepoIntelligenceService, REPO_INTEL_CHANNEL, REPO_INTEL_PROFILE_STALE_MS, WorkspaceProfile } from '../common/repoIntelligenceTypes.js';

class RepoIntelligenceService extends Disposable implements IRepoIntelligenceService {
	readonly _serviceBrand: undefined;

	private _cachedProfile: WorkspaceProfile | null = null;
	private readonly _mainProxy: Pick<IRepoIntelligenceService, 'getProfile' | 'refreshProfile'>;

	constructor(
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._mainProxy = ProxyChannel.toService<IRepoIntelligenceService>(
			this._mainProcessService.getChannel(REPO_INTEL_CHANNEL),
		);

		// Eager init may run before workspace folders are restored — retry after restore.
		this._initProfile();
		setTimeout(() => this._initProfile(), 0);
		setTimeout(() => this._initProfile(), 2000);

		this._register(
			this._workspaceContextService.onDidChangeWorkspaceFolders(async (e) => {
				if (e.added.length > 0 || e.changed.length > 0) {
					await this._initProfile();
				}
			}),
		);
	}

	private _getWorkspaceRoot(): string | null {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders[0]?.uri.fsPath ?? null;
	}

	private async _initProfile(): Promise<void> {
		const root = this._getWorkspaceRoot();
		if (!root) {
			this._cachedProfile = null;
			return;
		}

		if (this._cachedProfile) {
			const isExpired = Date.now() - this._cachedProfile.lastScannedAt > REPO_INTEL_PROFILE_STALE_MS;
			if (!this._cachedProfile.isStale && !isExpired && this._cachedProfile.workspaceRoot === root) {
				return;
			}
		}

		try {
			this._cachedProfile = await this._mainProxy.getProfile(root);
			console.log('[RepoIntelligence] Profile loaded for', root);
		} catch (err) {
			console.error('[RepoIntelligence] Failed to load profile:', err);
			this._cachedProfile = null;
		}
	}

	getProfileSync(): WorkspaceProfile | null {
		return this._cachedProfile;
	}

	async getProfile(workspaceRoot: string): Promise<WorkspaceProfile | null> {
		const profile = await this._mainProxy.getProfile(workspaceRoot);
		if (workspaceRoot === this._getWorkspaceRoot()) {
			this._cachedProfile = profile;
		}
		return profile;
	}

	async refreshProfile(workspaceRoot: string): Promise<WorkspaceProfile> {
		const profile = await this._mainProxy.refreshProfile(workspaceRoot);
		if (workspaceRoot === this._getWorkspaceRoot()) {
			this._cachedProfile = profile;
		}
		return profile;
	}
}

registerSingleton(IRepoIntelligenceService, RepoIntelligenceService, InstantiationType.Eager);
