/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { debounce } from '../../../../base/common/decorators.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { openWorkspaceSimpleBrowser, reloadWorkspaceSimpleBrowser } from './simpleBrowserOpen.js';

const WEB_ASSET_PATTERN = /\.(html?|css|scss|sass|less|jsx?|tsx?|vue|svelte|json|svg|png|jpe?g|gif|webp|woff2?|ttf|eot|ico|map)$/i;

export interface IWorkspacePreviewService {
	readonly _serviceBrand: undefined;
	readonly onDidChangePreviewUrl: Event<string | undefined>;
	getActivePreviewUrl(): string | undefined;
	openPreview(url: string): Promise<boolean>;
	reloadPreview(): Promise<boolean>;
	/** Open when dev-server output first shows a localhost URL (idempotent per URL). */
	tryOpenFromTerminalOutput(output: string, command?: string): Promise<boolean>;
	/** Debounced reload after web asset edits while preview is open. */
	scheduleReloadAfterWebChange(): void;
}

export const IWorkspacePreviewService = createDecorator<IWorkspacePreviewService>('WorkspacePreviewService');

class WorkspacePreviewService extends Disposable implements IWorkspacePreviewService {
	readonly _serviceBrand: undefined;

	private _activePreviewUrl: string | undefined;
	private _lastOpenedUrl: string | undefined;
	private readonly _onDidChangePreviewUrl = this._register(new Emitter<string | undefined>());
	readonly onDidChangePreviewUrl = this._onDidChangePreviewUrl.event;

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._register(this._fileService.onDidFilesChange(e => {
			if (!this._activePreviewUrl) return;
			const changed = [...e.rawUpdated, ...e.rawAdded, ...e.rawDeleted];
			for (const resource of changed) {
				if (this._isWebAssetInWorkspace(resource)) {
					this.scheduleReloadAfterWebChange();
					return;
				}
			}
		}));
	}

	private _isWebAssetInWorkspace(resource: URI): boolean {
		if (!WEB_ASSET_PATTERN.test(resource.path)) {
			return false;
		}
		for (const folder of this._workspaceContextService.getWorkspace().folders) {
			if (resource.toString().startsWith(folder.uri.toString())) {
				return true;
			}
		}
		return false;
	}

	getActivePreviewUrl(): string | undefined {
		return this._activePreviewUrl;
	}

	async openPreview(url: string): Promise<boolean> {
		const normalized = url.trim();
		if (!normalized) return false;
		const opened = await openWorkspaceSimpleBrowser(this._commandService, this._extensionService, normalized);
		if (opened) {
			this._activePreviewUrl = normalized;
			this._lastOpenedUrl = normalized;
			this._onDidChangePreviewUrl.fire(normalized);
		}
		return opened;
	}

	async reloadPreview(): Promise<boolean> {
		const url = this._activePreviewUrl ?? this._lastOpenedUrl;
		if (!url) return false;
		const reloaded = await reloadWorkspaceSimpleBrowser(this._commandService, this._extensionService, url);
		if (reloaded) {
			this._activePreviewUrl = url;
			this._onDidChangePreviewUrl.fire(url);
		}
		return reloaded;
	}

	async tryOpenFromTerminalOutput(output: string, command?: string): Promise<boolean> {
		const url = extractPreviewUrl(output, command);
		if (!url) return false;
		if (this._activePreviewUrl === url || this._lastOpenedUrl === url) {
			return this.reloadPreview();
		}
		return this.openPreview(url);
	}

	@debounce(250)
	scheduleReloadAfterWebChange(): void {
		void this.reloadPreview();
	}
}

const LOCALHOST_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'<>]*)?/gi;
const LOCALHOST_HOST_PORT_PATTERN = /(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/gi;
const SERVER_READY_OUTPUT_PATTERN = /\b(listening|running|ready|started)\b.*\b(port|localhost|http|127\.0\.0\.1)\b|\blocalhost:\d+\b|\b127\.0\.0\.1:\d+\b|\bServer running at\b/i;

export const extractPreviewUrl = (text: string, command?: string): string | undefined => {
	const plain = text.replace(/\x1b\[[0-9;]*m/g, '');

	const fromCommand = command?.match(/(?:curl|wget|httpie|httpx)\s+['"]?(https?:\/\/[^\s'"]+|localhost[^\s'"]*)/i)?.[1];
	if (fromCommand) {
		if (fromCommand.startsWith('http')) return fromCommand.replace(/['"]$/, '');
		if (/^localhost/i.test(fromCommand)) return `http://${fromCommand.replace(/['"]$/, '')}`;
	}

	const urlMatches = plain.match(LOCALHOST_URL_PATTERN);
	if (urlMatches?.length) {
		return urlMatches[urlMatches.length - 1].replace(/['",;)]+$/, '');
	}

	if (SERVER_READY_OUTPUT_PATTERN.test(plain)) {
		const ports = [...plain.matchAll(LOCALHOST_HOST_PORT_PATTERN)];
		if (ports.length) {
			return `http://localhost:${ports[ports.length - 1][1]}`;
		}
	}

	const ports = [...plain.matchAll(LOCALHOST_HOST_PORT_PATTERN)];
	if (ports.length) {
		return `http://localhost:${ports[ports.length - 1][1]}`;
	}

	return undefined;
};

registerSingleton(IWorkspacePreviewService, WorkspacePreviewService, InstantiationType.Delayed);
