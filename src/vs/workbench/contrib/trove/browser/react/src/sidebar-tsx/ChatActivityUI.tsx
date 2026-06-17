/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnthropicReasoning, RawToolCallObj } from '../../../../common/sendLLMMessageTypes.js';
import { ChatMessage } from '../../../../common/chatThreadServiceTypes.js';
import { BuiltinToolName } from '../../../../common/toolsServiceTypes.js';
import { builtinToolNames, isABuiltinToolName } from '../../../../common/prompt/prompts.js';
import { Check, ChevronRight, FileCode2, Pencil, Search, Sparkles, Terminal } from 'lucide-react';
import { MAX_FILE_PREVIEW_LINES } from './ChatInlineDiffView.js';

export type EditToolStreamStep = {
	id: string;
	label: string;
	detail?: string;
	status: 'pending' | 'active' | 'done';
};

const formatStreamingCharCount = (n: number): string => {
	if (n < 1000) return `${n} chars`;
	return `${(n / 1000).toFixed(1)}k chars`;
};

const basenameFromPath = (path: string): string => {
	const normalized = path.replace(/\\/g, '/');
	return normalized.split('/').pop() ?? path;
};

export const getEditToolStreamingSteps = (toolCallSoFar: RawToolCallObj): EditToolStreamStep[] => {
	const isEditFile = toolCallSoFar.name === 'edit_file';
	const contentParam = isEditFile ? 'search_replace_blocks' : 'new_content';
	const { rawParams, doneParams, isDone } = toolCallSoFar;

	const uri = rawParams.uri?.trim() ?? '';
	const uriDone = doneParams.includes('uri');
	const content = rawParams[contentParam] ?? '';
	const contentDone = doneParams.includes(contentParam);

	const blockCount = isEditFile ? (content.match(/<<<<<<<\s/g) ?? []).length : 0;
	const contentDetail = content.length > 0
		? (blockCount > 0
			? `${blockCount} block${blockCount === 1 ? '' : 's'} · ${formatStreamingCharCount(content.length)}`
			: formatStreamingCharCount(content.length))
		: undefined;

	const steps: EditToolStreamStep[] = [
		{
			id: 'invoke',
			label: 'Preparing edit',
			status: uri || toolCallSoFar.name ? 'done' : 'active',
		},
		{
			id: 'uri',
			label: uriDone ? 'Target file' : 'Reading target file',
			detail: uri ? basenameFromPath(uri) : undefined,
			status: !uri ? 'pending' : uriDone ? 'done' : 'active',
		},
		{
			id: 'content',
			label: isEditFile ? 'Generating search/replace blocks' : 'Generating file content',
			detail: contentDetail,
			status: !uriDone && !uri
				? 'pending'
				: isDone || contentDone
					? 'done'
					: 'active',
		},
		{
			id: 'preview',
			label: 'Building diff preview',
			status: isDone
				? 'done'
				: uri && content.length > 0
					? contentDone ? 'active' : 'pending'
					: 'pending',
		},
	];

	return steps;
};

const StreamingStepRow = ({ step }: { step: EditToolStreamStep }) => (
	<div className={`flex items-center gap-1.5 py-0.5 text-[11px] leading-[1.35] min-h-[18px] ${step.status === 'pending' ? 'opacity-50' : ''}`}>
		{step.status === 'done' ? (
			<span className="inline-block w-1 h-1 shrink-0 rounded-full bg-green-500/70" />
		) : step.status === 'active' ? (
			<span className="inline-block w-1 h-1 shrink-0 rounded-full bg-trove-fg-3/70 animate-pulse" />
		) : (
			<span className="inline-block w-1 h-1 shrink-0 rounded-full bg-trove-fg-4/30" />
		)}
		<span className={`shrink-0 ${step.status === 'active' ? 'text-trove-fg-3 italic' : 'text-trove-fg-4'}`}>
			{step.label}
		</span>
		{step.detail ? (
			<span className="text-trove-fg-3 truncate font-mono text-[11px]">{step.detail}</span>
		) : null}
	</div>
);

export const StreamingEditToolCard = ({
	toolCallSoFar,
	addedLines,
	removedLines,
	onFileClick,
	filePath,
	children,
}: {
	toolCallSoFar: RawToolCallObj;
	addedLines?: number;
	removedLines?: number;
	onFileClick?: () => void;
	filePath?: string;
	children?: React.ReactNode;
}) => {
	const steps = useMemo(() => getEditToolStreamingSteps(toolCallSoFar), [toolCallSoFar]);
	const [isExpanded, setIsExpanded] = useState(false);
	const stepsRef = useRef<HTMLDivElement>(null);
	const activeStep = steps.find(s => s.status === 'active');

	const toolTitle = toolCallSoFar.name === 'edit_file' ? 'Edit file' : 'Write file';
	const uri = toolCallSoFar.rawParams.uri?.trim();
	const fileName = uri ? basenameFromPath(uri) : undefined;

	useEffect(() => {
		if (stepsRef.current) {
			stepsRef.current.scrollTop = stepsRef.current.scrollHeight;
		}
	}, [steps]);

	return (
		<div className="glass-card overflow-hidden my-1.5 select-none">
			<button
				type="button"
				className="w-full flex items-center min-h-[28px] px-2.5 py-1.5 cursor-pointer hover:bg-trove-bg-2/30 transition-colors text-left"
				onClick={() => setIsExpanded(v => !v)}
			>
				<ChevronRight
					className={`text-trove-fg-4 mr-1 h-3.5 w-3.5 flex-shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
				/>
				<span className="text-trove-fg-3 flex-shrink-0 text-[11px]">{toolTitle}</span>
				{fileName ? (
					<span
						className={`text-trove-fg-2 text-[11px] truncate ml-2 font-mono ${onFileClick ? 'cursor-pointer hover:underline' : ''}`}
						onClick={(e) => { if (onFileClick) { e.stopPropagation(); onFileClick(); } }}
						title={filePath}
					>
						{fileName}
					</span>
				) : (
					<span className="text-trove-fg-4 text-[11px] italic truncate ml-2">
						{activeStep?.label ?? 'Generating…'}
					</span>
				)}
				{(addedLines !== undefined && addedLines > 0) || (removedLines !== undefined && removedLines > 0) ? (
					<span className="flex items-center gap-1.5 shrink-0 font-mono text-[10px] ml-auto">
						{addedLines !== undefined && addedLines > 0 ? (
							<span className="text-green-600 dark:text-green-400">+{addedLines}</span>
						) : null}
						{removedLines !== undefined && removedLines > 0 ? (
							<span className="text-red-600 dark:text-red-400">−{removedLines}</span>
						) : null}
					</span>
				) : null}
			</button>
			{isExpanded ? (
				<div className="pl-4 pr-2 pb-2 pt-0 border-t border-trove-border-3/25">
					<div ref={stepsRef} className="max-h-28 overflow-y-auto mb-1">
						{steps.map(step => (
							<StreamingStepRow key={step.id} step={step} />
						))}
					</div>
				</div>
			) : null}
			{children ? (
				<div className="border-t border-trove-border-3/25 overflow-hidden">
					{React.isValidElement(children)
						? React.cloneElement(children as React.ReactElement<{ limitLines?: boolean; maxVisibleLines?: number }>, {
							limitLines: !isExpanded,
							maxVisibleLines: MAX_FILE_PREVIEW_LINES,
						})
						: children}
				</div>
			) : null}
		</div>
	);
};

/** Collapsible plain-code snippet (search results, file reads). */
export const CollapsibleCodeSnippet = ({
	fileName,
	subtitle,
	onFileClick,
	code,
	defaultExpanded = false,
}: {
	fileName: string;
	subtitle?: string;
	onFileClick?: () => void;
	code: string;
	defaultExpanded?: boolean;
}) => {
	const [isExpanded, setIsExpanded] = useState(defaultExpanded);
	const lines = code.split('\n');
	const visible = isExpanded ? lines : lines.slice(0, MAX_FILE_PREVIEW_LINES);
	const hiddenCount = isExpanded ? 0 : Math.max(0, lines.length - MAX_FILE_PREVIEW_LINES);

	return (
		<div className="glass-card overflow-hidden my-1">
			<button
				type="button"
				className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-trove-bg-2/30 transition-colors"
				onClick={() => setIsExpanded(v => !v)}
			>
				<ChevronRight className={`h-3.5 w-3.5 shrink-0 text-trove-fg-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
				<span
					className={`font-mono text-[11px] text-trove-fg-2 truncate ${onFileClick ? 'hover:underline' : ''}`}
					onClick={(e) => { if (onFileClick) { e.stopPropagation(); onFileClick(); } }}
				>
					{fileName}
				</span>
				{subtitle ? <span className="text-[10px] text-trove-fg-4 truncate">{subtitle}</span> : null}
			</button>
			<pre className="font-mono text-[11px] leading-[1.45] px-2.5 py-1 border-t border-trove-border-3/25 overflow-x-auto whitespace-pre-wrap text-trove-fg-3 bg-trove-bg-2/15">
				{visible.join('\n')}
				{hiddenCount > 0 ? `\n… +${hiddenCount} more line${hiddenCount === 1 ? '' : 's'}` : ''}
			</pre>
		</div>
	);
};

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

export type AgentTurnActivityItem = {
	label: string;
	kind: 'read' | 'edit' | 'write' | 'search' | 'run' | 'other';
};

export type AgentTurnActivitySummary = {
	fileCount: number;
	toolCount: number;
	recentFilesLine?: string;
	summaryLine?: string;
	activityItems: AgentTurnActivityItem[];
	touchedFiles: string[];
};

const activityKindForTool = (toolName: BuiltinToolName): AgentTurnActivityItem['kind'] => {
	switch (toolName) {
		case 'read_file':
		case 'ls_dir':
		case 'get_dir_tree':
		case 'read_lint_errors':
			return 'read';
		case 'edit_file':
			return 'edit';
		case 'rewrite_file':
			return 'write';
		case 'search_codebase':
		case 'search_for_files':
		case 'search_pathnames_only':
		case 'search_in_file':
		case 'search_web':
			return 'search';
		case 'run_command':
		case 'run_persistent_command':
		case 'open_persistent_terminal':
		case 'kill_persistent_terminal':
			return 'run';
		default:
			return 'other';
	}
};

const ACTIVITY_STAT_TW: Record<AgentTurnActivityItem['kind'], { chip: string; icon: string }> = {
	read: {
		chip: 'border-sky-400/30 bg-gradient-to-br from-sky-500/20 via-sky-400/5 to-transparent text-sky-900 dark:text-sky-100 ring-1 ring-inset ring-sky-400/15 shadow-sm shadow-sky-500/10',
		icon: 'text-sky-500 dark:text-sky-400',
	},
	edit: {
		chip: 'border-violet-400/30 bg-gradient-to-br from-violet-500/20 via-fuchsia-500/5 to-transparent text-violet-900 dark:text-violet-100 ring-1 ring-inset ring-violet-400/15 shadow-sm shadow-violet-500/10',
		icon: 'text-violet-500 dark:text-violet-400',
	},
	write: {
		chip: 'border-fuchsia-400/30 bg-gradient-to-br from-fuchsia-500/20 via-pink-500/5 to-transparent text-fuchsia-900 dark:text-fuchsia-100 ring-1 ring-inset ring-fuchsia-400/15 shadow-sm shadow-fuchsia-500/10',
		icon: 'text-fuchsia-500 dark:text-fuchsia-400',
	},
	search: {
		chip: 'border-amber-400/30 bg-gradient-to-br from-amber-500/20 via-orange-400/5 to-transparent text-amber-900 dark:text-amber-100 ring-1 ring-inset ring-amber-400/15 shadow-sm shadow-amber-500/10',
		icon: 'text-amber-500 dark:text-amber-400',
	},
	run: {
		chip: 'border-emerald-400/30 bg-gradient-to-br from-emerald-500/20 via-teal-400/5 to-transparent text-emerald-900 dark:text-emerald-100 ring-1 ring-inset ring-emerald-400/15 shadow-sm shadow-emerald-500/10',
		icon: 'text-emerald-500 dark:text-emerald-400',
	},
	other: {
		chip: 'border-trove-border-3/60 bg-gradient-to-br from-trove-bg-3/80 to-transparent text-trove-fg-2 ring-1 ring-inset ring-trove-border-3/40',
		icon: 'text-trove-fg-3',
	},
};

const ActivityStatIcon = ({ kind }: { kind: AgentTurnActivityItem['kind'] }) => {
	const iconClass = `shrink-0 ${ACTIVITY_STAT_TW[kind].icon}`;
	const size = 10;
	switch (kind) {
		case 'read': return <FileCode2 size={size} className={iconClass} aria-hidden="true" />;
		case 'edit': return <Pencil size={size} className={iconClass} aria-hidden="true" />;
		case 'write': return <Sparkles size={size} className={iconClass} aria-hidden="true" />;
		case 'search': return <Search size={size} className={iconClass} aria-hidden="true" />;
		case 'run': return <Terminal size={size} className={iconClass} aria-hidden="true" />;
		default: return <Sparkles size={size} className={iconClass} aria-hidden="true" />;
	}
};

const basenameFromFsPath = (fsPath: string): string => {
	const normalized = fsPath.replace(/\\/g, '/');
	return normalized.split('/').pop() ?? fsPath;
};

const toolActivityLabel = (toolName: BuiltinToolName, count: number): string => {
	const labels: Partial<Record<BuiltinToolName, [string, string]>> = {
		read_file: ['file read', 'files read'],
		search_codebase: ['codebase search', 'codebase searches'],
		search_for_files: ['file search', 'file searches'],
		search_pathnames_only: ['path search', 'path searches'],
		search_in_file: ['in-file search', 'in-file searches'],
		ls_dir: ['folder listed', 'folders listed'],
		get_dir_tree: ['tree listed', 'trees listed'],
		run_command: ['command run', 'commands run'],
		run_persistent_command: ['command run', 'commands run'],
		edit_file: ['edit', 'edits'],
		rewrite_file: ['write', 'writes'],
	};
	const pair = labels[toolName];
	if (pair) {
		return `${count} ${count === 1 ? pair[0] : pair[1]}`;
	}
	return `${count} tool call${count === 1 ? '' : 's'}`;
};

export const summarizeAgentTurnActivity = (messages: ChatMessage[]): AgentTurnActivitySummary => {
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			lastUserIdx = i;
			break;
		}
	}

	const turnMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;
	const toolCounts = new Map<string, number>();
	const readFiles: string[] = [];
	const touchedFiles: string[] = [];

	for (const message of turnMessages) {
		if (message.role !== 'tool') continue;
		if (message.type !== 'success' && message.type !== 'running_now') continue;

		toolCounts.set(message.name, (toolCounts.get(message.name) ?? 0) + 1);

		if ('params' in message && message.params && 'uri' in message.params) {
			const basename = basenameFromFsPath(message.params.uri.fsPath);
			if (message.name === 'read_file') {
				readFiles.push(basename);
			}
			if (message.name === 'read_file' || message.name === 'edit_file' || message.name === 'rewrite_file') {
				touchedFiles.push(basename);
			}
		}
	}

	const toolCount = [...toolCounts.values()].reduce((sum, n) => sum + n, 0);
	const fileCount = toolCounts.get('read_file') ?? 0;

	const activityItems: AgentTurnActivityItem[] = [];
	const summaryParts: string[] = [];
	for (const toolName of builtinToolNames) {
		const count = toolCounts.get(toolName);
		if (count && isABuiltinToolName(toolName)) {
			const label = toolActivityLabel(toolName, count);
			activityItems.push({ label, kind: activityKindForTool(toolName) });
			summaryParts.push(label);
		}
	}
	for (const [toolName, count] of toolCounts) {
		if (!isABuiltinToolName(toolName)) {
			const label = `${count} MCP call${count === 1 ? '' : 's'}`;
			activityItems.push({ label, kind: 'other' });
			summaryParts.push(label);
		}
	}

	let recentFilesLine: string | undefined;
	const uniqueTouched = [...new Set(touchedFiles)];
	if (readFiles.length > 0) {
		const unique = [...new Set(readFiles)];
		if (unique.length <= 3) {
			recentFilesLine = unique.join(', ');
		} else {
			recentFilesLine = `${unique.slice(0, 3).join(', ')} +${unique.length - 3} more`;
		}
	}

	return {
		fileCount,
		toolCount,
		recentFilesLine,
		summaryLine: summaryParts.length > 0 ? summaryParts.join(' · ') : undefined,
		activityItems,
		touchedFiles: uniqueTouched,
	};
};

/** Compact recap shown after a turn finishes (when tools were used). */
export const AgentTurnCompleteSummaryCard = ({ summary }: { summary: AgentTurnActivitySummary }) => {
	if (!summary.summaryLine) return null;

	const files = summary.touchedFiles.length > 0
		? summary.touchedFiles
		: (summary.recentFilesLine?.split(', ').map(f => f.replace(/ \+\d+ more$/, '').trim()).filter(Boolean) ?? []);

	return (
		<div className="relative my-1.5 overflow-hidden rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/[0.07] via-trove-bg-2/95 to-indigo-500/[0.05] shadow-md shadow-emerald-500/5 backdrop-blur-xl select-none">
			<div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-emerald-400/20 blur-2xl" aria-hidden="true" />

			{/* header — single tight row */}
			<div className="relative flex items-center justify-between gap-2 border-b border-white/10 dark:border-white/5 px-2.5 py-1.5">
				<div className="flex min-w-0 items-center gap-2">
					<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400/25 to-teal-500/10 ring-1 ring-emerald-400/25" aria-hidden="true">
						<Check size={14} strokeWidth={2.5} className="text-emerald-600 dark:text-emerald-400" />
					</div>
					<div className="min-w-0 leading-none">
						<p className="text-[12px] font-semibold tracking-tight text-trove-fg-1">
							Turn complete
							<span className="font-normal text-trove-fg-4">
								{' · '}
								<span className="text-emerald-600 dark:text-emerald-400">{summary.toolCount}</span>
								{' action'}{summary.toolCount === 1 ? '' : 's'}
							</span>
						</p>
					</div>
				</div>
				<span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-400/25">
					Done
				</span>
			</div>

			{/* activity stats — dense inline chips */}
			{summary.activityItems.length > 0 ? (
				<div className="relative flex flex-wrap gap-1 px-2.5 py-1.5">
					{summary.activityItems.map((item) => (
						<span
							key={item.label}
							className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none ${ACTIVITY_STAT_TW[item.kind].chip}`}
						>
							<ActivityStatIcon kind={item.kind} />
							<span className="truncate">{item.label}</span>
						</span>
					))}
				</div>
			) : null}

			{/* files — label inline with chips */}
			{files.length > 0 ? (
				<div className="relative flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-white/10 dark:border-white/5 px-2.5 py-1.5">
					<span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-trove-fg-4">
						Files
					</span>
					{files.slice(0, 8).map((file, i) => (
						<span
							key={file}
							title={file}
							className={`inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-none text-trove-fg-2 ${
								i % 3 === 0
									? 'border-sky-400/20 bg-sky-500/10'
									: i % 3 === 1
										? 'border-violet-400/20 bg-violet-500/10'
										: 'border-amber-400/20 bg-amber-500/10'
							}`}
						>
							<FileCode2 size={9} className="shrink-0 opacity-70" aria-hidden="true" />
							<span className="truncate max-w-[110px]">{file}</span>
						</span>
					))}
					{files.length > 8 ? (
						<span className="text-[9px] font-semibold text-trove-fg-4">+{files.length - 8}</span>
					) : null}
				</div>
			) : null}
		</div>
	);
};

export type BackgroundActivityPhase =
	| 'preparing'
	| 'waiting'
	| 'reasoning'
	| 'writing'
	| 'tool'
	| 'awaiting';

export const BackgroundActivityPanel = ({
	phase,
	title,
	detail,
	contextLine,
}: {
	phase: BackgroundActivityPhase;
	title: string;
	detail?: string;
	contextLine?: string;
}) => {
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const startedAtRef = useRef(Date.now());

	useEffect(() => {
		startedAtRef.current = Date.now();
		setElapsedSeconds(0);
	}, [phase, title, detail, contextLine]);

	useEffect(() => {
		const interval = setInterval(() => {
			setElapsedSeconds(Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)));
		}, 500);
		return () => clearInterval(interval);
	}, [phase, title, detail, contextLine]);

	const phaseHint =
		phase === 'preparing' ? 'Assembling context'
			: phase === 'waiting' ? 'Waiting for model response'
				: phase === 'reasoning' ? 'Internal reasoning'
					: phase === 'writing' ? 'Streaming reply'
						: phase === 'tool' ? 'Tool execution'
							: 'Needs your input';

	return (
		<div className="glass-card px-2.5 py-2 my-1 select-none">
			<div className="flex items-start gap-2">
				<span className={`inline-block w-1.5 h-1.5 shrink-0 rounded-full mt-1 animate-pulse ${phase === 'awaiting' ? 'bg-yellow-400/80' : 'bg-violet-400/80'}`} />
				<div className="min-w-0 flex-1 flex flex-col gap-1">
					<div className="flex items-baseline justify-between gap-2">
						<span className="text-[11px] text-trove-fg-2 font-medium truncate">{title}</span>
						<span className="text-[10px] text-trove-fg-4 shrink-0 tabular-nums">{elapsedSeconds}s</span>
					</div>
					{detail ? (
						<div className="text-[11px] leading-snug text-trove-fg-3">{detail}</div>
					) : null}
					{contextLine ? (
						<div className="text-[10px] leading-snug text-trove-fg-4 truncate" title={contextLine}>
							Recent: {contextLine}
						</div>
					) : null}
					<div className="text-[10px] text-trove-fg-4 italic">{phaseHint}</div>
				</div>
			</div>
		</div>
	);
};

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
	const isLiveThinking = isStreaming && !hasDisplayContent;

	if (!hasContent && !isLiveThinking) return null;
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
							{hasContent ? children : (
								<span className="opacity-80">Reasoning stream starting…</span>
							)}
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
	defaultExpanded = false,
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
	defaultExpanded?: boolean;
}) => {
	const [isExpanded, setIsExpanded] = React.useState(defaultExpanded);

	return (
	<div className={`glass-card overflow-hidden my-1.5 ${isRejected ? 'opacity-50' : ''}`}>
		<button
			type="button"
			className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-[11px] select-none text-left hover:bg-trove-bg-2/30 transition-colors ${isRejected ? 'line-through' : ''}`}
			onClick={() => setIsExpanded(v => !v)}
		>
			<div className="flex items-center gap-1.5 min-w-0 flex-1">
				<ChevronRight
					className={`h-3.5 w-3.5 shrink-0 text-trove-fg-4 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
				/>
				<span
					className={`font-mono text-trove-fg-2 truncate ${onFileClick ? 'cursor-pointer hover:underline' : ''}`}
					onClick={(e) => { if (onFileClick) { e.stopPropagation(); onFileClick(); } }}
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
		</button>
		<div className="overflow-x-auto border-t border-trove-border-3/25">
			{React.isValidElement(children)
				? React.cloneElement(children as React.ReactElement<{ limitLines?: boolean; maxVisibleLines?: number }>, {
					limitLines: !isExpanded,
					maxVisibleLines: MAX_FILE_PREVIEW_LINES,
				})
				: children}
		</div>
		{footer && isExpanded ? (
			<div className="px-2.5 py-1.5 border-t border-trove-border-3/25 bg-trove-bg-2/20 flex flex-col gap-1.5">
				{footer}
			</div>
		) : null}
	</div>
	);
};

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
