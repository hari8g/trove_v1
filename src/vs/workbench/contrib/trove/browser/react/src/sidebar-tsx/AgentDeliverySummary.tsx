/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo } from 'react';
import { Check, ExternalLink, FileCode2, Globe, Sparkles } from 'lucide-react';
import { AgentDeliverySummary, AgentDeliveryStatus } from '../../../../common/agentDeliveryTypes.js';
import { useAccessor } from '../util/services.js';
import { IAgentDeliveryService } from '../../../agentDeliveryService.js';
import { TROVE_OPEN_WORKSPACE_PREVIEW_ACTION_ID } from '../../../openWorkspacePreviewAction.js';

type StatusTheme = {
	title: string;
	badge: string;
	icon: typeof Check;
	card: string;
	glowA: string;
	glowB: string;
	accentLine: string;
	iconWrap: string;
	iconColor: string;
	badgeTw: string;
	urlHover: string;
};

const STATUS_THEME: Record<AgentDeliveryStatus, StatusTheme> = {
	verified: {
		title: 'Ready to preview',
		badge: 'Verified',
		icon: Check,
		card: 'border-emerald-500/30 from-emerald-500/[0.1] to-cyan-500/[0.06] shadow-emerald-500/10',
		glowA: 'bg-emerald-400/25',
		glowB: 'bg-cyan-400/15',
		accentLine: 'via-emerald-300/50',
		iconWrap: 'from-emerald-400/30 to-teal-500/10 ring-emerald-400/35 shadow-emerald-500/20',
		iconColor: 'text-emerald-600 dark:text-emerald-400',
		badgeTw: 'from-emerald-500/25 to-teal-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-400/35',
		urlHover: 'hover:border-emerald-400/40 hover:bg-emerald-500/10 hover:shadow-emerald-500/15',
	},
	server_running: {
		title: 'Dev server running',
		badge: 'Live',
		icon: Globe,
		card: 'border-sky-500/30 from-sky-500/[0.1] to-blue-500/[0.06] shadow-sky-500/10',
		glowA: 'bg-sky-400/25',
		glowB: 'bg-blue-500/15',
		accentLine: 'via-sky-300/50',
		iconWrap: 'from-sky-400/30 to-blue-500/10 ring-sky-400/35 shadow-sky-500/20',
		iconColor: 'text-sky-600 dark:text-sky-400',
		badgeTw: 'from-sky-500/25 to-blue-500/15 text-sky-700 dark:text-sky-300 ring-sky-400/35',
		urlHover: 'hover:border-sky-400/40 hover:bg-sky-500/10 hover:shadow-sky-500/15',
	},
	build_succeeded: {
		title: 'Build succeeded',
		badge: 'Built',
		icon: Sparkles,
		card: 'border-amber-500/30 from-amber-500/[0.1] to-orange-500/[0.06] shadow-amber-500/10',
		glowA: 'bg-amber-400/25',
		glowB: 'bg-orange-400/15',
		accentLine: 'via-amber-300/50',
		iconWrap: 'from-amber-400/30 to-orange-500/10 ring-amber-400/35 shadow-amber-500/20',
		iconColor: 'text-amber-600 dark:text-amber-400',
		badgeTw: 'from-amber-500/25 to-orange-500/15 text-amber-800 dark:text-amber-300 ring-amber-400/35',
		urlHover: 'hover:border-amber-400/40 hover:bg-amber-500/10 hover:shadow-amber-500/15',
	},
};

const FileChip = ({ path, index }: { path: string; index: number }) => {
	const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
	const colorTw = index % 3 === 0
		? 'border-sky-400/25 bg-sky-500/10 ring-sky-400/10'
		: index % 3 === 1
			? 'border-violet-400/25 bg-violet-500/10 ring-violet-400/10'
			: 'border-amber-400/25 bg-amber-500/10 ring-amber-400/10';
	return (
		<span
			className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-[11px] text-trove-fg-2 ring-1 ring-inset transition-transform hover:scale-[1.03] ${colorTw}`}
			title={path}
		>
			<FileCode2 size={11} className="shrink-0 opacity-75" aria-hidden="true" />
			<span className="truncate max-w-[130px]">{name}</span>
		</span>
	);
};

const OutputActionButtons = ({
	onApprove,
	onReject,
	approveLabel,
	rejectLabel,
}: {
	onApprove: () => void;
	onReject: () => void;
	approveLabel: string;
	rejectLabel: string;
}) => (
	<div className="flex items-center justify-end gap-2 pt-1">
		<button
			type="button"
			onClick={onReject}
			className="rounded-lg border border-trove-border-3/80 bg-trove-bg-2/60 px-3 py-1.5 text-[11px] font-semibold text-trove-fg-2 shadow-sm transition-all hover:scale-[1.02] hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-300"
		>
			{rejectLabel}
		</button>
		<button
			type="button"
			onClick={onApprove}
			className="rounded-lg border border-emerald-600/50 bg-gradient-to-r from-emerald-600 to-teal-600 px-3.5 py-1.5 text-[11px] font-semibold text-white shadow-md shadow-emerald-600/25 transition-all hover:scale-[1.02] hover:from-emerald-500 hover:to-teal-500 hover:shadow-lg hover:shadow-emerald-500/30"
		>
			{approveLabel}
		</button>
	</div>
);

export const AgentDeliverySummaryCard = ({ delivery, threadId }: { delivery: AgentDeliverySummary; threadId: string }) => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const commandBarService = accessor.get('ITroveCommandBarService');
	const agentDeliveryService = accessor.get('IAgentDeliveryService');

	const pendingDiffCount = delivery.pendingDiffCount ?? 0;
	const showDiffActions = pendingDiffCount > 0;
	const theme = STATUS_THEME[delivery.status];
	const StatusIcon = theme.icon;

	const clearPendingDiffs = useCallback(() => {
		agentDeliveryService.setPendingDiffs(threadId, 0, []);
	}, [agentDeliveryService, threadId]);

	const onApproveAll = useCallback(() => {
		commandBarService.acceptOrRejectAllFiles({ behavior: 'accept' });
		clearPendingDiffs();
	}, [commandBarService, clearPendingDiffs]);

	const onRejectAll = useCallback(() => {
		commandBarService.acceptOrRejectAllFiles({ behavior: 'reject' });
		clearPendingDiffs();
	}, [commandBarService, clearPendingDiffs]);

	const openPreview = useCallback(async () => {
		if (!delivery.previewUrl) return;
		await commandService.executeCommand(TROVE_OPEN_WORKSPACE_PREVIEW_ACTION_ID, delivery.previewUrl);
	}, [commandService, delivery.previewUrl]);

	const displayLine = useMemo(() => {
		if (delivery.previewUrl) return delivery.previewUrl;
		if (delivery.status === 'verified') return 'Preview available in the workspace.';
		if (delivery.status === 'server_running') return delivery.serverLabel ?? 'Dev server is running.';
		return delivery.buildLabel ?? 'Build completed.';
	}, [delivery]);

	const previewHint = delivery.previewOpenedInEditor
		? 'Preview open in editor'
		: delivery.previewUrl
			? 'Click to open preview'
			: undefined;

	if (!delivery.previewUrl && !showDiffActions && !displayLine) {
		return null;
	}

	return (
		<div className={`relative my-2.5 overflow-hidden rounded-2xl border bg-gradient-to-br via-trove-bg-2/90 shadow-xl backdrop-blur-xl ${theme.card}`}>
			<div className={`pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full blur-3xl ${theme.glowA}`} aria-hidden="true" />
			<div className={`pointer-events-none absolute -bottom-12 -left-8 h-28 w-28 rounded-full blur-3xl ${theme.glowB}`} aria-hidden="true" />
			<div className={`pointer-events-none absolute right-1/4 top-0 h-px w-1/2 bg-gradient-to-r from-transparent to-transparent ${theme.accentLine}`} aria-hidden="true" />

			<div className="relative flex items-start justify-between gap-3 border-b border-white/10 dark:border-white/5 px-4 py-3.5">
				<div className="flex items-start gap-3 min-w-0">
					<div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ring-1 shadow-lg ${theme.iconWrap}`} aria-hidden="true">
						<StatusIcon size={17} strokeWidth={delivery.status === 'verified' ? 2.5 : 2} className={theme.iconColor} />
					</div>
					<div className="min-w-0 pt-0.5">
						<p className="text-[14px] font-semibold tracking-tight text-trove-fg-1">{theme.title}</p>
						{previewHint ? (
							<p className="mt-0.5 text-[11px] text-trove-fg-4">{previewHint}</p>
						) : null}
					</div>
				</div>
				<span className={`shrink-0 rounded-full bg-gradient-to-r px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ring-1 ${theme.badgeTw}`}>
					{theme.badge}
				</span>
			</div>

			{delivery.previewUrl ? (
				<button
					type="button"
					className={`group relative mx-3 mb-3 mt-2 flex w-[calc(100%-1.5rem)] items-center justify-between gap-3 rounded-xl border border-trove-border-3/50 bg-trove-bg-1/50 px-3 py-2.5 text-left shadow-sm transition-all hover:scale-[1.01] hover:shadow-md ${theme.urlHover}`}
					onClick={() => void openPreview()}
					title="Open preview in editor"
				>
					<span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-trove-link-color">
						{delivery.previewUrl}
					</span>
					<span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-trove-bg-3/60 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-trove-fg-4 transition-colors group-hover:text-trove-link-color">
						<ExternalLink size={11} />
						Open
					</span>
				</button>
			) : displayLine ? (
				<p className="mx-3 mb-3 mt-2 rounded-xl border border-trove-border-3/40 bg-trove-bg-1/40 px-3 py-2.5 text-[12px] text-trove-fg-2">
					{displayLine}
				</p>
			) : null}

			{showDiffActions ? (
				<div className="relative border-t border-white/10 dark:border-white/5 bg-gradient-to-b from-violet-500/[0.04] to-transparent px-4 py-3.5">
					<div className="mb-2.5 flex items-center gap-2">
						<span className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/25 to-fuchsia-500/10 px-1.5 text-[11px] font-bold text-violet-800 dark:text-violet-200 ring-1 ring-violet-400/25">
							{pendingDiffCount}
						</span>
						<span className="text-[12px] font-semibold text-trove-fg-2">
							pending change{pendingDiffCount === 1 ? '' : 's'}
						</span>
					</div>

					{delivery.filesChanged?.length ? (
						<div className="mb-3 flex flex-wrap gap-1.5">
							{delivery.filesChanged.slice(0, 5).map((file, i) => (
								<FileChip key={file} path={file} index={i} />
							))}
							{delivery.filesChanged.length > 5 ? (
								<span className="self-center px-1 text-[10px] font-semibold text-trove-fg-4">
									+{delivery.filesChanged.length - 5} more
								</span>
							) : null}
						</div>
					) : null}

					<OutputActionButtons
						onApprove={onApproveAll}
						onReject={onRejectAll}
						approveLabel={pendingDiffCount === 1 ? 'Approve' : `Approve all ${pendingDiffCount}`}
						rejectLabel="Reject"
					/>
				</div>
			) : null}
		</div>
	);
};
