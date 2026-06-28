/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * EmbeddingService — calls LiteLLM /embeddings endpoint to generate text embeddings.
 * Falls back gracefully when the endpoint is unavailable.
 */

const LITELLM_EMBEDDINGS_URL = 'http://localhost:4000/v1/embeddings';
const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v1';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TEXTS_PER_BATCH = 20;

export type EmbeddingVector = number[];

/** Cosine similarity between two unit vectors (or any float arrays of the same length). */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

/** Serialize a float array to a compact Buffer for SQLite BLOB storage. */
export function serializeEmbedding(vec: EmbeddingVector): Buffer {
	const buf = Buffer.allocUnsafe(vec.length * 4);
	for (let i = 0; i < vec.length; i++) {
		buf.writeFloatLE(vec[i], i * 4);
	}
	return buf;
}

/** Deserialize a float array from a SQLite BLOB Buffer. */
export function deserializeEmbedding(blob: Buffer): EmbeddingVector {
	const vec: EmbeddingVector = new Array(blob.length / 4);
	for (let i = 0; i < vec.length; i++) {
		vec[i] = blob.readFloatLE(i * 4);
	}
	return vec;
}

/** Calls LiteLLM /v1/embeddings to embed a batch of texts. Returns null if unavailable. */
export async function embedTexts(texts: string[]): Promise<EmbeddingVector[] | null> {
	if (texts.length === 0) return [];

	// Process in batches
	const allEmbeddings: EmbeddingVector[] = [];
	for (let i = 0; i < texts.length; i += MAX_TEXTS_PER_BATCH) {
		const batch = texts.slice(i, i + MAX_TEXTS_PER_BATCH);
		const batchResult = await _embedBatch(batch);
		if (batchResult === null) return null;
		allEmbeddings.push(...batchResult);
	}
	return allEmbeddings;
}

async function _embedBatch(texts: string[]): Promise<EmbeddingVector[] | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const resp = await fetch(LITELLM_EMBEDDINGS_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: DEFAULT_EMBEDDING_MODEL, input: texts }),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!resp.ok) return null;
		const data = await resp.json() as { data: { embedding: EmbeddingVector }[] };
		return data.data.map(d => d.embedding);
	} catch {
		return null;
	}
}

/** Embed a single text. Returns null if unavailable. */
export async function embedText(text: string): Promise<EmbeddingVector | null> {
	const result = await embedTexts([text]);
	return result?.[0] ?? null;
}
