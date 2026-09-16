/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, IReference } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';

type VoidModelType = {
	model: ITextModel | null;
	editorModel: IResolvedTextEditorModel | null;
};

const MODEL_REF_LRU_CAP = 200;

export interface ITroveModelService {
	readonly _serviceBrand: undefined;
	initializeModel(uri: URI): Promise<void>;
	getModel(uri: URI): VoidModelType;
	getModelFromFsPath(fsPath: string): VoidModelType;
	getModelSafe(uri: URI): Promise<VoidModelType>;
	saveModel(uri: URI): Promise<void>;
	/** Prevent LRU eviction while a diff zone is active on this URI. */
	pin(uri: URI): void;
	unpin(uri: URI): void;
}

export const ITroveModelService = createDecorator<ITroveModelService>('troveModelService');

/** Canonical map key — preserve scheme; case-fold only on Windows. */
export const modelUriKey = (uri: URI): string => {
	const s = uri.toString();
	return isWindows ? s.toLowerCase() : s;
};

class VoidModelService extends Disposable implements ITroveModelService {
	_serviceBrand: undefined;
	static readonly ID = 'troveModelService';

	/** Insertion-order Map acts as LRU: touch = delete+set; evict from the front. */
	private readonly _modelRefOfURI = new Map<string, IReference<IResolvedTextEditorModel>>();
	private readonly _pinnedKeys = new Set<string>();

	constructor(
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
	) {
		super();
	}

	pin = (uri: URI): void => {
		this._pinnedKeys.add(modelUriKey(uri));
	};

	unpin = (uri: URI): void => {
		this._pinnedKeys.delete(modelUriKey(uri));
		this._evictIfNeeded();
	};

	saveModel = async (uri: URI) => {
		await this._textFileService.save(uri, {
			skipSaveParticipants: true // avoid triggering extensions etc
		})
	}

	initializeModel = async (uri: URI) => {
		const key = modelUriKey(uri);
		if (this._modelRefOfURI.has(key)) {
			this._touch(key);
			return;
		}
		try {
			const editorModelRef = await this._textModelService.createModelReference(uri);
			this._modelRefOfURI.set(key, editorModelRef);
			this._evictIfNeeded();
		}
		catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			throw new Error(`Could not open ${uri.fsPath}: ${reason}. The file may not exist, may be binary, or may be too large to open.`);
		}
	};

	getModelFromFsPath = (fsPath: string): VoidModelType => {
		// Shim: treat raw fsPath as a file:// URI (callers that only have a path).
		return this.getModel(URI.file(fsPath));
	};

	getModel = (uri: URI): VoidModelType => {
		const key = modelUriKey(uri);
		const editorModelRef = this._modelRefOfURI.get(key);
		if (!editorModelRef) {
			return { model: null, editorModel: null };
		}
		this._touch(key);

		const model = editorModelRef.object.textEditorModel;
		if (!model) {
			return { model: null, editorModel: editorModelRef.object };
		}
		return { model, editorModel: editorModelRef.object };
	}

	getModelSafe = async (uri: URI): Promise<VoidModelType> => {
		const key = modelUriKey(uri);
		if (!this._modelRefOfURI.has(key)) {
			try { await this.initializeModel(uri); }
			catch { /* getModelSafe contract: return null model, never throw */ }
		}
		return this.getModel(uri);
	};

	private _touch(key: string): void {
		const ref = this._modelRefOfURI.get(key);
		if (!ref) return;
		this._modelRefOfURI.delete(key);
		this._modelRefOfURI.set(key, ref);
	}

	private _evictIfNeeded(): void {
		while (this._modelRefOfURI.size > MODEL_REF_LRU_CAP) {
			let evicted = false;
			for (const [key, ref] of this._modelRefOfURI) {
				if (this._pinnedKeys.has(key)) {
					continue;
				}
				this._modelRefOfURI.delete(key);
				ref.dispose();
				evicted = true;
				break;
			}
			// All remaining entries are pinned — stop to avoid infinite loop.
			if (!evicted) {
				break;
			}
		}
	}

	override dispose() {
		super.dispose();
		for (const ref of this._modelRefOfURI.values()) {
			ref.dispose();
		}
		this._modelRefOfURI.clear();
		this._pinnedKeys.clear();
	}
}

registerSingleton(ITroveModelService, VoidModelService, InstantiationType.Eager);
