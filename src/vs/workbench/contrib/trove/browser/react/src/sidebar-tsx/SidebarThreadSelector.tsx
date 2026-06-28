/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton, IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useFullChatThreadsStreamState, useSettingsState } from '../util/services.js';
import { IconX } from './SidebarChat.js';
import { Check, Copy, Icon, LoaderCircle, MessageCircleQuestion, Pencil, Trash2, UserCheck, X } from 'lucide-react';
import { IsRunningType, ThreadType } from '../../../chatThreadService.js';


const numInitialThreads = 3

export const PastThreadsList = ({ className = '' }: { className?: string }) => {
	const [showAll, setShowAll] = useState(false);

	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

	const threadsState = useChatThreadsState()
	const { allThreads } = threadsState

	const streamState = useFullChatThreadsStreamState()

	const runningThreadIds: { [threadId: string]: IsRunningType | undefined } = {}
	for (const threadId in streamState) {
		const isRunning = streamState[threadId]?.isRunning
		if (isRunning) { runningThreadIds[threadId] = isRunning }
	}

	if (!allThreads) {
		return <div key="error" className="p-1">{`Error accessing chat history.`}</div>;
	}

	// sorted by most recent to least recent
	const sortedThreadIds = Object.keys(allThreads ?? {})
		.sort((threadId1, threadId2) => (allThreads[threadId1]?.lastModified ?? 0) > (allThreads[threadId2]?.lastModified ?? 0) ? -1 : 1)
		.filter(threadId => (allThreads![threadId]?.messages.length ?? 0) !== 0)

	// Get only first 5 threads if not showing all
	const hasMoreThreads = sortedThreadIds.length > numInitialThreads;
	const displayThreads = showAll ? sortedThreadIds : sortedThreadIds.slice(0, numInitialThreads);

	return (
		<div className={`flex flex-col mb-2 gap-2 w-full text-nowrap text-trove-fg-3 select-none relative ${className}`}>
			{displayThreads.length === 0 // this should never happen
				? <></>
				: displayThreads.map((threadId, i) => {
					const pastThread = allThreads[threadId];
					if (!pastThread) {
						return <div key={i} className="p-1">{`Error accessing chat history.`}</div>;
					}

					return (
						<PastThreadElement
							key={pastThread.id}
							pastThread={pastThread}
							idx={i}
							hoveredIdx={hoveredIdx}
							setHoveredIdx={setHoveredIdx}
							isRunning={runningThreadIds[pastThread.id]}
						/>
					);
				})
			}

			{hasMoreThreads && !showAll && (
				<div
					className="text-trove-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 cursor-pointer p-1 text-xs"
					onClick={() => setShowAll(true)}
				>
					Show {sortedThreadIds.length - numInitialThreads} more...
				</div>
			)}
			{hasMoreThreads && showAll && (
				<div
					className="text-trove-fg-3 opacity-80 hover:opacity-100 hover:brightness-115 cursor-pointer p-1 text-xs"
					onClick={() => setShowAll(false)}
				>
					Show less
				</div>
			)}
		</div>
	);
};





// Format date to display as today, yesterday, or date
const formatDate = (date: Date) => {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	if (date >= today) {
		return 'Today';
	} else if (date >= yesterday) {
		return 'Yesterday';
	} else {
		return `${date.toLocaleString('default', { month: 'short' })} ${date.getDate()}`;
	}
};

// Format time to 12-hour format
const formatTime = (date: Date) => {
	return date.toLocaleString('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		hour12: true
	});
};

const getThreadDisplayTitle = (pastThread: ThreadType): string => {
	if (pastThread.title?.trim()) {
		return pastThread.title.trim();
	}

	const firstUserMsgIdx = pastThread.messages.findIndex((msg) => msg.role === 'user');
	if (firstUserMsgIdx !== -1) {
		const firstUserMsgObj = pastThread.messages[firstUserMsgIdx];
		return firstUserMsgObj.role === 'user' && firstUserMsgObj.displayContent || '';
	}

	return 'Untitled';
};


const DuplicateButton = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	return <IconShell1
		Icon={Copy}
		className='size-[11px]'
		onClick={() => { chatThreadsService.duplicateThread(threadId); }}
		data-tooltip-id='trove-tooltip'
		data-tooltip-place='top'
		data-tooltip-content='Duplicate thread'
	>
	</IconShell1>

}

const TrashButton = ({ threadId }: { threadId: string }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')


	const [isTrashPressed, setIsTrashPressed] = useState(false)

	return (isTrashPressed ?
		<div className='flex flex-nowrap text-nowrap gap-1'>
			<IconShell1
				Icon={X}
				className='size-[11px]'
				onClick={() => { setIsTrashPressed(false); }}
				data-tooltip-id='trove-tooltip'
				data-tooltip-place='top'
				data-tooltip-content='Cancel'
			/>
			<IconShell1
				Icon={Check}
				className='size-[11px]'
				onClick={() => { chatThreadsService.deleteThread(threadId); setIsTrashPressed(false); }}
				data-tooltip-id='trove-tooltip'
				data-tooltip-place='top'
				data-tooltip-content='Confirm'
			/>
		</div>
		: <IconShell1
			Icon={Trash2}
			className='size-[11px]'
			onClick={() => { setIsTrashPressed(true); }}
			data-tooltip-id='trove-tooltip'
			data-tooltip-place='top'
			data-tooltip-content='Delete thread'
		/>
	)
}

const RenameButton = ({ onClick }: { onClick: () => void }) => {
	return <IconShell1
		Icon={Pencil}
		className='size-[11px]'
		onClick={onClick}
		data-tooltip-id='trove-tooltip'
		data-tooltip-place='top'
		data-tooltip-content='Rename thread'
	/>
}

const PastThreadElement = ({ pastThread, idx, hoveredIdx, setHoveredIdx, isRunning }: {
	pastThread: ThreadType,
	idx: number,
	hoveredIdx: number | null,
	setHoveredIdx: (idx: number | null) => void,
	isRunning: IsRunningType | undefined,
}

) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	const [isRenaming, setIsRenaming] = useState(false)
	const [renameValue, setRenameValue] = useState('')
	const renameInputRef = useRef<HTMLInputElement>(null)

	const displayTitle = getThreadDisplayTitle(pastThread)
	const numMessages = pastThread.messages.filter((msg) => msg.role === 'assistant' || msg.role === 'user').length;

	useEffect(() => {
		if (isRenaming) {
			renameInputRef.current?.focus()
			renameInputRef.current?.select()
		}
	}, [isRenaming])

	const startRename = () => {
		setRenameValue(pastThread.title ?? displayTitle)
		setIsRenaming(true)
	}

	const confirmRename = () => {
		chatThreadsService.renameThread(pastThread.id, renameValue)
		setIsRenaming(false)
	}

	const cancelRename = () => {
		setIsRenaming(false)
	}

	const detailsHTML = <span
	// data-tooltip-id='trove-tooltip'
	// data-tooltip-content={`Last modified ${formatTime(new Date(pastThread.lastModified))}`}
	// data-tooltip-place='top'
	>
		<span className='opacity-60'>{numMessages}</span>
		{` `}
		{formatDate(new Date(pastThread.lastModified))}
		{/* {` messages `} */}
	</span>

	return <div
		key={pastThread.id}
		className={`
			py-1 px-2 rounded text-sm bg-zinc-700/5 hover:bg-zinc-700/10 dark:bg-zinc-300/5 dark:hover:bg-zinc-300/10 cursor-pointer opacity-80 hover:opacity-100
		`}
		onClick={() => {
			if (isRenaming) return
			chatThreadsService.switchToThread(pastThread.id);
		}}
		onMouseEnter={() => setHoveredIdx(idx)}
		onMouseLeave={() => setHoveredIdx(null)}
	>
		<div className="flex items-center justify-between gap-1">
			<span className="flex items-center gap-2 min-w-0 overflow-hidden">
				{/* spinner */}
			{isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'idle' ? <LoaderCircle className="animate-spin bg-trove-stroke-1 flex-shrink-0 flex-grow-0" size={14} />
				:
				isRunning === 'awaiting_user' ? <MessageCircleQuestion className="bg-trove-stroke-1 flex-shrink-0 flex-grow-0" size={14} />
				:
				isRunning === 'background' ? (
					<span
						className="text-[9px] font-semibold px-1 py-0 rounded bg-blue-500/20 text-blue-400 flex-shrink-0 animate-pulse"
						title="Running in background"
					>BG</span>
				)
					:
					null}
				{/* name */}
				{isRenaming ? (
					<input
						ref={renameInputRef}
						value={renameValue}
						onChange={(e) => setRenameValue(e.target.value)}
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => {
							e.stopPropagation()
							if (e.key === 'Enter') confirmRename()
							if (e.key === 'Escape') cancelRename()
						}}
						className="min-w-0 flex-1 truncate rounded border border-trove-border-1 bg-trove-bg-1 px-1 py-0.5 text-sm text-trove-fg-1 outline-none"
					/>
				) : (
					<span className="truncate overflow-hidden text-ellipsis"
						data-tooltip-id='trove-tooltip'
						data-tooltip-content={numMessages + ' messages'}
						data-tooltip-place='top'
					>{displayTitle}</span>
				)}

				{/* <span className='opacity-60'>{`(${numMessages})`}</span> */}
			</span>

			<div className="flex items-center gap-x-1 opacity-60">
				{isRenaming ?
					<div className='flex flex-nowrap text-nowrap gap-1'>
						<IconShell1
							Icon={X}
							className='size-[11px]'
							onClick={cancelRename}
							data-tooltip-id='trove-tooltip'
							data-tooltip-place='top'
							data-tooltip-content='Cancel'
						/>
						<IconShell1
							Icon={Check}
							className='size-[11px]'
							onClick={confirmRename}
							data-tooltip-id='trove-tooltip'
							data-tooltip-place='top'
							data-tooltip-content='Save'
						/>
					</div>
					: idx === hoveredIdx ?
					<>
						<RenameButton onClick={startRename} />
						<DuplicateButton threadId={pastThread.id} />
						<TrashButton threadId={pastThread.id} />
					</>
					: <>
						{detailsHTML}
					</>
				}
			</div>
		</div>
	</div>
}
