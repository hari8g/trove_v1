/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { UCGFileNode, UCGImportEdge } from '../../../../common/repoIntelligenceTypes.js';

export type ForceGraphNode = {
	id: string;
	label: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	radius: number;
	color: string;
	isEntryPoint: boolean;
	inCycle: boolean;
	meta?: UCGFileNode;
};

export type ForceGraphLink = {
	source: string;
	target: string;
	external?: boolean;
};

type Props = {
	nodes: ForceGraphNode[];
	links: ForceGraphLink[];
	width: number;
	height: number;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
};

const simulate = (
	nodes: ForceGraphNode[],
	links: ForceGraphLink[],
	width: number,
	height: number,
	iterations = 80,
) => {
	const nodeMap = new Map(nodes.map(n => [n.id, n]));
	const cx = width / 2;
	const cy = height / 2;

	for (let iter = 0; iter < iterations; iter++) {
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i];
				const b = nodes[j];
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				let dist = Math.sqrt(dx * dx + dy * dy) || 1;
				const force = 1200 / (dist * dist);
				dx = (dx / dist) * force;
				dy = (dy / dist) * force;
				a.vx += dx;
				a.vy += dy;
				b.vx -= dx;
				b.vy -= dy;
			}
		}

		for (const link of links) {
			const source = nodeMap.get(link.source);
			const target = nodeMap.get(link.target);
			if (!source || !target) {
				continue;
			}
			let dx = target.x - source.x;
			let dy = target.y - source.y;
			let dist = Math.sqrt(dx * dx + dy * dy) || 1;
			const force = (dist - 80) * 0.05;
			dx = (dx / dist) * force;
			dy = (dy / dist) * force;
			source.vx += dx;
			source.vy += dy;
			target.vx -= dx;
			target.vy -= dy;
		}

		for (const node of nodes) {
			node.vx += (cx - node.x) * 0.001;
			node.vy += (cy - node.y) * 0.001;
			node.vx *= 0.85;
			node.vy *= 0.85;
			node.x += node.vx;
			node.y += node.vy;
			node.x = Math.max(node.radius, Math.min(width - node.radius, node.x));
			node.y = Math.max(node.radius, Math.min(height - node.radius, node.y));
		}
	}
};

export function ForceGraph({ nodes, links, width, height, selectedId, onSelect }: Props) {
	const initialized = useRef(false);
	const [positions, setPositions] = useState<ForceGraphNode[]>([]);

	useEffect(() => {
		if (nodes.length === 0) {
			setPositions([]);
			initialized.current = false;
			return;
		}

		const seeded = nodes.map((n, i) => {
			const angle = (i / nodes.length) * Math.PI * 2;
			const r = Math.min(width, height) * 0.3;
			return {
				...n,
				x: width / 2 + Math.cos(angle) * r,
				y: height / 2 + Math.sin(angle) * r,
				vx: 0,
				vy: 0,
			};
		});

		simulate(seeded, links, width, height, initialized.current ? 40 : 100);
		initialized.current = true;
		setPositions(seeded);
	}, [nodes, links, width, height]);

	const nodeMap = useMemo(() => new Map(positions.map(n => [n.id, n])), [positions]);

	return (
		<svg width={width} height={height} style={{ background: 'var(--vscode-editor-background)', display: 'block' }}>
			{links.map((link, idx) => {
				const source = nodeMap.get(link.source);
				const target = nodeMap.get(link.target);
				if (!source || !target) {
					return null;
				}
				return (
					<line
						key={`${link.source}-${link.target}-${idx}`}
						x1={source.x}
						y1={source.y}
						x2={target.x}
						y2={target.y}
						stroke={link.external ? 'var(--vscode-charts-orange)' : 'var(--vscode-editorWidget-border)'}
						strokeWidth={link.external ? 1 : 1.5}
						strokeOpacity={0.6}
					/>
				);
			})}
			{positions.map(node => (
				<g key={node.id} onClick={() => onSelect(node.id === selectedId ? null : node.id)} style={{ cursor: 'pointer' }}>
					{node.isEntryPoint && (
						<circle cx={node.x} cy={node.y} r={node.radius + 4} fill="none" stroke="#ff6b6b" strokeWidth={2} />
					)}
					{node.inCycle && (
						<circle cx={node.x} cy={node.y} r={node.radius + 2} fill="none" stroke="#fbbf24" strokeWidth={1.5} strokeDasharray="4 3" />
					)}
					<circle
						cx={node.x}
						cy={node.y}
						r={node.radius}
						fill={node.color}
						stroke={selectedId === node.id ? 'var(--vscode-focusBorder)' : 'var(--vscode-editorWidget-border)'}
						strokeWidth={selectedId === node.id ? 2.5 : 1}
					/>
					<text
						x={node.x}
						y={node.y + node.radius + 12}
						textAnchor="middle"
						fontSize={9}
						fill="var(--vscode-foreground)"
					>
						{node.label.length > 24 ? `${node.label.slice(0, 22)}…` : node.label}
					</text>
				</g>
			))}
		</svg>
	);
}

const LAYER_COLORS: Record<string, string> = {
	entry: '#ff6b6b',
	api: '#4dabf7',
	service: '#51cf66',
	data: '#9775fa',
	config: '#868e96',
	test: '#fcc419',
	external: '#ff922b',
};

export function buildFileGraphNodes(
	nodes: UCGFileNode[],
	cycleFiles: Set<string>,
): ForceGraphNode[] {
	return nodes.map(n => ({
		id: n.filePath,
		label: n.filePath.split('/').pop() ?? n.filePath,
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		radius: Math.max(6, Math.min(18, 6 + n.importedByCount * 1.5)),
		color: LAYER_COLORS[n.archLayer] ?? '#868e96',
		isEntryPoint: n.isEntryPoint,
		inCycle: cycleFiles.has(n.filePath),
		meta: n,
	}));
}

export function buildFileGraphLinks(edges: UCGImportEdge[]): ForceGraphLink[] {
	return edges
		.filter(e => e.resolvedFile && !e.isExternal)
		.map(e => ({
			source: e.fromFile,
			target: e.resolvedFile!,
			external: false,
		}));
}

export function buildPackageGraph(
	nodes: UCGFileNode[],
	edges: UCGImportEdge[],
	cycleFiles: Set<string>,
): { nodes: ForceGraphNode[]; links: ForceGraphLink[] } {
	const pkgs = new Map<string, UCGFileNode[]>();
	for (const n of nodes) {
		const parts = n.filePath.split('/');
		const pkg = parts.slice(0, Math.min(2, parts.length - 1)).join('/') || '.';
		if (!pkgs.has(pkg)) {
			pkgs.set(pkg, []);
		}
		pkgs.get(pkg)!.push(n);
	}

	const pkgNodes: ForceGraphNode[] = [...pkgs.entries()].map(([pkg, files]) => ({
		id: pkg,
		label: pkg === '.' ? '(root)' : pkg.split('/').pop() ?? pkg,
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		radius: Math.max(10, Math.min(28, 8 + files.length * 0.8)),
		color: LAYER_COLORS[files[0]?.archLayer ?? 'service'] ?? '#868e96',
		isEntryPoint: files.some(f => f.isEntryPoint),
		inCycle: files.some(f => cycleFiles.has(f.filePath)),
	}));

	const fileToPkg = (filePath: string) => {
		const parts = filePath.split('/');
		return parts.slice(0, Math.min(2, parts.length - 1)).join('/') || '.';
	};

	const linkSet = new Set<string>();
	const pkgLinks: ForceGraphLink[] = [];
	for (const e of edges) {
		if (!e.resolvedFile || e.isExternal) {
			continue;
		}
		const fromPkg = fileToPkg(e.fromFile);
		const toPkg = fileToPkg(e.resolvedFile);
		if (fromPkg === toPkg) {
			continue;
		}
		const key = `${fromPkg}→${toPkg}`;
		if (linkSet.has(key)) {
			continue;
		}
		linkSet.add(key);
		pkgLinks.push({ source: fromPkg, target: toPkg });
	}

	return { nodes: pkgNodes, links: pkgLinks };
}

export { LAYER_COLORS };
