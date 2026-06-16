/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { PlanMessage } from '../../../../common/chatThreadServiceTypes.js';

const StatusIcon = ({ status }: { status: PlanMessage['items'][number]['status'] }) => {
	if (status === 'done') {
		return (
			<span className="text-[var(--vscode-testing-iconPassed,#3fb950)] shrink-0" aria-hidden="true">
				<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
					<path d="M6.5 11.2 3.3 8l1-1 2.2 2.2L11.7 4l1 1z" />
				</svg>
			</span>
		);
	}
	if (status === 'skipped') {
		return <span className="text-trove-fg-4 shrink-0 text-xs" aria-hidden="true">—</span>;
	}
	return (
		<span className="text-trove-fg-4 shrink-0" aria-hidden="true">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="opacity-60">
				<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
			</svg>
		</span>
	);
};

export const PlanView = ({ plan, isCheckpointGhost }: { plan: PlanMessage; isCheckpointGhost?: boolean }) => {
	return (
		<div className={`my-2 px-2 ${isCheckpointGhost ? 'opacity-50' : ''}`}>
			<div className="rounded-lg border border-trove-border-2 bg-trove-bg-1 px-3 py-2">
				<div className="text-xs font-medium text-trove-fg-3 uppercase tracking-wide mb-2">Plan</div>
				<ul className="space-y-1.5 list-none m-0 p-0">
					{plan.items.map((item, idx) => (
						<li key={idx} className="flex items-start gap-2 text-sm text-trove-fg-2">
							<StatusIcon status={item.status} />
							<span className={item.status === 'done' ? 'text-trove-fg-3 line-through' : item.status === 'skipped' ? 'text-trove-fg-4 line-through' : ''}>
								{item.text}
							</span>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
};
