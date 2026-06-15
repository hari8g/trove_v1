/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';

const ANSI_COLOR_RE = /^\x1b\[([0-9;]*)m$/;

const FG_CLASS: Record<number, string> = {
	30: 'trove-ansi-fg-black', 31: 'trove-ansi-fg-red', 32: 'trove-ansi-fg-green', 33: 'trove-ansi-fg-yellow',
	34: 'trove-ansi-fg-blue', 35: 'trove-ansi-fg-magenta', 36: 'trove-ansi-fg-cyan', 37: 'trove-ansi-fg-white',
	90: 'trove-ansi-fg-bright-black', 91: 'trove-ansi-fg-bright-red', 92: 'trove-ansi-fg-bright-green',
	93: 'trove-ansi-fg-bright-yellow', 94: 'trove-ansi-fg-bright-blue', 95: 'trove-ansi-fg-bright-magenta',
	96: 'trove-ansi-fg-bright-cyan', 97: 'trove-ansi-fg-bright-white',
};

const BG_CLASS: Record<number, string> = {
	40: 'trove-ansi-bg-black', 41: 'trove-ansi-bg-red', 42: 'trove-ansi-bg-green', 43: 'trove-ansi-bg-yellow',
	44: 'trove-ansi-bg-blue', 45: 'trove-ansi-bg-magenta', 46: 'trove-ansi-bg-cyan', 47: 'trove-ansi-bg-white',
	100: 'trove-ansi-bg-bright-black', 101: 'trove-ansi-bg-bright-red', 102: 'trove-ansi-bg-bright-green',
	103: 'trove-ansi-bg-bright-yellow', 104: 'trove-ansi-bg-bright-blue', 105: 'trove-ansi-bg-bright-magenta',
	106: 'trove-ansi-bg-bright-cyan', 107: 'trove-ansi-bg-bright-white',
};

type AnsiSpan = { text: string; classes: string[] };

const heuristicLineClass = (line: string): string | undefined => {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	if (/^\$ /.test(trimmed)) return 'trove-ansi-cmd';
	if (/\(exit code 0\)/i.test(trimmed)) return 'trove-ansi-success';
	if (/\(exit code [1-9]\d*\)/i.test(trimmed)) return 'trove-ansi-error';
	if (/\b(error|failed|failure|fatal|exception|ERR!)\b/i.test(trimmed)) return 'trove-ansi-error';
	if (/\b(warn|warning|deprecated)\b/i.test(trimmed)) return 'trove-ansi-warn';
	if (/\b(passed|passing|success|✓|✔|OK)\b/i.test(trimmed)) return 'trove-ansi-success';
	if (/\b(running|compiling|building|starting)\b/i.test(trimmed)) return 'trove-ansi-info';
	return undefined;
};

const parseAnsiSpans = (text: string): AnsiSpan[] => {
	const spans: AnsiSpan[] = [];
	const parts = text.split(/(\x1b\[[0-9;]*m)/g);
	let fg = '';
	let bg = '';
	let bold = false;
	let dim = false;
	let italic = false;
	let underline = false;

	const pushText = (chunk: string) => {
		if (!chunk) return;
		const classes = [fg, bg, bold ? 'trove-ansi-bold' : '', dim ? 'trove-ansi-dim' : '', italic ? 'trove-ansi-italic' : '', underline ? 'trove-ansi-underline' : ''].filter(Boolean);
		spans.push({ text: chunk, classes });
	};

	for (const part of parts) {
		const codeMatch = ANSI_COLOR_RE.exec(part);
		if (codeMatch) {
			const codes = codeMatch[1] ? codeMatch[1].split(';').map(Number) : [0];
			for (const code of codes) {
				if (code === 0) { fg = ''; bg = ''; bold = false; dim = false; italic = false; underline = false; }
				else if (code === 1) bold = true;
				else if (code === 2) dim = true;
				else if (code === 3) italic = true;
				else if (code === 4) underline = true;
				else if (code === 22) { bold = false; dim = false; }
				else if (code === 23) italic = false;
				else if (code === 24) underline = false;
				else if (FG_CLASS[code]) fg = FG_CLASS[code];
				else if (BG_CLASS[code]) bg = BG_CLASS[code];
			}
			continue;
		}
		pushText(part);
	}
	return spans;
};

const applyHeuristics = (spans: AnsiSpan[]): AnsiSpan[] => {
	if (spans.some(s => s.classes.length > 0)) return spans;
	// No ANSI codes — apply intelligent per-line coloring (Cursor-style)
	const out: AnsiSpan[] = [];
	for (const span of spans) {
		const lines = span.text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const cls = heuristicLineClass(line);
			out.push({ text: line + (i < lines.length - 1 ? '\n' : ''), classes: cls ? [cls] : [] });
		}
	}
	return out;
};

export const AnsiTerminalOutput = ({ text, className = '' }: { text: string; className?: string }) => {
	const spans = useMemo(() => applyHeuristics(parseAnsiSpans(text)), [text]);

	return (
		<pre className={`trove-ansi-terminal font-mono text-xs leading-relaxed whitespace-pre overflow-auto ${className}`}>
			{spans.map((span, i) => (
				<span key={i} className={span.classes.join(' ')}>{span.text}</span>
			))}
		</pre>
	);
};
