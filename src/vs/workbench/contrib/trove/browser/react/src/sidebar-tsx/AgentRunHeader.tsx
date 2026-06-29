/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { Maximize2, Minimize2, Square, StopCircle, Layers } from 'lucide-react';
import { ChatMode } from '../../../../common/troveSettingsTypes.js';
import type { BackgroundActivityPhase } from './ChatActivityUI.js';

const MODE_CHIP: Record<ChatMode, { label: string; className: string }> = {
	agent: {
		label: 'Agent',
		className: 'bg-violet-500/15 text-violet-700 dark:text-violet-200 ring-violet-400/25',
	},
	gather: {
		label: 'Gather',
		className: 'bg-sky-500/15 text-sky-800 dark:text-sky-100 ring-sky-400/25',
	},
	normal: {
		label: 'Chat',
		className: 'bg-trove-bg-3/80 text-trove-fg-2 ring-trove-border-3/50',
	},
};

const PHASE_LABEL: Record<BackgroundActivityPhase, string> = {
	preparing: 'Preparing',
	tool: 'Running tool',
	writing: 'Writing',
	reasoning: 'Reasoning',
	waiting: 'Waiting',
	awaiting: 'Needs approval',
};

export const AgentRunHeader = ({
	chatMode,
	modelLabel,
	phase,
	statusTitle,
	statusDetail,
	isRunning,
	isFocusMode,
	onToggleFocus,
	onStop,
	onRunInBackground,
	onNewThread,
}: {
	chatMode: ChatMode;
	modelLabel: string;
	phase?: BackgroundActivityPhase;
	statusTitle?: string;
	statusDetail?: string;
	isRunning: boolean;
	isFocusMode: boolean;
	onToggleFocus: () => void;
	onStop: () => void;
	onRunInBackground: () => void;
	onNewThread: () => void;
}) => {
	const modeChip = MODE_CHIP[chatMode];
	const phaseLabel = phase ? PHASE_LABEL[phase] : isRunning ? 'Active' : 'Ready';

	return (
		<div className="shrink-0 border-b border-trove-border-2/80 bg-trove-bg-2/95 backdrop-blur-md px-2.5 py-2">
			<div className="flex items-start justify-between gap-2 min-w-0">
				<div className="min-w-0 flex-1 flex flex-col gap-1">
					<div className="flex items-center gap-1.5 flex-wrap min-w-0">
						<span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${modeChip.className}`}>
							{modeChip.label}
						</span>
						<span className="text-[10px] text-trove-fg-4 truncate max-w-[160px]" title={modelLabel}>
							{modelLabel}
						</span>
						{isRunning ? (
							<span className="inline-flex items-center gap-1 text-[10px] text-trove-fg-3">
								<span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400/90 animate-pulse" />
								{phaseLabel}
							</span>
						) : (
							<span className="text-[10px] text-trove-fg-4">Ready</span>
						)}
					</div>
					{(statusTitle || statusDetail) ? (
						<div className="min-w-0">
							{statusTitle ? (
								<div className="text-[11px] font-medium text-trove-fg-2 truncate">{statusTitle}</div>
							) : null}
							{statusDetail ? (
								<div className="text-[10px] text-trove-fg-4 truncate" title={statusDetail}>{statusDetail}</div>
							) : null}
						</div>
					) : null}
				</div>

				<div className="flex items-center gap-0.5 shrink-0">
					<HeaderIconButton
						title={isFocusMode ? 'Exit focus layout' : 'Focus agent layout'}
						onClick={onToggleFocus}
						active={isFocusMode}
					>
						{isFocusMode ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
					</HeaderIconButton>
					<HeaderIconButton title="New thread" onClick={onNewThread}>
						<Square size={13} />
					</HeaderIconButton>
					{isRunning ? (
						<>
							<HeaderIconButton title="Run in background" onClick={onRunInBackground}>
								<Layers size={13} />
							</HeaderIconButton>
							<HeaderIconButton title="Stop agent" onClick={onStop} danger>
								<StopCircle size={13} />
							</HeaderIconButton>
						</>
					) : null}
				</div>
			</div>
		</div>
	);
};

const HeaderIconButton = ({
	children,
	title,
	onClick,
	active,
	danger,
}: {
	children: React.ReactNode;
	title: string;
	onClick: () => void;
	active?: boolean;
	danger?: boolean;
}) => (
	<button
		type="button"
		title={title}
		aria-label={title}
		onClick={onClick}
		className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
			danger
				? 'text-red-500/90 hover:bg-red-500/10'
				: active
					? 'bg-violet-500/15 text-violet-600 dark:text-violet-300'
					: 'text-trove-fg-4 hover:bg-trove-bg-3/80 hover:text-trove-fg-2'
		}`}
	>
		{children}
	</button>
);
