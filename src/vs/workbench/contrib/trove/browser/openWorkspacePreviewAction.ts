/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { localize2 } from '../../../../nls.js';
import { openWorkspaceSimpleBrowser } from './simpleBrowserOpen.js';

export const TROVE_OPEN_WORKSPACE_PREVIEW_ACTION_ID = 'trove.openWorkspacePreview';

class OpenWorkspacePreviewAction extends Action2 {
	constructor() {
		super({
			id: TROVE_OPEN_WORKSPACE_PREVIEW_ACTION_ID,
			title: localize2('troveOpenWorkspacePreview', 'Trove: Open Preview in Workspace Browser'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, url?: string): Promise<boolean> {
		if (!url || typeof url !== 'string') {
			return false;
		}
		return openWorkspaceSimpleBrowser(
			accessor.get(ICommandService),
			accessor.get(IExtensionService),
			url,
		);
	}
}

registerAction2(OpenWorkspacePreviewAction);
