/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useRef, useState } from 'react';
import { AnthropicReasoning } from '../../../../common/sendLLMMessageTypes.js';
import { ChevronRight } from 'lucide-react';

export const formatAnthropicReasoning = (blocks: AnthropicReasoning[] | null | undefined): string => {
	if (!blocks?.length) return '';
	return blocks
		.map(b => b.type === 'thinking' ? String(b.thinking ?? '').trim() : '[Redacted thinking]')
		.filter(Boolean)
		.join('\n\n');
};

export const CompactActivityRow = ({
	label,
	detail,
	isActive = true,
}: {
	label: React.ReactNode;
	detail?: React.ReactNode;
	isActive?: boolean;
}) => (
	<div className="flex items-center gap-1.5 py-0 text-[11px] leading-[1.35] text-trove-fg-3 select-none min-h-[18px]">
		{isActive ? (
			<span className="inline-block w-1 h-1 shrink-0 rounded-full bg-trove-fg-3/70 animate-pulse" />
		) : (
			<span className="inline-block w-1 h-1 shrink-0 rounded-full bg-trove-fg-4/40" />
		)}
		<span className="text-trove-fg-4 shrink-0">{label}</span>
		{detail ? <span className="text-trove-fg-3 truncate font-mono text-[11px]">{detail}</span> : null}
	</div>
);

export const CompactCompletedToolRow = ({
	label,
	detail,
	onDetailClick,
	suffix,
	isRejected,
}: {
	label: React.ReactNode;
	detail?: React.ReactNode;
	onDetailClick?: () => void;
	suffix?: React.ReactNode;
	isRejected?: boolean;
}) => (
	<div className={`flex items-center gap-1.5 py-0 text-[11px] leading-[1.35] text-trove-fg-3 select-none min-h-[18px] ${isRejected ? 'opacity-50 line-through' : ''}`}>
		<span className="text-trove-fg-4 shrink-0">{label}</span>
		{detail ? (
			<span
				className={`text-trove-fg-3 truncate font-mono text-[11px] ${onDetailClick ? 'cursor-pointer hover:underline' : ''}`}
				onClick={onDetailClick}
			>{detail}</span>
		) : null}
		{suffix ? <span className="text-trove-fg-4 shrink-0 ml-auto">{suffix}</span> : null}
	</div>
);

export const LiveActivityBanner = ({
	status,
	detail,
}: {
	status: 'thinking' | 'writing' | 'tool' | 'idle' | 'awaiting';
	detail?: string;
}) => {
	if (status === 'idle') return null;

	const label =
		status === 'thinking' ? 'Thinking'
			: status === 'writing' ? 'Writing'
				: status === 'tool' ? detail ?? 'Working'
					: status === 'awaiting' ? 'Needs approval'
						: '';

	return (
		<div className="flex items-center gap-2 py-1 text-xs text-trove-fg-3 select-none">
			<span className={`inline-block w-1.5 h-1.5 shrink-0 rounded-full animate-pulse ${status === 'awaiting' ? 'bg-yellow-400/80' : 'bg-trove-fg-3/70'}`} />
			<span className="italic">{label}{status === 'tool' && detail ? ` · ${detail}` : ''}</span>
		</div>
	);
};

export const LiveReasoningBlock = ({
	reasoning,
	anthropicReasoning,
	isStreaming,
	hasDisplayContent,
	children,
}: {
	reasoning: string | null;
	anthropicReasoning: AnthropicReasoning[] | null | undefined;
	isStreaming: boolean;
	hasDisplayContent: boolean;
	children: React.ReactNode;
}) => {
	const anthropicText = formatAnthropicReasoning(anthropicReasoning);
	const hasContent = !!(reasoning?.trim() || anthropicText);
	if (!hasContent) return null;

	const isLiveThinking = isStreaming && !hasDisplayContent;
	const thinkingStartRef = useRef(Date.now());
	const scrollRef = useRef<HTMLDivElement>(null);
	const [thoughtSeconds, setThoughtSeconds] = useState<number | null>(null);
	const [isExpanded, setIsExpanded] = useState(isLiveThinking);

	useEffect(() => {
		if (isLiveThinking) {
			thinkingStartRef.current = Date.now();
			setIsExpanded(true);
			setThoughtSeconds(null);
		}
	}, [isLiveThinking]);

	useEffect(() => {
		if (!isLiveThinking && hasContent) {
			const seconds = Math.max(1, Math.round((Date.now() - thinkingStartRef.current) / 1000));
			setThoughtSeconds(seconds);
			if (!isStreaming) setIsExpanded(false);
		}
	}, [isLiveThinking, hasContent, isStreaming]);

	useEffect(() => {
		if (isLiveThinking && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [isLiveThinking, reasoning, anthropicText, children]);

	if (isLiveThinking) {
		return (
			<div className="mb-1 select-none">
				<button
					type="button"
					onClick={() => setIsExpanded(v => !v)}
					className="flex items-center gap-1 text-[11px] text-trove-fg-4 hover:text-trove-fg-3 transition-colors py-0"
				>
					<ChevronRight className={`h-3 w-3 shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`} />
					<span className="inline-block w-1 h-1 rounded-full bg-violet-400/80 animate-pulse" />
					<span className="italic">Thinking</span>
				</button>
				{isExpanded ? (
					<div
						ref={scrollRef}
						className="mt-0.5 pl-2 ml-1 border-l border-trove-border-3/40 max-h-40 overflow-y-auto"
					>
						<div className="text-[11px] leading-[1.45] text-trove-fg-4 italic opacity-90 !select-text cursor-auto whitespace-pre-wrap">
							{children}
						</div>
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div className="mb-0.5 select-none">
			<button
				type="button"
				onClick={() => setIsExpanded(v => !v)}
				className="flex items-center gap-1 text-[11px] text-trove-fg-4 hover:text-trove-fg-3 transition-colors py-0"
			>
				<ChevronRight
					className={`h-3 w-3 shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
				/>
				<span className="italic">Thought for {thoughtSeconds ?? 1}s</span>
			</button>
			{isExpanded ? (
				<div className="mt-0.5 pl-2 ml-1 border-l border-trove-border-3/40 max-h-40 overflow-y-auto">
					<div className="text-[11px] leading-[1.45] text-trove-fg-4 opacity-85 !select-text cursor-auto whitespace-pre-wrap">
						{children}
					</div>
				</div>
			) : null}
		</div>
	);
};

export const EditToolChatBlock = ({
	fileName,
	filePath,
	addedLines,
	removedLines,
	onFileClick,
	isRejected,
	isRunning,
	children,
	footer,
}: {
	fileName: string;
	filePath?: string;
	addedLines?: number;
	removedLines?: number;
	onFileClick?: () => void;
	isRejected?: boolean;
	isRunning?: boolean;
	children: React.ReactNode;
	footer?: React.ReactNode;
}) => (
	<div className={`rounded-lg border border-trove-border-3/50 overflow-hidden my-1 ${isRejected ? 'opacity-50' : ''}`}>
		<div className={`flex items-center justify-between gap-2 px-2.5 py-1.5 bg-trove-bg-2/60 border-b border-trove-border-3/30 text-[11px] select-none ${isRejected ? 'line-through' : ''}`}>
			<div className="flex items-center gap-2 min-w-0">
				<span
					className={`font-mono text-trove-fg-2 truncate ${onFileClick ? 'cursor-pointer hover:underline' : ''}`}
					onClick={onFileClick}
					title={filePath}
				>
					{fileName}
				</span>
				{(addedLines !== undefined && addedLines > 0) || (removedLines !== undefined && removedLines > 0) ? (
					<span className="flex items-center gap-1.5 shrink-0 font-mono text-[10px]">
						{addedLines !== undefined && addedLines > 0 ? (
							<span className="text-green-600 dark:text-green-400">+{addedLines}</span>
						) : null}
						{removedLines !== undefined && removedLines > 0 ? (
							<span className="text-red-600 dark:text-red-400">−{removedLines}</span>
						) : null}
					</span>
				) : null}
			</div>
			{isRunning ? (
				<span className="text-trove-fg-4 italic shrink-0">Editing…</span>
			) : null}
		</div>
		<div className="overflow-x-auto">
			{children}
		</div>
		{footer ? (
			<div className="px-2.5 py-1.5 border-t border-trove-border-3/30 bg-trove-bg-2/40 flex flex-col gap-1.5">
				{footer}
			</div>
		) : null}
	</div>
);

export const ChatInlineDiffButtons = ({
	onAccept,
	onReject,
	acceptLabel = 'Accept',
	rejectLabel = 'Reject',
	disabled = false,
	className = '',
}: {
	onAccept: () => void;
	onReject: () => void;
	acceptLabel?: string;
	rejectLabel?: string;
	disabled?: boolean;
	className?: string;
}) => (
	<div className={`flex items-center gap-2 ${className}`}>
		<button
			type="button"
			disabled={disabled}
			onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReject(); }}
			className="px-2.5 py-1 text-xs rounded-md border border-trove-border-3 text-trove-fg-2 hover:bg-trove-bg-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
		>
			{rejectLabel}
		</button>
		<button
			type="button"
			disabled={disabled}
			onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAccept(); }}
			className="px-2.5 py-1 text-xs rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
			style={{
				backgroundColor: 'var(--vscode-button-background)',
				color: 'var(--vscode-button-foreground)',
			}}
		>
			{acceptLabel}
		</button>
	</div>
);
