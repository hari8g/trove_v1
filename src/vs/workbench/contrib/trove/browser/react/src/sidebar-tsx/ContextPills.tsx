/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { File, Folder, Text, X } from 'lucide-react';
import { URI } from '../../../../../../../base/common/uri.js';
import { StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';
import { useAccessor } from '../util/services.js';

const getBasename = (pathStr: string) => {
	pathStr = pathStr.replace(/[/\\]+/g, '/');
	const allParts = pathStr.split('/');
	if (allParts.length === 0) return pathStr;
	return allParts.slice(-1).join('/');
};

const getRelative = (uri: URI, accessor: ReturnType<typeof useAccessor>) => {
	const workspaceContextService = accessor.get('IWorkspaceContextService');
	const isInside = workspaceContextService.isInsideWorkspace(uri);
	if (isInside) {
		const f = workspaceContextService.getWorkspace().folders.find(f => uri.fsPath?.startsWith(f.uri.fsPath));
		if (f) return uri.fsPath.replace(f.uri.fsPath, '') || undefined;
	}
	return uri.fsPath;
};

const openFile = (uri: URI, accessor: ReturnType<typeof useAccessor>, range?: [number, number]) => {
	const commandService = accessor.get('ICommandService');
	const editorService = accessor.get('ICodeEditorService');
	const editorSelection = range ? {
		startLineNumber: range[0],
		startColumn: 1,
		endLineNumber: range[1],
		endColumn: Number.MAX_SAFE_INTEGER,
	} : undefined;

	void commandService.executeCommand('vscode.open', uri).then(() => {
		if (!editorSelection) return;
		setTimeout(() => {
			const editor = editorService.getActiveCodeEditor();
			if (editor) editor.setSelection(editorSelection);
		}, 50);
	});
};

export const InlineContextPills = ({
	selections,
	setSelections,
	type,
}: {
	selections: StagingSelectionItem[];
	setSelections?: (s: StagingSelectionItem[]) => void;
	type: 'staging' | 'past';
}) => {
	const accessor = useAccessor();
	if (!selections.length) return null;

	return (
		<>
			{selections.map((selection, i) => {
				const thisKey = selection.type === 'CodeSelection'
					? `${selection.type}-${selection.uri.fsPath}-${selection.range[0]}-${selection.range[1]}`
					: `${selection.type}-${selection.uri.fsPath}`;

				const SelectionIcon = selection.type === 'File' ? File
					: selection.type === 'Folder' ? Folder
						: Text;

				const pillKindClass = selection.type === 'Folder' ? 'trove-context-pill--folder'
					: selection.type === 'CodeSelection' ? 'trove-context-pill--code'
						: '';

				const displayName = getBasename(selection.uri.fsPath)
					+ (selection.type === 'CodeSelection' ? `:${selection.range[0]}–${selection.range[1]}` : '');

				const onChipClick = () => {
					if (type !== 'staging' || !setSelections) {
						if (selection.type === 'File' || selection.type === 'CodeSelection') {
							openFile(selection.uri, accessor, selection.type === 'CodeSelection' ? selection.range : undefined);
						}
						return;
					}
					if (selection.type === 'File') {
						openFile(selection.uri, accessor);
						if (selection.state.wasAddedAsCurrentFile) {
							setSelections([
								...selections.slice(0, i),
								{ ...selection, state: { ...selection.state, wasAddedAsCurrentFile: false } },
								...selections.slice(i + 1),
							]);
						}
					} else if (selection.type === 'CodeSelection') {
						openFile(selection.uri, accessor, selection.range);
					}
				};

				return (
					<span
						key={thisKey}
						className={`context-pill context-pill--inline ${pillKindClass}`}
						onClick={onChipClick}
						data-tooltip-id='trove-tooltip'
						data-tooltip-content={getRelative(selection.uri, accessor)}
						data-tooltip-place='top'
						data-tooltip-delay-show={400}
						contentEditable={false}
					>
						<SelectionIcon size={11} className='context-pill__icon' />
						<span className='context-pill__name'>{displayName}</span>
						{type === 'staging' && setSelections ?
							<button
								type='button'
								className='context-pill__remove'
								aria-label='Remove'
								tabIndex={-1}
								onClick={(e) => {
									e.stopPropagation();
									setSelections([...selections.slice(0, i), ...selections.slice(i + 1)]);
								}}
							>
								<X size={10} className='stroke-[2]' />
							</button>
							: null}
					</span>
				);
			})}
		</>
	);
};
