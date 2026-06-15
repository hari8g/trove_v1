/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';
import { diffLines } from 'diff';
import { extractSearchReplaceBlocks } from '../../../../common/helpers/extractCodeFromResult.js';

export type ChatDiffLine = { type: 'remove' | 'add'; text: string };

export type ChatDiffStats = { lines: ChatDiffLine[]; added: number; removed: number };

const splitLines = (text: string): string[] => {
	if (!text) return [];
	return text.split('\n');
};

export const computeChatDiff = (
	code: string,
	type: 'diff' | 'rewrite',
	originalContent?: string,
): ChatDiffStats => {
	if (type === 'diff') {
		const blocks = extractSearchReplaceBlocks(code);
		const lines: ChatDiffLine[] = [];
		let added = 0;
		let removed = 0;
		for (const block of blocks) {
			for (const line of splitLines(block.orig)) {
				lines.push({ type: 'remove', text: line });
				removed++;
			}
			for (const line of splitLines(block.final)) {
				lines.push({ type: 'add', text: line });
				added++;
			}
		}
		return { lines, added, removed };
	}

	const oldStr = originalContent ?? '';
	const newStr = code;
	const changes = diffLines(oldStr, newStr);
	const lines: ChatDiffLine[] = [];
	let added = 0;
	let removed = 0;
	for (const change of changes) {
		if (!change.added && !change.removed) continue;
		const chunk = change.value.endsWith('\n') ? change.value.slice(0, -1) : change.value;
		if (!chunk && !change.value) continue;
		for (const line of chunk.split('\n')) {
			if (change.added) {
				lines.push({ type: 'add', text: line });
				added++;
			} else if (change.removed) {
				lines.push({ type: 'remove', text: line });
				removed++;
			}
		}
	}
	return { lines, added, removed };
};

export const ChatInlineDiffView = ({
	code,
	type,
	originalContent,
}: {
	code: string;
	type: 'diff' | 'rewrite';
	originalContent?: string;
}) => {
	const { lines } = useMemo(
		() => computeChatDiff(code, type, originalContent),
		[code, type, originalContent],
	);

	if (lines.length === 0) {
		return <div className="px-2 py-2 text-[11px] text-trove-fg-4 italic">No changes yet</div>;
	}

	return (
		<div className="font-mono text-[11px] leading-[1.45] overflow-x-auto">
			{lines.map((line, i) => (
				<div
					key={i}
					className={`px-2 py-px whitespace-pre ${
						line.type === 'remove'
							? 'bg-red-500/15 text-red-700 dark:text-red-300'
							: 'bg-green-500/15 text-green-800 dark:text-green-300'
					}`}
				>
					<span className="select-none opacity-60 w-3 inline-block">{line.type === 'remove' ? '-' : '+'}</span>
					{line.text || ' '}
				</div>
			))}
		</div>
	);
};
