/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { URI } from '../../../../../../../base/common/uri.js';
import { ITroveCommandBarService } from '../../../troveCommandBarService.js';
import { IEditCodeService } from '../../../editCodeServiceInterface.js';
import { useAccessor, useChatThreadsState } from '../util/services.js';
import { ICodeEditorService } from '../../../../../../../editor/browser/services/codeEditorService.js';
import { PlanView } from './PlanView.js';

const getBasename = (uri: URI): string => {
	const parts = uri.fsPath.replace(/\\/g, '/').split('/');
	return parts[parts.length - 1] ?? uri.fsPath;
};

const getWorkspaceRelative = (uri: URI, workspaceRoot?: string): string => {
	if (!workspaceRoot) return uri.fsPath;
	const rel = uri.fsPath.startsWith(workspaceRoot)
		? uri.fsPath.slice(workspaceRoot.length).replace(/^[/\\]/, '')
		: uri.fsPath;
	return rel;
};

interface ComposerFileEntry {
	uri: URI;
	streamState: 'streaming' | 'idle-has-changes' | 'idle-no-changes';
	diffCount: number;
}

const useComposerFiles = () => {
	const accessor = useAccessor();
	const commandBarService = accessor.get('ITroveCommandBarService') as ITroveCommandBarService;
	const workspaceContextService = accessor.get('IWorkspaceContextService');

	const getEntries = useCallback((): ComposerFileEntry[] => {
		return commandBarService.sortedURIs.map(uri => ({
			uri,
			streamState: commandBarService.getStreamState(uri),
			diffCount: commandBarService.stateOfURI[uri.fsPath]?.sortedDiffIds.length ?? 0,
		}));
	}, [commandBarService]);

	const [entries, setEntries] = useState<ComposerFileEntry[]>(() => getEntries());

	useEffect(() => {
		const refresh = () => setEntries(getEntries());
		const d = commandBarService.onDidChangeState(() => refresh());
		return () => d.dispose();
	}, [commandBarService, getEntries]);

	const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
	return { entries, workspaceRoot };
};

export const ComposerPanel: React.FC = () => {
	const accessor = useAccessor();
	const commandBarService = accessor.get('ITroveCommandBarService') as ITroveCommandBarService;
	const editCodeService = accessor.get('IEditCodeService') as IEditCodeService;
	const codeEditorService = accessor.get('ICodeEditorService') as ICodeEditorService;
	const chatThreadsState = useChatThreadsState();

	const { entries, workspaceRoot } = useComposerFiles();

	const latestPlan = useMemo(() => {
		const thread = chatThreadsState.allThreads[chatThreadsState.currentThreadId];
		if (!thread) return null;
		for (let i = thread.messages.length - 1; i >= 0; i--) {
			const m = thread.messages[i];
			if (m.role === 'plan') return m;
		}
		return null;
	}, [chatThreadsState.allThreads, chatThreadsState.currentThreadId]);

	const handleAcceptAll = useCallback(() => {
		commandBarService.acceptOrRejectAllFiles({ behavior: 'accept' });
	}, [commandBarService]);

	const handleRejectAll = useCallback(() => {
		commandBarService.acceptOrRejectAllFiles({ behavior: 'reject' });
	}, [commandBarService]);

	const handleAcceptFile = useCallback((uri: URI) => {
		editCodeService.acceptOrRejectAllDiffAreas({ uri, behavior: 'accept', removeCtrlKs: true });
	}, [editCodeService]);

	const handleRejectFile = useCallback((uri: URI) => {
		editCodeService.acceptOrRejectAllDiffAreas({ uri, behavior: 'reject', removeCtrlKs: true });
	}, [editCodeService]);

	const handleOpenFile = useCallback(async (uri: URI) => {
		const editor = codeEditorService.listCodeEditors().find(e => e.getModel()?.uri.fsPath === uri.fsPath);
		if (editor) {
			editor.focus();
		}
	}, [codeEditorService]);

	if (entries.length === 0) {
		return (
			<div className="flex flex-col h-full overflow-y-auto">
				{latestPlan ? (
					<div className="px-2 pt-2 shrink-0">
						<PlanView plan={latestPlan} />
					</div>
				) : null}
				<div className="flex-1 flex items-center justify-center text-trove-fg-4 text-[12px] text-center px-6 py-8">
					No pending changes.<br />
					Edits made by the agent will appear here for review.
				</div>
			</div>
		);
	}

	const hasChanges = entries.some(e => e.streamState === 'idle-has-changes');
	const isAnyStreaming = entries.some(e => e.streamState === 'streaming');

	return (
		<div className="flex flex-col h-full text-[13px] text-trove-fg-1">
			{latestPlan ? (
				<div className="px-2 pt-2 border-b border-trove-border-2 shrink-0">
					<PlanView plan={latestPlan} />
				</div>
			) : null}
			{/* Header with global actions */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-trove-border-2 shrink-0">
				<div>
					<span className="font-medium text-[12px]">Composer</span>
					<span className="ml-2 text-trove-fg-4 text-[11px]">{entries.length} file{entries.length !== 1 ? 's' : ''}</span>
				</div>
				{hasChanges && !isAnyStreaming && (
					<div className="flex gap-2">
						<button
							onClick={handleAcceptAll}
							className="text-[11px] px-2 py-0.5 rounded text-green-400 bg-green-400/10 border border-green-400/30 hover:bg-green-400/20 cursor-pointer transition-colors"
						>
							Accept All
						</button>
						<button
							onClick={handleRejectAll}
							className="text-[11px] px-2 py-0.5 rounded text-red-400 bg-red-400/10 border border-red-400/30 hover:bg-red-400/20 cursor-pointer transition-colors"
						>
							Reject All
						</button>
					</div>
				)}
			</div>

			{/* File list */}
			<div className="flex-1 overflow-y-auto">
				{entries.map(entry => {
					const relPath = getWorkspaceRelative(entry.uri, workspaceRoot);
					const name = getBasename(entry.uri);
					const isStreaming = entry.streamState === 'streaming';
					const hasFileDiffs = entry.streamState === 'idle-has-changes';

					return (
						<div
							key={entry.uri.fsPath}
							className="flex items-center gap-2 px-3 py-2 border-b border-trove-border-2/50 hover:bg-trove-bg-2 group transition-colors"
						>
							{/* Status indicator */}
							<div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isStreaming ? 'bg-blue-400 animate-pulse' : hasFileDiffs ? 'bg-yellow-400' : 'bg-green-400'}`} />

							{/* File info */}
							<button
								onClick={() => handleOpenFile(entry.uri)}
								className="flex-1 text-left cursor-pointer min-w-0"
								title={relPath}
							>
								<div className="truncate text-[12px] font-medium">{name}</div>
								<div className="truncate text-[10px] text-trove-fg-4">{relPath}</div>
							</button>

							{/* Diff count */}
							{entry.diffCount > 0 && (
								<span className="text-[10px] text-yellow-400 shrink-0">{entry.diffCount} change{entry.diffCount !== 1 ? 's' : ''}</span>
							)}
							{isStreaming && (
								<span className="text-[10px] text-blue-400 shrink-0">streaming…</span>
							)}

							{/* Per-file actions */}
							{hasFileDiffs && (
								<div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
									<button
										onClick={() => handleAcceptFile(entry.uri)}
										className="text-[10px] px-1.5 py-0.5 rounded text-green-400 hover:bg-green-400/20 cursor-pointer"
										title="Accept changes"
									>✓</button>
									<button
										onClick={() => handleRejectFile(entry.uri)}
										className="text-[10px] px-1.5 py-0.5 rounded text-red-400 hover:bg-red-400/20 cursor-pointer"
										title="Reject changes"
									>✕</button>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
};
