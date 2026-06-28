/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const NOTEPAD_STORAGE_KEY = 'trove.notepads';

export type NotepadEntry = {
	id: string;
	title: string;
	content: string;
	lastModified: number;
};

export interface INotepadsService {
	readonly _serviceBrand: undefined;
	readonly notepads: NotepadEntry[];
	readonly onDidChange: Event<void>;

	createNotepad(title: string, content?: string): NotepadEntry;
	updateNotepad(id: string, updates: Partial<Pick<NotepadEntry, 'title' | 'content'>>): void;
	deleteNotepad(id: string): void;
	getNotepad(id: string): NotepadEntry | undefined;
}

export const INotepadsService = createDecorator<INotepadsService>('notepadsService');

class NotepadsService extends Disposable implements INotepadsService {
	readonly _serviceBrand: undefined;

	private _notepads: NotepadEntry[] = [];
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._load();
		const storageListenerStore = this._register(new DisposableStore());
		this._register(
			this._storageService.onDidChangeValue(StorageScope.APPLICATION, NOTEPAD_STORAGE_KEY, storageListenerStore)(
				() => this._load()
			)
		);
	}

	private _load(): void {
		try {
			const raw = this._storageService.get(NOTEPAD_STORAGE_KEY, StorageScope.APPLICATION, '[]');
			this._notepads = JSON.parse(raw) as NotepadEntry[];
		} catch {
			this._notepads = [];
		}
	}

	private _save(): void {
		this._storageService.store(NOTEPAD_STORAGE_KEY, JSON.stringify(this._notepads), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	get notepads(): NotepadEntry[] {
		return this._notepads;
	}

	createNotepad(title: string, content = ''): NotepadEntry {
		const entry: NotepadEntry = {
			id: `np_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			title,
			content,
			lastModified: Date.now(),
		};
		this._notepads = [...this._notepads, entry];
		this._save();
		return entry;
	}

	updateNotepad(id: string, updates: Partial<Pick<NotepadEntry, 'title' | 'content'>>): void {
		this._notepads = this._notepads.map(n =>
			n.id === id ? { ...n, ...updates, lastModified: Date.now() } : n
		);
		this._save();
	}

	deleteNotepad(id: string): void {
		this._notepads = this._notepads.filter(n => n.id !== id);
		this._save();
	}

	getNotepad(id: string): NotepadEntry | undefined {
		return this._notepads.find(n => n.id === id);
	}
}

registerSingleton(INotepadsService, NotepadsService, InstantiationType.Delayed);
