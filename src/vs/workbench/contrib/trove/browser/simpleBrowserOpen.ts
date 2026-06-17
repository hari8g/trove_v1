/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';

/** ViewColumn.One — open in the primary editor column (workspace center). */
const WORKSPACE_BROWSER_VIEW_COLUMN = 1;

/**
 * Opens the Simple Browser webview in the workspace editor area and focuses it.
 * Activates the built-in simple-browser extension first so the command is available.
 */
export async function openWorkspaceSimpleBrowser(
	commandService: ICommandService,
	extensionService: IExtensionService,
	url: string,
): Promise<boolean> {
	const uri = URI.parse(url);

	try {
		await extensionService.activateByEvent('onCommand:simpleBrowser.api.open');
		await commandService.executeCommand('simpleBrowser.api.open', uri, {
			viewColumn: WORKSPACE_BROWSER_VIEW_COLUMN,
			preserveFocus: false,
		});
	} catch {
		try {
			await extensionService.activateByEvent('onCommand:simpleBrowser.show');
			await commandService.executeCommand('simpleBrowser.show', url);
		} catch {
			return false;
		}
	}

	try {
		await commandService.executeCommand('workbench.action.focusActiveEditorGroup');
	} catch {
		// non-fatal
	}

	return true;
}
