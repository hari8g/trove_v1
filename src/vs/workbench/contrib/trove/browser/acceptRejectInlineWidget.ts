/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Widget } from '../../../../base/browser/ui/widget.js';
import { ICodeEditor, IOverlayWidget } from '../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { acceptBg, acceptBorder, buttonFontSize, buttonTextColor, rejectBg, rejectBorder } from '../common/helpers/colors.js';
import { TROVE_ACCEPT_DIFF_ACTION_ID, TROVE_REJECT_DIFF_ACTION_ID } from './actionIDs.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { ITroveCommandBarService } from './troveCommandBarService.js';

export { getAcceptRejectWidgetPlacement } from './helpers/getAcceptRejectWidgetPlacement.js';

export class AcceptRejectInlineWidget extends Widget implements IOverlayWidget {

	public getId(): string {
		return this.ID || '';
	}
	public getDomNode(): HTMLElement {
		return this._domNode;
	}
	public getPosition() {
		return null;
	}

	private readonly _domNode: HTMLElement;
	private readonly editor: ICodeEditor;
	private readonly ID: string;
	private readonly startLine: number;

	constructor(
		{ editor, onAccept, onReject, diffid, startLine, offsetLines }: {
			editor: ICodeEditor;
			onAccept: () => void;
			onReject: () => void;
			diffid: string,
			startLine: number,
			offsetLines: number
		},
		@ITroveCommandBarService private readonly _troveCommandBarService: ITroveCommandBarService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
	) {
		super();

		const uri = editor.getModel()?.uri;
		this.ID = '';
		this.editor = editor;
		this.startLine = startLine;

		if (!uri) {
			const { dummyDiv } = dom.h('div@dummyDiv');
			this._domNode = dummyDiv;
			return;
		}

		this.ID = uri.fsPath + diffid;

		const lineHeight = editor.getOption(EditorOption.lineHeight);

		const getAcceptRejectText = () => {
			const acceptKeybinding = this._keybindingService.lookupKeybinding(TROVE_ACCEPT_DIFF_ACTION_ID);
			const rejectKeybinding = this._keybindingService.lookupKeybinding(TROVE_REJECT_DIFF_ACTION_ID);

			const acceptKeybindLabel = this._editCodeService.processRawKeybindingText(acceptKeybinding && acceptKeybinding.getLabel() || '');
			const rejectKeybindLabel = this._editCodeService.processRawKeybindingText(rejectKeybinding && rejectKeybinding.getLabel() || '');

			const commandBarStateAtUri = this._troveCommandBarService.stateOfURI[uri.fsPath];
			const selectedDiffIdx = commandBarStateAtUri?.diffIdx ?? 0;
			const thisDiffIdx = commandBarStateAtUri?.sortedDiffIds.indexOf(diffid) ?? null;

			const showLabel = thisDiffIdx === selectedDiffIdx;

			const acceptText = `Accept${showLabel ? ` ` + acceptKeybindLabel : ''}`;
			const rejectText = `Reject${showLabel ? ` ` + rejectKeybindLabel : ''}`;

			return { acceptText, rejectText };
		};

		const { acceptText, rejectText } = getAcceptRejectText();

		const { acceptButton, rejectButton, buttons } = dom.h('div@buttons', [
			dom.h('button@acceptButton', []),
			dom.h('button@rejectButton', [])
		]);

		buttons.style.display = 'flex';
		buttons.style.position = 'absolute';
		buttons.style.gap = '4px';
		buttons.style.paddingRight = '4px';
		buttons.style.zIndex = '1';
		buttons.style.transform = `translateY(${offsetLines * lineHeight}px)`;
		buttons.style.justifyContent = 'flex-end';
		buttons.style.width = '100%';
		buttons.style.pointerEvents = 'none';

		acceptButton.onclick = onAccept;
		acceptButton.textContent = acceptText;
		acceptButton.style.backgroundColor = acceptBg;
		acceptButton.style.border = acceptBorder;
		acceptButton.style.color = buttonTextColor;
		acceptButton.style.fontSize = buttonFontSize;
		acceptButton.style.borderTop = 'none';
		acceptButton.style.padding = '1px 4px';
		acceptButton.style.borderBottomLeftRadius = '6px';
		acceptButton.style.borderBottomRightRadius = '6px';
		acceptButton.style.borderTopLeftRadius = '0';
		acceptButton.style.borderTopRightRadius = '0';
		acceptButton.style.cursor = 'pointer';
		acceptButton.style.height = '100%';
		acceptButton.style.boxShadow = '0 2px 3px rgba(0,0,0,0.2)';
		acceptButton.style.pointerEvents = 'auto';

		rejectButton.onclick = onReject;
		rejectButton.textContent = rejectText;
		rejectButton.style.backgroundColor = rejectBg;
		rejectButton.style.border = rejectBorder;
		rejectButton.style.color = buttonTextColor;
		rejectButton.style.fontSize = buttonFontSize;
		rejectButton.style.borderTop = 'none';
		rejectButton.style.padding = '1px 4px';
		rejectButton.style.borderBottomLeftRadius = '6px';
		rejectButton.style.borderBottomRightRadius = '6px';
		rejectButton.style.borderTopLeftRadius = '0';
		rejectButton.style.borderTopRightRadius = '0';
		rejectButton.style.cursor = 'pointer';
		rejectButton.style.height = '100%';
		rejectButton.style.boxShadow = '0 2px 3px rgba(0,0,0,0.2)';
		rejectButton.style.pointerEvents = 'auto';

		this._domNode = buttons;

		const updateTop = () => {
			const topPx = editor.getTopForLineNumber(this.startLine) - editor.getScrollTop();
			this._domNode.style.top = `${topPx}px`;
		};
		const updateLeft = () => {
			const layoutInfo = editor.getLayoutInfo();
			const minimapWidth = layoutInfo.minimap.minimapWidth;
			const verticalScrollbarWidth = layoutInfo.verticalScrollbarWidth;
			const buttonWidth = this._domNode.offsetWidth;

			const leftPx = layoutInfo.width - minimapWidth - verticalScrollbarWidth - buttonWidth;
			this._domNode.style.left = `${leftPx}px`;
		};

		setTimeout(() => {
			updateTop();
			updateLeft();
		}, 0);

		this._register(editor.onDidScrollChange(() => { updateTop(); }));
		this._register(editor.onDidChangeModelContent(() => { updateTop(); }));
		this._register(editor.onDidLayoutChange(() => { updateTop(); updateLeft(); }));

		this._register(this._troveCommandBarService.onDidChangeState(e => {
			if (uri && e.uri.fsPath === uri.fsPath) {
				const { acceptText: nextAccept, rejectText: nextReject } = getAcceptRejectText();
				acceptButton.textContent = nextAccept;
				rejectButton.textContent = nextReject;
			}
		}));

		editor.addOverlayWidget(this);
	}

	public override dispose(): void {
		this.editor.removeOverlayWidget(this);
		super.dispose();
	}
}
