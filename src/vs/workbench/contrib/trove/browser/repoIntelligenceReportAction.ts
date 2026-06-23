/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js';
import { TROVE_OPEN_REPO_INTELLIGENCE_REPORT_ACTION_ID } from './actionIDs.js';

export async function openRepoIntelligenceReport(accessor: ServicesAccessor): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const repoIntelligenceService = accessor.get(IRepoIntelligenceService);
	const notificationService = accessor.get(INotificationService);

	const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
	if (!workspaceRoot) {
		notificationService.info(localize('trove.repoIntelligence.report.noWorkspace', 'Open a workspace folder to view the Repository Intelligence report.'));
		return;
	}

	try {
		await repoIntelligenceService.ensureInitialized();
		const report = await repoIntelligenceService.getIndexingReport(workspaceRoot);
		await editorService.openEditor({
			resource: undefined,
			contents: report,
			languageId: 'markdown',
			options: { pinned: true },
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		notificationService.error(localize('trove.repoIntelligence.report.error', 'Failed to open Repository Intelligence report: {0}', message));
		console.error('[RepoIntelligence] Report failed:', err);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TROVE_OPEN_REPO_INTELLIGENCE_REPORT_ACTION_ID,
			f1: true,
			title: localize2('troveOpenRepoIntelligenceReport', 'Trove: Open Repository Intelligence Report'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await openRepoIntelligenceReport(accessor);
	}
});
