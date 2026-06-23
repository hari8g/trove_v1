/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { mountContextGraph } from './react/out/context-graph-tsx/index.js';
import { TROVE_OPEN_CONTEXT_GRAPH_ACTION_ID } from './actionIDs.js';

class ContextGraphInput extends EditorInput {
	static readonly ID = 'workbench.input.trove.contextGraph';
	static readonly RESOURCE = URI.from({ scheme: 'trove', path: 'context-graph' });
	readonly resource = ContextGraphInput.RESOURCE;

	override get typeId(): string {
		return ContextGraphInput.ID;
	}

	override getName(): string {
		return nls.localize('troveContextGraphName', 'Context Graph');
	}

	override getIcon() {
		return Codicon.typeHierarchy;
	}
}

class ContextGraphPane extends EditorPane {
	static readonly ID = 'workbench.trove.contextGraphPane';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(ContextGraphPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';
		const root = document.createElement('div');
		root.style.height = '100%';
		root.style.width = '100%';
		parent.appendChild(root);

		this.instantiationService.invokeFunction(accessor => {
			const disposeFn = mountContextGraph(root, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()));
		});
	}

	layout(_dimension: Dimension): void {
	}

	override get minimumWidth() { return 600; }
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ContextGraphPane,
		ContextGraphPane.ID,
		nls.localize('TroveContextGraphPane', 'Trove Context Graph'),
	),
	[new SyncDescriptor(ContextGraphInput)],
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TROVE_OPEN_CONTEXT_GRAPH_ACTION_ID,
			title: nls.localize2('troveOpenContextGraph', 'Trove: Open Context Graph'),
			f1: true,
			icon: Codicon.typeHierarchy,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		const openEditors = editorService.findEditors(ContextGraphInput.RESOURCE);
		if (openEditors.length > 0) {
			await editorService.openEditor(openEditors[0].editor);
			return;
		}

		const input = instantiationService.createInstance(ContextGraphInput);
		await editorService.openEditor(input);
	}
});
