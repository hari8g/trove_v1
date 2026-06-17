/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type StreamingEditBlockStatus = 'partial' | 'complete';

export type StreamingEditBlock = {
	index: number;
	status: StreamingEditBlockStatus;
	origLineCount: number;
	finalLineCount: number;
	/** Short preview of the replacement side */
	preview: string;
};

export type StreamingEditProgress = {
	completeBlockCount: number;
	hasPartialBlock: boolean;
	totalOrigLines: number;
	totalFinalLines: number;
	blocks: StreamingEditBlock[];
	/** Live tail of raw stream for display */
	rawTail: string;
};

const SEARCH_MARKER = '<<<<<<<';
const DIVIDER_MARKER = '=======';
const REPLACE_MARKER = '>>>>>>>';

export const parseStreamingEditProgress = (raw: string, isEditFile: boolean): StreamingEditProgress => {
	if (!isEditFile) {
		const lines = raw.split('\n');
		return {
			completeBlockCount: 0,
			hasPartialBlock: raw.length > 0,
			totalOrigLines: 0,
			totalFinalLines: lines.length,
			blocks: raw.trim() ? [{
				index: 0,
				status: 'partial',
				origLineCount: 0,
				finalLineCount: lines.length,
				preview: getStreamingTailPreview(raw, 2),
			}] : [],
			rawTail: getStreamingTailPreview(raw, 8, 900),
		};
	}

	const blocks: StreamingEditBlock[] = [];
	let completeBlockCount = 0;
	let totalOrigLines = 0;
	let totalFinalLines = 0;
	let hasPartialBlock = false;

	const parts = raw.split(SEARCH_MARKER);
	for (let i = 1; i < parts.length; i++) {
		const chunk = parts[i];
		const dividerIdx = chunk.indexOf(`\n${DIVIDER_MARKER}`);
		const endIdx = chunk.indexOf(REPLACE_MARKER);

		if (dividerIdx === -1) {
			hasPartialBlock = true;
			blocks.push({
				index: i - 1,
				status: 'partial',
				origLineCount: chunk.split('\n').length,
				finalLineCount: 0,
				preview: '(reading original section…)',
			});
			continue;
		}

		const origSection = chunk.slice(0, dividerIdx);
		const afterDivider = chunk.slice(dividerIdx + `\n${DIVIDER_MARKER}`.length);
		const origLines = origSection.split('\n').filter(l => l.trim()).length;
		totalOrigLines += origLines;

		if (endIdx === -1) {
			hasPartialBlock = true;
			const finalSection = afterDivider;
			const finalLines = finalSection.split('\n').filter(l => l.trim()).length;
			totalFinalLines += finalLines;
			blocks.push({
				index: i - 1,
				status: 'partial',
				origLineCount: origLines,
				finalLineCount: finalLines,
				preview: getStreamingTailPreview(finalSection, 2, 160),
			});
			continue;
		}

		const finalSection = afterDivider.slice(0, endIdx);
		const finalLines = finalSection.split('\n').filter(l => l.trim()).length;
		totalFinalLines += finalLines;
		completeBlockCount += 1;
		blocks.push({
			index: i - 1,
			status: 'complete',
			origLineCount: origLines,
			finalLineCount: finalLines,
			preview: getStreamingTailPreview(finalSection, 2, 160),
		});
	}

	if (parts.length === 1 && raw.includes(SEARCH_MARKER.slice(0, 3))) {
		hasPartialBlock = true;
	}

	return {
		completeBlockCount,
		hasPartialBlock,
		totalOrigLines,
		totalFinalLines,
		blocks,
		rawTail: getStreamingTailPreview(raw, 8, 900),
	};
};

const getStreamingTailPreview = (text: string, maxLines: number, maxChars = 280): string => {
	const trimmed = text.trim();
	if (!trimmed) return '';
	const lines = trimmed.split('\n').filter(l => l.trim());
	const tail = lines.slice(-maxLines).join('\n');
	if (tail.length <= maxChars) return tail;
	return `…${tail.slice(-maxChars + 1)}`;
};

export const formatEditStreamPhaseLabel = (progress: StreamingEditProgress, fileName?: string): string => {
	const target = fileName ? ` · ${fileName}` : '';
	if (progress.blocks.length === 0) {
		return `Generating edit${target}`;
	}
	if (progress.hasPartialBlock) {
		const n = progress.completeBlockCount + 1;
		return `Writing change ${n}${target}`;
	}
	return `Finished ${progress.completeBlockCount} change${progress.completeBlockCount === 1 ? '' : 's'}${target}`;
};
