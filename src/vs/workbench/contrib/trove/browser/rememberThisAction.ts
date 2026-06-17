/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../nls.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js';
import { TROVE_REMEMBER_THIS_ACTION_ID } from './actionIDs.js';

class RememberThisAction extends Action2 {
	constructor() {
		super({
			id: TROVE_REMEMBER_THIS_ACTION_ID,
			title: localize2('troveRememberThis', 'Trove: Remember This'),
			f1: true,
			menu: [{
				id: MenuId.EditorContext,
				group: '9_trove',
				order: 1,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const codeEditorService = accessor.get(ICodeEditorService);
		const repoIntelligenceService = accessor.get(IRepoIntelligenceService);
		const notificationService = accessor.get(INotificationService);

		const editor = codeEditorService.getActiveCodeEditor();
		const selection = editor?.getSelection();
		const model = editor?.getModel();
		let text = '';

		if (selection && model && !selection.isEmpty()) {
			text = model.getValueInRange(selection).trim();
		}

		if (!text) {
			notificationService.info('Select text in the editor to remember, or type "Please remember that …" in chat.');
			return;
		}

		try {
			await repoIntelligenceService.appendToUserMemory(text);
			notificationService.info('Saved to Trove memory.');
		} catch (err) {
			notificationService.error(`Could not save to memory: ${err}`);
		}
	}
}

registerAction2(RememberThisAction);
