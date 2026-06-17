/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';

/** ViewColumn.One — open in the primary editor column (workspace center). */
const WORKSPACE_BROWSER_VIEW_COLUMN = 1;

const withCacheBust = (url: string): string => {
	try {
		const parsed = new URL(url);
		parsed.searchParams.set('trove_reload', String(Date.now()));
		return parsed.toString();
	} catch {
		const sep = url.includes('?') ? '&' : '?';
		return `${url}${sep}trove_reload=${Date.now()}`;
	}
};

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

/** Re-navigate the workspace Simple Browser to bust cache (live reload after edits). */
export async function reloadWorkspaceSimpleBrowser(
	commandService: ICommandService,
	extensionService: IExtensionService,
	url: string,
): Promise<boolean> {
	try {
		await extensionService.activateByEvent('onCommand:simpleBrowser.api.reload');
		await commandService.executeCommand('simpleBrowser.api.reload', url);
		return true;
	} catch {
		return openWorkspaceSimpleBrowser(commandService, extensionService, withCacheBust(url));
	}
}
