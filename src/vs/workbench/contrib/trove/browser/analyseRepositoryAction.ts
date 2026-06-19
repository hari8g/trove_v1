/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { localize2 } from '../../../../nls.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IRiafAgentService } from '../common/riaf/riafTypes.js';
import { TROVE_ANALYSE_REPOSITORY_ACTION_ID } from './actionIDs.js';
import { TROVE_VIEW_CONTAINER_ID } from './sidebarPane.js';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TROVE_ANALYSE_REPOSITORY_ACTION_ID,
			f1: true,
			title: localize2('troveAnalyseRepository', 'Trove: Analyse Repository'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK,
				weight: KeybindingWeight.TroveExtension,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const riafService = accessor.get(IRiafAgentService);

		if (!viewsService.isViewContainerVisible(TROVE_VIEW_CONTAINER_ID)) {
			await viewsService.openViewContainer(TROVE_VIEW_CONTAINER_ID);
		}

		await riafService.startRun();
	}
});
