/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js';
import { TROVE_OPEN_REPO_INTELLIGENCE_REPORT_ACTION_ID } from './actionIDs.js';

export class RepoIntelligenceStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.troveRepoIntelligenceStatus';

	private _entryAccessor: IStatusbarEntryAccessor | undefined;
	private _chunkCount: number | null = null;
	private _isIndexing = false;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IRepoIntelligenceService private readonly _repoIntelligenceService: IRepoIntelligenceService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();

		this._register(this._repoIntelligenceService.onDidChangeChunkIndex(count => {
			if (count === -1) {
				this._isIndexing = true;
				this._chunkCount = null;
			} else {
				this._chunkCount = count;
				this._isIndexing = false;
			}
			this._updateEntry();
		}));

		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			const hasFolder = this._workspaceContextService.getWorkspace().folders.length > 0;
			if (!hasFolder) {
				this._chunkCount = null;
				this._isIndexing = false;
				this._disposeEntry();
				return;
			}
			this._isIndexing = true;
			this._ensureEntry();
			this._updateEntry();
			void this._repoIntelligenceService.ensureInitialized();
		}));

		if (this._workspaceContextService.getWorkspace().folders.length > 0) {
			this._isIndexing = !this._repoIntelligenceService.getProfileSync();
			this._ensureEntry();
			this._updateEntry();
			void this._repoIntelligenceService.ensureInitialized();
		}
	}

	private _ensureEntry(): void {
		if (this._entryAccessor) return;
		this._entryAccessor = this._statusbarService.addEntry(
			this._getEntry(),
			'status.trove.repoIntelligence',
			StatusbarAlignment.LEFT,
			48,
		);
	}

	private _disposeEntry(): void {
		this._entryAccessor?.dispose();
		this._entryAccessor = undefined;
	}

	private _updateEntry(): void {
		if (!this._workspaceContextService.getWorkspace().folders.length) {
			this._disposeEntry();
			return;
		}
		this._ensureEntry();
		this._entryAccessor?.update(this._getEntry());
	}

	private _getEntry(): IStatusbarEntry {
		const text = this._formatText();
		return {
			name: localize('trove.repoIntelligence.status.name', 'Codebase Index'),
			text,
			ariaLabel: text,
			tooltip: localize('trove.repoIntelligence.status.tooltip', 'Repository Intelligence index — click for detailed report'),
			command: TROVE_OPEN_REPO_INTELLIGENCE_REPORT_ACTION_ID,
		};
	}

	private _formatText(): string {
		if (this._isIndexing) {
			return `$(sync~spin) ${localize('trove.repoIntelligence.status.indexing', 'Indexing…')}`;
		}
		const count = this._chunkCount ?? 0;
		const formatted = count.toLocaleString();
		return `$(search) ${localize('trove.repoIntelligence.status.indexed', 'Indexed {0} chunks', formatted)}`;
	}
}

registerWorkbenchContribution2(RepoIntelligenceStatusContribution.ID, RepoIntelligenceStatusContribution, WorkbenchPhase.AfterRestored);
