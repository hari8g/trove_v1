/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback } from 'react';
import { AgentDeliverySummary } from '../../../../common/agentDeliveryTypes.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { useAccessor } from '../util/services.js';
import { IAgentDeliveryService } from '../../../agentDeliveryService.js';

const StatusIcon = ({ status }: { status: AgentDeliverySummary['status'] }) => {
	const color = status === 'verified'
		? 'text-[var(--vscode-testing-iconPassed,#3fb950)]'
		: status === 'server_running'
			? 'text-[var(--vscode-charts-blue,#3794ff)]'
			: 'text-[var(--vscode-charts-yellow,#d29922)]';

	return (
		<div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-trove-bg-1 ${color}`}>
			{status === 'verified' ? (
				<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path d="M6.5 11.2 3.3 8l1-1 2.2 2.2L11.7 4l1 1z" />
				</svg>
			) : status === 'server_running' ? (
				<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v7A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5zM3.5 4a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5z" />
					<path d="M4 6.5h8v1H4zM4 8.5h5v1H4z" />
				</svg>
			) : (
				<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11M4 8a4 4 0 1 1 8 0 4 4 0 0 1-8 0m4-2.5a.5.5 0 0 0-.5.5v2.25H6.25a.5.5 0 0 0 0 1H7.5V9.5a.5.5 0 0 0 1 0V8.25h1.25a.5.5 0 0 0 0-1H8.5V6a.5.5 0 0 0-.5-.5" />
				</svg>
			)}
		</div>
	);
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
	<div className="trove-delivery-section">
		<div className="trove-delivery-section-title">{title}</div>
		<div className="trove-delivery-section-body">{children}</div>
	</div>
);

const CommandPill = ({ command }: { command: string }) => (
	<code className="trove-delivery-command">{command}</code>
);

export const AgentDeliverySummaryCard = ({ delivery, threadId }: { delivery: AgentDeliverySummary; threadId: string }) => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const commandBarService = accessor.get('ITroveCommandBarService');
	const agentDeliveryService = accessor.get('IAgentDeliveryService');

	const pendingDiffCount = delivery.pendingDiffCount ?? 0;
	const showDiffActions = pendingDiffCount > 1;
	const hasDeliveryInfo = delivery.status === 'verified'
		|| delivery.status === 'server_running'
		|| !!delivery.buildLabel
		|| !!delivery.serverLabel
		|| !!delivery.previewUrl;

	const clearPendingDiffs = useCallback(() => {
		agentDeliveryService.setPendingDiffs(threadId, 0, []);
	}, [agentDeliveryService, threadId]);

	const onAcceptAll = useCallback(() => {
		commandBarService.acceptOrRejectAllFiles({ behavior: 'accept' });
		clearPendingDiffs();
	}, [commandBarService, clearPendingDiffs]);

	const onRejectAll = useCallback(() => {
		commandBarService.acceptOrRejectAllFiles({ behavior: 'reject' });
		clearPendingDiffs();
	}, [commandBarService, clearPendingDiffs]);

	const openPreview = useCallback(async () => {
		if (!delivery.previewUrl) return;
		try {
			await commandService.executeCommand('simpleBrowser.api.open', URI.parse(delivery.previewUrl), {
				viewColumn: -1,
				preserveFocus: false,
			});
		} catch {
			await commandService.executeCommand('simpleBrowser.show', delivery.previewUrl);
		}
	}, [commandService, delivery.previewUrl]);

	const headline = !hasDeliveryInfo && showDiffActions
		? `${pendingDiffCount} files changed`
		: delivery.status === 'verified'
		? 'Verified and ready'
		: delivery.status === 'server_running'
			? 'Dev server is running'
			: 'Build completed successfully';

	const subhead = !hasDeliveryInfo && showDiffActions
		? 'Review pending edits across your workspace.'
		: delivery.status === 'verified'
		? delivery.previewOpenedInEditor
			? 'Install, build, and server checks passed. Preview is open — use the app in the editor.'
			: 'All background setup completed. Open the preview below.'
		: delivery.status === 'server_running'
			? 'Dev server is running in the Trove Agent terminal (background). Open the preview — no need to run start in your terminal.'
			: delivery.serverLabel
				? 'Dependencies and build finished in the sandbox. The agent should start the dev server next — you should only need to preview the app.'
				: 'Sandbox setup step completed on disk (shared with your workspace).';

	return (
		<div className="trove-delivery-summary my-3">
			<div className="trove-delivery-summary-header">
				<StatusIcon status={delivery.status} />
				<div className="min-w-0 flex-1">
					<div className="trove-delivery-summary-title">{headline}</div>
					<div className="trove-delivery-summary-subtitle">{subhead}</div>
				</div>
			</div>

			<div className="trove-delivery-summary-grid">
				{delivery.buildLabel && (
					<Section title={/\b(install|ci|add)\b/i.test(delivery.buildLabel) ? 'Dependencies' : 'Build'}>
						<CommandPill command={delivery.buildLabel} />
						<p className="trove-delivery-hint mt-1.5">
							{/\b(install|ci|add)\b/i.test(delivery.buildLabel)
								? 'Installed to your project folder on disk — your terminal will see the same node_modules.'
								: 'Completed in the chat sandbox — no manual rebuild needed.'}
						</p>
					</Section>
				)}

				{delivery.serverLabel && delivery.status !== 'verified' && (
					<Section title="Dev server">
						<CommandPill command={delivery.serverLabel} />
						<p className="trove-delivery-hint mt-1.5">
							{delivery.status === 'server_running'
								? 'Already running in the Trove Agent background terminal.'
								: 'Agent should run this automatically in the background — you should not need to type it in your terminal.'}
						</p>
					</Section>
				)}

				{delivery.status === 'build_succeeded' && !delivery.serverLabel && hasDeliveryInfo && (
					<Section title="Next step">
						<p className="trove-delivery-hint">Agent should start the dev server and verify with curl before finishing.</p>
					</Section>
				)}

				{delivery.previewUrl && (
					<Section title="Preview">
						<div className="flex flex-wrap items-center gap-2">
							<a
								className="trove-delivery-link truncate"
								href={delivery.previewUrl}
								onClick={(e) => { e.preventDefault(); void openPreview(); }}
							>
								{delivery.previewUrl}
							</a>
							<button
								type="button"
								className="trove-delivery-action"
								onClick={() => void openPreview()}
							>
								Open in editor
							</button>
						</div>
					</Section>
				)}

				{showDiffActions ? (
					<Section title="Pending edits">
						<div className="flex flex-wrap gap-2">
							<button type="button" className="trove-delivery-action" onClick={onAcceptAll}>
								Accept all {pendingDiffCount} changes
							</button>
							<button type="button" className="trove-delivery-action trove-delivery-action-secondary" onClick={onRejectAll}>
								Reject all
							</button>
						</div>
					</Section>
				) : null}
			</div>
		</div>
	);
};
