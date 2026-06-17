/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback } from 'react';
import { Check, ExternalLink, Globe } from 'lucide-react';
import { AgentDeliverySummary } from '../../../../common/agentDeliveryTypes.js';
import { useAccessor } from '../util/services.js';
import { IAgentDeliveryService } from '../../../agentDeliveryService.js';
import { TROVE_OPEN_WORKSPACE_PREVIEW_ACTION_ID } from '../../../openWorkspacePreviewAction.js';

const StatusDot = ({ status }: { status: AgentDeliverySummary['status'] }) => {
	const color = status === 'verified'
		? 'bg-[var(--vscode-testing-iconPassed,#3fb950)]'
		: status === 'server_running'
			? 'bg-[var(--vscode-charts-blue,#3794ff)]'
			: 'bg-[var(--vscode-charts-yellow,#d29922)]';

	return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color} shadow-[0_0_8px_currentColor] opacity-90`} aria-hidden="true" />;
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
	<div className="flex items-center gap-2 shrink-0">
		<button
			type="button"
			onClick={onReject}
			className="trove-output-btn trove-output-btn-reject"
		>
			{rejectLabel}
		</button>
		<button
			type="button"
			onClick={onApprove}
			className="trove-output-btn trove-output-btn-approve"
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

	const displayLine = delivery.previewUrl
		? delivery.previewUrl
		: delivery.status === 'verified'
			? 'Ready — preview available in the workspace.'
			: delivery.status === 'server_running'
				? delivery.serverLabel ?? 'Dev server is running.'
				: delivery.buildLabel ?? 'Build completed.';

	const showVerifiedBadge = delivery.status === 'verified';

	if (!delivery.previewUrl && !showDiffActions && !displayLine) {
		return null;
	}

	return (
		<div className="glass-card trove-output-panel my-3">
			<div className="trove-output-display">
				<div className="flex items-start gap-3 min-w-0">
					<div className="trove-output-icon-wrap shrink-0" aria-hidden="true">
						{showVerifiedBadge ? (
							<Check size={15} strokeWidth={2.5} className="text-[var(--vscode-testing-iconPassed,#3fb950)]" />
						) : (
							<Globe size={15} strokeWidth={2} className="text-trove-fg-3" />
						)}
					</div>
					<div className="min-w-0 flex-1 space-y-2">
						{delivery.previewUrl ? (
							<button
								type="button"
								className="trove-output-display-link group w-full text-left"
								onClick={() => void openPreview()}
								title="Open preview in editor"
							>
								<span className="block truncate">{delivery.previewUrl}</span>
								<span className="trove-output-display-hint mt-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
									<ExternalLink size={11} />
									Open in editor
								</span>
							</button>
						) : (
							<p className="trove-output-display-text">{displayLine}</p>
						)}
						{delivery.previewUrl ? (
							<div className="flex items-center gap-2 text-[11px] text-trove-fg-4">
								<StatusDot status={delivery.status} />
								<span className="truncate">
									{delivery.previewOpenedInEditor ? 'Preview open in editor' : 'Click to open preview'}
								</span>
							</div>
						) : null}
					</div>
				</div>
			</div>

			{showDiffActions ? (
				<div className="trove-output-actions">
					<div className="min-w-0">
						<p className="trove-output-display-text text-[13px] leading-snug">
							{pendingDiffCount} pending change{pendingDiffCount === 1 ? '' : 's'}
						</p>
						{delivery.filesChanged?.length ? (
							<p className="trove-output-meta mt-0.5 truncate">
								{delivery.filesChanged.slice(0, 3).map(f => f.split('/').pop()).join(', ')}
								{delivery.filesChanged.length > 3 ? ` +${delivery.filesChanged.length - 3} more` : ''}
							</p>
						) : null}
					</div>
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
