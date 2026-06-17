/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { Check, Circle, Minus } from 'lucide-react';
import { PlanMessage } from '../../../../common/chatThreadServiceTypes.js';

const StatusIcon = ({ status }: { status: PlanMessage['items'][number]['status'] }) => {
	if (status === 'done') {
		return (
			<span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500/25 to-teal-500/10 ring-1 ring-emerald-400/30" aria-hidden="true">
				<Check size={9} strokeWidth={3} className="text-emerald-600 dark:text-emerald-400" />
			</span>
		);
	}
	if (status === 'skipped') {
		return (
			<span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-trove-bg-3/50 ring-1 ring-trove-border-3/50" aria-hidden="true">
				<Minus size={8} className="text-trove-fg-4" />
			</span>
		);
	}
	return (
		<span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-trove-bg-3/30 ring-1 ring-trove-border-3/40" aria-hidden="true">
			<Circle size={6} className="fill-violet-400/50 text-violet-400/80 animate-pulse" />
		</span>
	);
};

const itemRowClass = (status: PlanMessage['items'][number]['status']): string => {
	if (status === 'done') {
		return 'bg-emerald-500/[0.04]';
	}
	if (status === 'skipped') {
		return 'opacity-55';
	}
	return '';
};

const itemTextClass = (status: PlanMessage['items'][number]['status']): string => {
	if (status === 'done') {
		return 'text-trove-fg-3 line-through decoration-emerald-500/40';
	}
	if (status === 'skipped') {
		return 'text-trove-fg-4 line-through';
	}
	return 'text-trove-fg-1 font-medium';
};

export const PlanView = ({ plan, isCheckpointGhost }: { plan: PlanMessage; isCheckpointGhost?: boolean }) => {
	const doneCount = plan.items.filter(i => i.status === 'done').length;
	const totalCount = plan.items.length;

	return (
		<div className={`my-2.5 px-1 ${isCheckpointGhost ? 'opacity-50' : ''}`}>
			<div className="relative overflow-hidden rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.07] via-trove-bg-2/90 to-indigo-500/[0.05] shadow-lg shadow-violet-500/5 backdrop-blur-xl">
				<div className="pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full bg-violet-400/15 blur-2xl" aria-hidden="true" />
				<div className="pointer-events-none absolute -bottom-8 -left-6 h-20 w-20 rounded-full bg-indigo-400/10 blur-2xl" aria-hidden="true" />

				<div className="relative flex items-center justify-between gap-2 border-b border-white/10 dark:border-white/5 px-3 py-2">
					<span className="text-[10px] font-bold uppercase tracking-[0.14em] text-violet-600 dark:text-violet-300">
						Plan
					</span>
					<span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-violet-700 dark:text-violet-300 ring-1 ring-violet-400/25">
						{doneCount}/{totalCount}
					</span>
				</div>

				<ul className="relative flex flex-col divide-y divide-violet-400/10 px-2.5 py-0.5 list-none m-0">
					{plan.items.map((item, idx) => (
						<li
							key={idx}
							className={`flex items-start gap-2 py-1 text-[11px] leading-[1.35] transition-colors ${itemRowClass(item.status)}`}
						>
							<StatusIcon status={item.status} />
							<span className={`min-w-0 ${itemTextClass(item.status)}`}>
								{item.text}
							</span>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
};
