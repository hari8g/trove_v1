/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../../base/common/uri.js';
import { ScrollType } from '../../../../../../../editor/common/editorCommon.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { ICodeEditorService } from '../../../../../../../editor/browser/services/codeEditorService.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { useAccessor } from '../util/services.js';

export const getRelative = (uri: URI, accessor: ReturnType<typeof useAccessor>) => {
	const workspaceContextService = accessor.get('IWorkspaceContextService') as IWorkspaceContextService;
	let path: string;
	const isInside = workspaceContextService.isInsideWorkspace(uri);
	if (isInside) {
		const f = workspaceContextService.getWorkspace().folders.find(f => uri.fsPath?.startsWith(f.uri.fsPath));
		if (f) { path = uri.fsPath.replace(f.uri.fsPath, ''); }
		else { path = uri.fsPath; }
	} else {
		path = uri.fsPath;
	}
	return path || undefined;
};

export const getFolderName = (pathStr: string) => {
	pathStr = pathStr.replace(/[/\\]+/g, '/');
	const parts = pathStr.split('/');
	const nonEmptyParts = parts.filter(part => part.length > 0);
	if (nonEmptyParts.length === 0) return '/';
	if (nonEmptyParts.length === 1) return nonEmptyParts[0] + '/';
	const lastTwo = nonEmptyParts.slice(-2);
	return lastTwo.join('/') + '/';
};

export const getBasename = (pathStr: string, parts: number = 1) => {
	pathStr = pathStr.replace(/[/\\]+/g, '/');
	const allParts = pathStr.split('/');
	if (allParts.length === 0) return pathStr;
	return allParts.slice(-parts).join('/');
};

export const voidOpenFileFn = (
	uri: URI,
	accessor: ReturnType<typeof useAccessor>,
	range?: [number, number],
) => {
	const commandService = accessor.get('ICommandService') as ICommandService;
	const editorService = accessor.get('ICodeEditorService') as ICodeEditorService;

	let editorSelection = undefined;
	if (range) {
		editorSelection = {
			startLineNumber: range[0],
			startColumn: 1,
			endLineNumber: range[1],
			endColumn: Number.MAX_SAFE_INTEGER,
		};
	}

	commandService.executeCommand('vscode.open', uri).then(() => {
		setTimeout(() => {
			if (!editorSelection) return;
			const editor = editorService.getActiveCodeEditor();
			if (!editor) return;
			editor.setSelection(editorSelection);
			editor.revealRange(editorSelection, ScrollType.Immediate);
		}, 50);
	});
};
