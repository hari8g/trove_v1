/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAccessor } from '../util/services.js';
import { INotepadsService, NotepadEntry } from '../../../notepadsService.js';

const useNotepads = () => {
	const accessor = useAccessor();
	const notepadsService = accessor.get('INotepadsService') as INotepadsService;
	const [notepads, setNotepads] = useState<NotepadEntry[]>(() => notepadsService.notepads);

	useEffect(() => {
		const disposable = notepadsService.onDidChange(() => {
			setNotepads([...notepadsService.notepads]);
		});
		return () => disposable.dispose();
	}, [notepadsService]);

	return { notepads, notepadsService };
};

export const NotepadsPanel: React.FC = () => {
	const { notepads, notepadsService } = useNotepads();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [editTitle, setEditTitle] = useState('');
	const [editContent, setEditContent] = useState('');
	const [isDirty, setIsDirty] = useState(false);
	const titleRef = useRef<HTMLInputElement>(null);

	const selectedNotepad = notepads.find(n => n.id === selectedId) ?? null;

	const selectNotepad = useCallback((np: NotepadEntry) => {
		if (isDirty && selectedId) {
			notepadsService.updateNotepad(selectedId, { title: editTitle, content: editContent });
		}
		setSelectedId(np.id);
		setEditTitle(np.title);
		setEditContent(np.content);
		setIsDirty(false);
	}, [isDirty, selectedId, editTitle, editContent, notepadsService]);

	const createNew = useCallback(() => {
		if (isDirty && selectedId) {
			notepadsService.updateNotepad(selectedId, { title: editTitle, content: editContent });
		}
		const np = notepadsService.createNotepad('Untitled');
		setSelectedId(np.id);
		setEditTitle(np.title);
		setEditContent(np.content);
		setIsDirty(false);
		setTimeout(() => titleRef.current?.select(), 50);
	}, [isDirty, selectedId, editTitle, editContent, notepadsService]);

	const save = useCallback(() => {
		if (selectedId) {
			notepadsService.updateNotepad(selectedId, { title: editTitle, content: editContent });
			setIsDirty(false);
		}
	}, [selectedId, editTitle, editContent, notepadsService]);

	const deleteSelected = useCallback(() => {
		if (selectedId) {
			notepadsService.deleteNotepad(selectedId);
			setSelectedId(null);
			setIsDirty(false);
		}
	}, [selectedId, notepadsService]);

	const onTitleChange = (v: string) => { setEditTitle(v); setIsDirty(true); };
	const onContentChange = (v: string) => { setEditContent(v); setIsDirty(true); };

	const formatDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

	return (
		<div className="flex h-full text-trove-fg-1 text-[13px]">
			{/* List sidebar */}
			<div className="w-44 flex flex-col border-r border-trove-border-2 shrink-0">
				<div className="flex items-center justify-between px-2 py-1.5 border-b border-trove-border-2">
					<span className="font-medium text-[11px] text-trove-fg-3 uppercase tracking-wide">Notepads</span>
					<button
						onClick={createNew}
						title="New notepad"
						className="text-trove-fg-3 hover:text-trove-fg-1 text-lg leading-none px-1 cursor-pointer"
					>+</button>
				</div>
				<div className="flex-1 overflow-y-auto">
					{notepads.length === 0 && (
						<div className="px-3 py-4 text-trove-fg-4 text-[11px] text-center">
							No notepads yet.<br />Click + to create one.
						</div>
					)}
					{notepads.map(np => (
						<button
							key={np.id}
							onClick={() => selectNotepad(np)}
							className={`w-full text-left px-2 py-1.5 cursor-pointer border-b border-trove-border-2/40 hover:bg-trove-bg-2 transition-colors ${selectedId === np.id ? 'bg-trove-bg-2 border-l-2 border-l-blue-500' : ''}`}
						>
							<div className="truncate text-[12px] font-medium">{np.title || 'Untitled'}</div>
							<div className="text-[10px] text-trove-fg-4 truncate">{formatDate(np.lastModified)}</div>
						</button>
					))}
				</div>
			</div>

			{/* Editor panel */}
			<div className="flex-1 flex flex-col min-w-0">
				{selectedNotepad || selectedId ? (
					<>
						<div className="flex items-center gap-2 px-3 py-1.5 border-b border-trove-border-2">
							<input
								ref={titleRef}
								value={editTitle}
								onChange={e => onTitleChange(e.target.value)}
								onBlur={save}
								className="flex-1 bg-transparent text-[13px] font-medium outline-none placeholder-trove-fg-4 min-w-0"
								placeholder="Notepad title…"
							/>
							{isDirty && (
								<button onClick={save} className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer shrink-0">Save</button>
							)}
							<button onClick={deleteSelected} title="Delete notepad" className="text-[10px] text-trove-fg-4 hover:text-red-400 cursor-pointer shrink-0">Delete</button>
						</div>
						<textarea
							value={editContent}
							onChange={e => onContentChange(e.target.value)}
							onBlur={save}
							placeholder="Write notes here… Use @notepad-name in chat to inject this context."
							className="flex-1 resize-none bg-transparent px-3 py-2 text-[12px] text-trove-fg-1 outline-none placeholder-trove-fg-4 font-mono leading-relaxed"
						/>
					</>
				) : (
					<div className="flex-1 flex items-center justify-center text-trove-fg-4 text-[12px] text-center px-6">
						Select a notepad to edit, or click + to create one.<br />
						<br />
						Use <code className="bg-trove-bg-2 px-1 rounded text-[11px]">@notepad-name</code> in chat to inject notepad content.
					</div>
				)}
			</div>
		</div>
	);
};
