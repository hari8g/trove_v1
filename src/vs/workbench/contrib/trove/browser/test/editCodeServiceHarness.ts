/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';

export type FakeModel = {
	getValue(): string;
	getLineCount(): number;
	getValueInRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): string;
	applyEdits(edits: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }[]): void;
	changeDecorations(cb: (accessor: unknown) => unknown): unknown;
};

export const createFakeModel = (initial: string): FakeModel => {
	let value = initial.replace(/\r\n/g, '\n');

	const offsetOf = (lineNumber: number, column: number): number => {
		const lines = value.split('\n');
		let offset = 0;
		for (let i = 0; i < lineNumber - 1; i++) {
			offset += (lines[i]?.length ?? 0) + 1;
		}
		return offset + (column - 1);
	};

	return {
		getValue: () => value,
		getLineCount: () => (value.length === 0 ? 1 : value.split('\n').length),
		getValueInRange: (range) => {
			const start = offsetOf(range.startLineNumber, range.startColumn);
			const end = offsetOf(range.endLineNumber, range.endColumn);
			return value.slice(start, end);
		},
		applyEdits: (edits) => {
			const sorted = [...edits].sort((a, b) => {
				const aStart = offsetOf(a.range.startLineNumber, a.range.startColumn);
				const bStart = offsetOf(b.range.startLineNumber, b.range.startColumn);
				return bStart - aStart;
			});
			for (const edit of sorted) {
				const start = offsetOf(edit.range.startLineNumber, edit.range.startColumn);
				const end = offsetOf(edit.range.endLineNumber, edit.range.endColumn);
				value = value.slice(0, start) + edit.text + value.slice(end);
			}
		},
		changeDecorations: (cb) => cb({
			addDecoration: () => 1,
			removeDecoration: () => undefined,
			changeDecoration: () => undefined,
			changeDecorationOptions: () => undefined,
			deltaDecorations: () => [],
		}),
	};
};

export type FakeModelService = {
	initializeModel(uri: URI): Promise<void>;
	getModel(uri: URI): { model: FakeModel | null; editorModel: null };
	getModelSafe(uri: URI): Promise<{ model: FakeModel | null; editorModel: null }>;
	saveModel(uri: URI): Promise<void>;
	/** test hooks */
	__setModel(uri: URI, model: FakeModel | null): void;
	__setInitializeThrows(err: Error | null): void;
	__saveCallCount(): number;
	__savedContentAtSaveTime(): string[];
};

export const createFakeModelService = (): FakeModelService => {
	const models = new Map<string, FakeModel | null>();
	let initializeThrows: Error | null = null;
	const savedContentAtSaveTime: string[] = [];

	return {
		initializeModel: async (uri: URI) => {
			if (initializeThrows) {
				throw initializeThrows;
			}
			if (!models.has(uri.fsPath)) {
				models.set(uri.fsPath, createFakeModel(''));
			}
		},
		getModel: (uri: URI) => {
			const model = models.has(uri.fsPath) ? models.get(uri.fsPath)! : null;
			return { model, editorModel: null };
		},
		getModelSafe: async (uri: URI) => {
			if (!models.has(uri.fsPath)) {
				try {
					if (initializeThrows) {
						throw initializeThrows;
					}
					models.set(uri.fsPath, createFakeModel(''));
				} catch {
					return { model: null, editorModel: null };
				}
			}
			return { model: models.get(uri.fsPath) ?? null, editorModel: null };
		},
		saveModel: async (uri: URI) => {
			const model = models.get(uri.fsPath);
			savedContentAtSaveTime.push(model?.getValue() ?? '');
		},
		__setModel: (uri: URI, model: FakeModel | null) => {
			models.set(uri.fsPath, model);
		},
		__setInitializeThrows: (err: Error | null) => {
			initializeThrows = err;
		},
		__saveCallCount: () => savedContentAtSaveTime.length,
		__savedContentAtSaveTime: () => [...savedContentAtSaveTime],
	};
};
