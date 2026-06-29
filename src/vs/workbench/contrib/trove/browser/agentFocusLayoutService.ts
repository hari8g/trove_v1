/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { TROVE_VIEW_CONTAINER_ID } from './sidebarPane.js';

const FOCUS_AUXILIARY_WIDTH_RATIO = 0.58;
const MIN_FOCUS_AUXILIARY_WIDTH = 480;
const MAX_FOCUS_AUXILIARY_WIDTH = 1200;

type LayoutSnapshot = {
	sidebarVisible: boolean;
	panelVisible: boolean;
	auxiliaryVisible: boolean;
	auxiliaryWidth: number;
};

export interface IAgentFocusLayoutService {
	readonly _serviceBrand: undefined;
	readonly isFocusMode: boolean;
	readonly onDidChangeFocusMode: Event<boolean>;
	toggleFocusMode(): Promise<void>;
	setFocusMode(enabled: boolean): Promise<void>;
}

export const IAgentFocusLayoutService = createDecorator<IAgentFocusLayoutService>('IAgentFocusLayoutService');

class AgentFocusLayoutService extends Disposable implements IAgentFocusLayoutService {
	declare readonly _serviceBrand: undefined;

	private _focusMode = false;
	private _snapshot: LayoutSnapshot | undefined;

	private readonly _onDidChangeFocusMode = this._register(new Emitter<boolean>());
	readonly onDidChangeFocusMode = this._onDidChangeFocusMode.event;

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly _viewsService: IViewsService,
	) {
		super();
	}

	get isFocusMode(): boolean {
		return this._focusMode;
	}

	async toggleFocusMode(): Promise<void> {
		await this.setFocusMode(!this._focusMode);
	}

	async setFocusMode(enabled: boolean): Promise<void> {
		if (enabled === this._focusMode) {
			return;
		}

		if (enabled) {
			await this._enableFocusMode();
		} else {
			this._disableFocusMode();
		}

		this._focusMode = enabled;
		this._onDidChangeFocusMode.fire(enabled);
	}

	private async _enableFocusMode(): Promise<void> {
		const auxiliarySize = this._layoutService.getSize(Parts.AUXILIARYBAR_PART);

		this._snapshot = {
			sidebarVisible: this._layoutService.isVisible(Parts.SIDEBAR_PART),
			panelVisible: this._layoutService.isVisible(Parts.PANEL_PART),
			auxiliaryVisible: this._layoutService.isVisible(Parts.AUXILIARYBAR_PART),
			auxiliaryWidth: auxiliarySize.width,
		};

		await this._viewsService.openViewContainer(TROVE_VIEW_CONTAINER_ID);

		if (!this._layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			this._layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		}

		if (this._layoutService.isVisible(Parts.SIDEBAR_PART)) {
			this._layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		}

		if (this._layoutService.isVisible(Parts.PANEL_PART)) {
			this._layoutService.setPartHidden(true, Parts.PANEL_PART);
		}

		const container = this._layoutService.getContainer(getActiveWindow());
		const viewportWidth = container?.clientWidth ?? 1200;
		const targetWidth = Math.min(
			MAX_FOCUS_AUXILIARY_WIDTH,
			Math.max(MIN_FOCUS_AUXILIARY_WIDTH, Math.round(viewportWidth * FOCUS_AUXILIARY_WIDTH_RATIO)),
		);

		const currentSize = this._layoutService.getSize(Parts.AUXILIARYBAR_PART);
		this._layoutService.setSize(Parts.AUXILIARYBAR_PART, {
			width: targetWidth,
			height: currentSize.height,
		});
	}

	private _disableFocusMode(): void {
		const snapshot = this._snapshot;
		this._snapshot = undefined;

		if (!snapshot) {
			return;
		}

		this._layoutService.setPartHidden(!snapshot.sidebarVisible, Parts.SIDEBAR_PART);
		this._layoutService.setPartHidden(!snapshot.panelVisible, Parts.PANEL_PART);
		this._layoutService.setPartHidden(!snapshot.auxiliaryVisible, Parts.AUXILIARYBAR_PART);

		if (snapshot.auxiliaryVisible) {
			const currentSize = this._layoutService.getSize(Parts.AUXILIARYBAR_PART);
			this._layoutService.setSize(Parts.AUXILIARYBAR_PART, {
				width: snapshot.auxiliaryWidth,
				height: currentSize.height,
			});
		}
	}
}

registerSingleton(IAgentFocusLayoutService, AgentFocusLayoutService, InstantiationType.Delayed);

export const TROVE_TOGGLE_AGENT_FOCUS_ACTION_ID = 'trove.agent.toggleFocusLayout';
