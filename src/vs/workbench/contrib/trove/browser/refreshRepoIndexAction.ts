/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js';
import { TROVE_REFRESH_REPO_INDEX_ACTION_ID } from './actionIDs.js';
import { openRepoIntelligenceReport } from './repoIntelligenceReportAction.js';

export async function refreshRepoIndex(accessor: ServicesAccessor, openReportAfter = false): Promise<void> {
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const repoIntelligenceService = accessor.get(IRepoIntelligenceService);
	const notificationService = accessor.get(INotificationService);

	const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
	if (!workspaceRoot) {
		notificationService.info(localize('trove.repoIntelligence.refresh.noWorkspace', 'Open a workspace folder to refresh the Repository Intelligence index.'));
		return;
	}

	try {
		await repoIntelligenceService.refreshProfile(workspaceRoot);
		notificationService.info(localize('trove.repoIntelligence.refresh.done', 'Repository Intelligence index refreshed.'));
		if (openReportAfter) {
			await openRepoIntelligenceReport(accessor);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		notificationService.error(localize('trove.repoIntelligence.refresh.error', 'Failed to refresh Repository Intelligence index: {0}', message));
		console.error('[RepoIntelligence] Refresh failed:', err);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TROVE_REFRESH_REPO_INDEX_ACTION_ID,
			f1: true,
			title: localize2('troveRefreshRepoIndex', 'Trove: Refresh Repository Index'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await refreshRepoIndex(accessor, false);
	}
});
