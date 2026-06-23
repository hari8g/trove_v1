/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UCGGraphData, UCGGraphMetrics, UCGImportEdge } from '../../../../common/repoIntelligenceTypes.js';
import { useAccessor } from '../util/services.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import {
	ForceGraph,
	buildFileGraphLinks,
	buildFileGraphNodes,
	buildPackageGraph,
	LAYER_COLORS,
} from './ForceGraph.js';

type ViewMode = 'file' | 'package';

const ALL_LAYERS = Object.keys(LAYER_COLORS);

export function UniversalContextGraphPanel() {
	const accessor = useAccessor();
	const repoIntel = accessor.get('IRepoIntelligenceService');
	const workspaceService = accessor.get('IWorkspaceContextService');

	const containerRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 800, height: 500 });
	const [graph, setGraph] = useState<UCGGraphData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<ViewMode>('file');
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [depth, setDepth] = useState(0);
	const [enabledLayers, setEnabledLayers] = useState<Set<string>>(() => new Set(ALL_LAYERS));
	const [enabledLanguages, setEnabledLanguages] = useState<Set<string>>(() => new Set());

	const workspaceRoot = workspaceService.getWorkspace().folders[0]?.uri.fsPath ?? null;

	const [refreshing, setRefreshing] = useState(false);

	const loadGraph = useCallback(async (forceReindex = false) => {
		if (!workspaceRoot) {
			setGraph(null);
			setLoading(false);
			setError('No workspace folder open.');
			return;
		}
		setLoading(true);
		setError(null);
		try {
			if (forceReindex) {
				setRefreshing(true);
				await repoIntel.refreshProfile(workspaceRoot);
			} else {
				await repoIntel.ensureInitialized();
			}
			const data = await repoIntel.getUCGGraph(workspaceRoot);
			setGraph(data);
			if (data) {
				setEnabledLanguages(new Set(data.nodes.map(n => n.language)));
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, [repoIntel, workspaceRoot]);

	useEffect(() => {
		void loadGraph();
		const sub = repoIntel.onDidChangeUCG(() => { void loadGraph(); });
		return () => sub.dispose();
	}, [loadGraph, repoIntel]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const ro = new ResizeObserver(entries => {
			const entry = entries[0];
			if (entry) {
				setSize({ width: entry.contentRect.width, height: Math.max(400, entry.contentRect.height - 120) });
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const cycleFiles = useMemo(() => {
		const set = new Set<string>();
		for (const cycle of graph?.metrics?.cycles ?? []) {
			for (const f of cycle) {
				set.add(f);
			}
		}
		return set;
	}, [graph]);

	const filteredFileNodes = useMemo(() => {
		if (!graph) {
			return [];
		}
		return graph.nodes.filter(n =>
			enabledLayers.has(n.archLayer) &&
			(enabledLanguages.size === 0 || enabledLanguages.has(n.language)),
		);
	}, [graph, enabledLayers, enabledLanguages]);

	const filteredEdges = useMemo(() => {
		if (!graph) {
			return [];
		}
		const nodeSet = new Set(filteredFileNodes.map(n => n.filePath));
		return graph.edges.filter(e =>
			nodeSet.has(e.fromFile) &&
			(!e.resolvedFile || nodeSet.has(e.resolvedFile)),
		);
	}, [graph, filteredFileNodes]);

	const { graphNodes, graphLinks } = useMemo(() => {
		if (viewMode === 'package') {
			const pkg = buildPackageGraph(filteredFileNodes, filteredEdges, cycleFiles);
			return { graphNodes: pkg.nodes, graphLinks: pkg.links };
		}
		return {
			graphNodes: buildFileGraphNodes(filteredFileNodes, cycleFiles),
			graphLinks: buildFileGraphLinks(filteredEdges),
		};
	}, [viewMode, filteredFileNodes, filteredEdges, cycleFiles]);

	const selectedNode = graphNodes.find(n => n.id === selectedId);
	const selectedMeta = selectedNode?.meta;

	const incoming = useMemo(() => {
		if (!graph || !selectedId || viewMode !== 'file') {
			return [] as UCGImportEdge[];
		}
		return graph.edges.filter(e => e.resolvedFile === selectedId);
	}, [graph, selectedId, viewMode]);

	const outgoing = useMemo(() => {
		if (!graph || !selectedId || viewMode !== 'file') {
			return [] as UCGImportEdge[];
		}
		return graph.edges.filter(e => e.fromFile === selectedId);
	}, [graph, selectedId, viewMode]);

	const toggleLayer = (layer: string) => {
		setEnabledLayers(prev => {
			const next = new Set(prev);
			if (next.has(layer)) {
				next.delete(layer);
			} else {
				next.add(layer);
			}
			return next;
		});
	};

	const toggleLanguage = (lang: string) => {
		setEnabledLanguages(prev => {
			const next = new Set(prev);
			if (next.has(lang)) {
				next.delete(lang);
			} else {
				next.add(lang);
			}
			return next;
		});
	};

	const metrics: UCGGraphMetrics | null = graph?.metrics ?? null;

	return (
		<div ref={containerRef} style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
			<div style={{
				padding: '10px 14px',
				borderBottom: '1px solid var(--vscode-editorGroup-border)',
				display: 'flex',
				flexWrap: 'wrap',
				gap: 8,
				alignItems: 'center',
			}}>
				<span style={{ fontWeight: 600, fontSize: 13 }}>Universal Context Graph</span>
				<button onClick={() => void loadGraph(false)} style={btnStyle()} disabled={loading || refreshing}>
					{loading ? (refreshing ? 'Re-indexing…' : 'Loading…') : 'Refresh'}
				</button>
				<button onClick={() => void loadGraph(true)} style={btnStyle()} disabled={loading || refreshing} title="Full repository re-scan including import graph">
					Re-index
				</button>
				<select value={viewMode} onChange={e => setViewMode(e.target.value as ViewMode)} style={selectStyle()}>
					<option value="file">File view</option>
					<option value="package">Package view</option>
				</select>
				<label style={labelStyle()}>
					Depth
					<input type="range" min={0} max={5} value={depth} onChange={e => setDepth(Number(e.target.value))} />
					{depth === 0 ? 'All' : depth}
				</label>
				{metrics && (
					<span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>
						{metrics.totalNodes} files · {metrics.totalEdges} edges · {metrics.entryCount} entry · {metrics.cycleCount} cycles
					</span>
				)}
			</div>

			<div style={{ padding: '6px 14px', display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: '1px solid var(--vscode-editorGroup-border)' }}>
				{ALL_LAYERS.map(layer => (
					<button
						key={layer}
						onClick={() => toggleLayer(layer)}
						style={{
							...chipStyle(),
							opacity: enabledLayers.has(layer) ? 1 : 0.4,
							borderColor: LAYER_COLORS[layer],
						}}
					>
						{layer}
					</button>
				))}
			</div>

			{graph && (
				<div style={{ padding: '4px 14px', display: 'flex', flexWrap: 'wrap', gap: 4, borderBottom: '1px solid var(--vscode-editorGroup-border)' }}>
					{[...new Set(graph.nodes.map(n => n.language))].sort().map(lang => (
						<button
							key={lang}
							onClick={() => toggleLanguage(lang)}
							style={{ ...chipStyle(), opacity: enabledLanguages.has(lang) ? 1 : 0.4 }}
						>
							{lang}
						</button>
					))}
				</div>
			)}

			<div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
				<div style={{ flex: 1, overflow: 'hidden' }}>
					{error && <div style={{ padding: 16, color: 'var(--vscode-errorForeground)' }}>{error}</div>}
					{!error && !loading && graphNodes.length === 0 && (
						<div style={{ padding: 16, color: 'var(--vscode-descriptionForeground)' }}>
							No import graph data yet. Opening this panel builds the graph from the repo index automatically;
							if it stays empty, run <strong>Trove: Refresh Repository Index</strong> (not Analyse Repository — that writes a context doc only).
						</div>
					)}
					{graphNodes.length > 0 && (
						<ForceGraph
							nodes={graphNodes}
							links={graphLinks}
							width={size.width - (selectedMeta ? 260 : 0)}
							height={size.height}
							selectedId={selectedId}
							onSelect={setSelectedId}
						/>
					)}
				</div>

				{selectedMeta && (
					<div style={{
						width: 260,
						borderLeft: '1px solid var(--vscode-editorGroup-border)',
						padding: 12,
						overflow: 'auto',
						fontSize: 11,
					}}>
						<div style={{ fontWeight: 600, marginBottom: 8, wordBreak: 'break-all' }}>{selectedMeta.filePath}</div>
						<div>Layer: <strong>{selectedMeta.archLayer}</strong></div>
						<div>Type: <strong>{selectedMeta.nodeType}</strong></div>
						<div>Language: {selectedMeta.language}</div>
						<div>Imports: {selectedMeta.importCount} · Imported by: {selectedMeta.importedByCount}</div>
						{selectedMeta.isEntryPoint && <div style={{ color: '#ff6b6b', marginTop: 4 }}>Entry point</div>}
						{incoming.length > 0 && (
							<>
								<div style={{ marginTop: 10, fontWeight: 600 }}>Imported by ({incoming.length})</div>
								{incoming.slice(0, 8).map(e => (
									<div key={`in-${e.fromFile}-${e.toModule}`} style={{ opacity: 0.85 }}>{e.fromFile.split('/').pop()}</div>
								))}
							</>
						)}
						{outgoing.length > 0 && (
							<>
								<div style={{ marginTop: 10, fontWeight: 600 }}>Imports ({outgoing.length})</div>
								{outgoing.slice(0, 8).map(e => (
									<div key={`out-${e.toModule}`} style={{ opacity: 0.85 }}>
										{e.isExternal ? `⬡ ${e.toModule}` : e.resolvedFile?.split('/').pop() ?? e.toModule}
									</div>
								))}
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function btnStyle(): React.CSSProperties {
	return {
		padding: '4px 10px',
		fontSize: 11,
		cursor: 'pointer',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		border: '1px solid var(--vscode-button-border)',
		borderRadius: 4,
	};
}

function selectStyle(): React.CSSProperties {
	return {
		fontSize: 11,
		padding: '3px 6px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)',
		borderRadius: 4,
	};
}

function chipStyle(): React.CSSProperties {
	return {
		fontSize: 10,
		padding: '2px 8px',
		borderRadius: 10,
		border: '1px solid var(--vscode-editorWidget-border)',
		background: 'var(--vscode-editorWidget-background)',
		cursor: 'pointer',
	};
}

function labelStyle(): React.CSSProperties {
	return {
		fontSize: 11,
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		color: 'var(--vscode-descriptionForeground)',
	};
}

export default function UniversalContextGraphPanelRoot() {
	return (
		<ErrorBoundary>
			<UniversalContextGraphPanel />
		</ErrorBoundary>
	);
}
