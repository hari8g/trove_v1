/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { useAccessor } from '../util/services.js';
import type { MeteringSession } from '../../../../common/usageMeteringTypes.js';
import { PRICING_TABLE_DATE } from '../../../../common/llmPricing.js';

const fmt = (usd: number): string => {
	if (usd === 0) return '$0.00';
	if (usd < 0.0001) return '< $0.0001';
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
};

const fmtTokens = (n: number): string =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
		: n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
			: String(n);

const dayLabel = (isoDate: string): string => {
	const d = new Date(isoDate);
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div style={{
			flex: 1,
			padding: '8px 10px',
			background: 'var(--vscode-editor-background)',
			border: '1px solid var(--vscode-editorGroup-border)',
			borderRadius: 4,
		}}>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 2 }}>{label}</div>
			<div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--vscode-foreground)' }}>{value}</div>
			{sub && <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', opacity: 0.7 }}>{sub}</div>}
		</div>
	);
}

function actionBtn(variant: 'primary' | 'secondary' | 'danger'): React.CSSProperties {
	const base: React.CSSProperties = { fontSize: 11, padding: '4px 10px', cursor: 'pointer', borderRadius: 3, border: 'none' };
	if (variant === 'primary') return { ...base, background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' };
	if (variant === 'secondary') return { ...base, background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)' };
	return { ...base, background: 'transparent', color: 'var(--vscode-errorForeground)', border: '1px solid var(--vscode-errorForeground)' };
}

export function UsageDashboard() {
	const accessor = useAccessor();
	const meteringService = accessor.get('IUsageMeteringService');

	const [session, setSession] = useState<MeteringSession>(meteringService.getSession());
	const [budgetUSD, setBudgetUSD] = useState<number | null>(meteringService.getBudgetLimitUSD());
	const [budgetInput, setBudgetInput] = useState<string>(
		meteringService.getBudgetLimitUSD()?.toString() ?? '',
	);

	useEffect(() => {
		const sub = meteringService.onDidUpdate(s => {
			setSession(s);
			setBudgetUSD(meteringService.getBudgetLimitUSD());
		});
		return () => sub.dispose();
	}, [meteringService]);

	const today = new Date().toISOString().slice(0, 10);
	const todayUSD = session.dailyUSD[today] ?? 0;

	const last7 = Object.entries(session.dailyUSD)
		.sort(([a], [b]) => a.localeCompare(b))
		.slice(-7);

	const maxDayUSD = Math.max(...last7.map(([, v]) => v), 0.001);

	const providerRows = Object.entries(session.byProvider)
		.sort(([, a], [, b]) => b.costUSD - a.costUSD);

	const budgetPct = budgetUSD && budgetUSD > 0
		? Math.min(100, (session.totalCostUSD / budgetUSD) * 100)
		: null;

	const pricingAgeMs = Date.now() - new Date(PRICING_TABLE_DATE).getTime();
	const pricingIsOld = pricingAgeMs > 60 * 24 * 60 * 60 * 1_000;

	const handleSetBudget = useCallback(() => {
		const val = budgetInput.trim() === '' ? null : parseFloat(budgetInput);
		meteringService.setBudgetLimitUSD(val && isFinite(val) ? val : null);
	}, [budgetInput, meteringService]);

	const handleReset = useCallback(() => {
		if (window.confirm('Reset all accumulated usage data? This cannot be undone.')) {
			meteringService.resetSession();
		}
	}, [meteringService]);

	return (
		<div style={{ padding: '0 16px 24px', maxWidth: 480 }}>
			<h3 style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 12px', color: 'var(--vscode-foreground)' }}>
				LLM Usage & Cost
			</h3>

			{pricingIsOld && (
				<div style={{ fontSize: 11, color: 'var(--vscode-editorWarning-foreground)', marginBottom: 10 }}>
					Pricing table was last updated {PRICING_TABLE_DATE}. Costs may be inaccurate.
				</div>
			)}

			<div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
				<StatCard label="Session total" value={fmt(session.totalCostUSD)} sub={`${session.totalTurns} turns`} />
				<StatCard label="Today" value={fmt(todayUSD)} />
				<StatCard
					label="Cache ratio"
					value={session.totalInputTokens > 0
						? `${((session.totalCacheReadTokens / session.totalInputTokens) * 100).toFixed(0)}%`
						: '—'}
					sub="of input tokens"
				/>
			</div>

			<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginBottom: 14 }}>
				{fmtTokens(session.totalInputTokens)} in ·{' '}
				{fmtTokens(session.totalOutputTokens)} out ·{' '}
				{fmtTokens(session.totalCacheReadTokens)} cache-read
			</div>

			{budgetPct !== null && (
				<div style={{ marginBottom: 16 }}>
					<div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
						<span style={{ color: 'var(--vscode-descriptionForeground)' }}>
							Budget: {fmt(session.totalCostUSD)} of {fmt(budgetUSD!)}
						</span>
						<span style={{ color: budgetPct > 90 ? 'var(--vscode-errorForeground)' : 'var(--vscode-descriptionForeground)' }}>
							{budgetPct.toFixed(1)}%
						</span>
					</div>
					<div style={{ height: 4, background: 'var(--vscode-progressBar-background)', borderRadius: 2, overflow: 'hidden' }}>
						<div style={{
							height: '100%',
							width: `${budgetPct}%`,
							background: budgetPct > 90
								? 'var(--vscode-errorForeground)'
								: budgetPct > 75
									? 'var(--vscode-editorWarning-foreground)'
									: 'var(--vscode-button-background)',
							transition: 'width 0.3s ease, background 0.3s ease',
						}} />
					</div>
				</div>
			)}

			{last7.length > 0 && (
				<div style={{ marginBottom: 16 }}>
					<div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--vscode-descriptionForeground)' }}>
						LAST 7 DAYS
					</div>
					<div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 48 }}>
						{last7.map(([day, cost]) => (
							<div key={day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
								<div
									title={`${dayLabel(day)}: ${fmt(cost)}`}
									style={{
										width: '100%',
										height: `${Math.max(2, (cost / maxDayUSD) * 40)}px`,
										background: day === today
											? 'var(--vscode-button-background)'
											: 'var(--vscode-button-secondaryBackground)',
										borderRadius: 2,
									}}
								/>
								<span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)', opacity: 0.7 }}>
									{dayLabel(day).split(' ')[1]}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{providerRows.length > 0 && (
				<div style={{ marginBottom: 16 }}>
					<div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--vscode-descriptionForeground)' }}>
						BY PROVIDER
					</div>
					{providerRows.map(([provider, data]) => (
						<div key={provider} style={{
							display: 'flex',
							justifyContent: 'space-between',
							fontSize: 12,
							padding: '4px 0',
							borderBottom: '1px solid var(--vscode-editorGroup-border)',
						}}>
							<span style={{ color: 'var(--vscode-foreground)' }}>{provider}</span>
							<span style={{ color: 'var(--vscode-descriptionForeground)' }}>
								{fmt(data.costUSD)} · {data.turns} turn{data.turns !== 1 ? 's' : ''}
							</span>
						</div>
					))}
				</div>
			)}

			<div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--vscode-descriptionForeground)' }}>
				SESSION BUDGET (USD)
			</div>
			<div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
				<input
					type="number"
					min="0"
					step="1"
					placeholder="No limit"
					value={budgetInput}
					onChange={e => setBudgetInput(e.target.value)}
					style={{
						flex: 1,
						background: 'var(--vscode-input-background)',
						color: 'var(--vscode-input-foreground)',
						border: '1px solid var(--vscode-input-border)',
						borderRadius: 3,
						padding: '4px 8px',
						fontSize: 12,
					}}
				/>
				<button type="button" onClick={handleSetBudget} style={actionBtn('primary')}>Set</button>
				{budgetUSD !== null && (
					<button
						type="button"
						onClick={() => { setBudgetInput(''); meteringService.setBudgetLimitUSD(null); }}
						style={actionBtn('secondary')}
					>
						Clear
					</button>
				)}
			</div>

			{budgetUSD !== null && (
				<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginBottom: 12 }}>
					Agent turns will be blocked when session cost reaches {fmt(budgetUSD)}.
				</div>
			)}

			<button type="button" onClick={handleReset} style={{ ...actionBtn('danger'), marginTop: 8 }}>
				Reset all usage data
			</button>

			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', opacity: 0.6, marginTop: 12 }}>
				Costs are estimates based on Trove&apos;s built-in pricing table and may differ
				from your actual provider invoice. Self-hosted models (Ollama, vLLM, LM Studio)
				show $0.00 as there is no per-token cost.
			</div>
		</div>
	);
}
