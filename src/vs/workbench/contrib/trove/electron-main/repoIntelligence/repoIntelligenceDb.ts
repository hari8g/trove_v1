/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { join } from 'path';
import type { Database } from '@vscode/sqlite3';
import { CommandEntry, CodeChunk, CodebaseSearchResult, ExtractedSymbol, FileMetadataEntry, FrameworkEntry, WorkspaceProfile } from '../../common/repoIntelligenceTypes.js';

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_profiles (
  workspace_hash    TEXT PRIMARY KEY,
  workspace_root    TEXT NOT NULL,
  last_scanned_at   INTEGER NOT NULL,
  language_stack    TEXT NOT NULL,
  frameworks        TEXT NOT NULL,
  package_managers  TEXT NOT NULL,
  build_commands    TEXT NOT NULL,
  test_commands     TEXT NOT NULL,
  lint_commands     TEXT NOT NULL,
  typecheck_commands TEXT NOT NULL,
  project_purpose   TEXT,
  architecture_summary TEXT,
  file_count        INTEGER,
  total_loc         INTEGER,
  stale             INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_metadata (
  workspace_hash  TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  language        TEXT,
  last_modified   INTEGER NOT NULL,
  size_bytes      INTEGER,
  PRIMARY KEY (workspace_hash, file_path),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_metadata_workspace ON file_metadata(workspace_hash);
CREATE INDEX IF NOT EXISTS idx_file_metadata_language ON file_metadata(workspace_hash, language);

CREATE TABLE IF NOT EXISTS code_chunks (
  id             TEXT PRIMARY KEY,
  workspace_hash   TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  chunk_text       TEXT NOT NULL,
  start_line       INTEGER NOT NULL,
  end_line         INTEGER NOT NULL,
  chunk_type       TEXT NOT NULL,
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_text,
  file_path UNINDEXED,
  workspace_hash UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED,
  chunk_type UNINDEXED
);

CREATE INDEX IF NOT EXISTS idx_code_chunks_workspace ON code_chunks(workspace_hash);
CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(workspace_hash, file_path);

CREATE TABLE IF NOT EXISTS symbols (
  workspace_hash  TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  start_line      INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  signature       TEXT,
  docstring       TEXT,
  is_exported     INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, file_path, name, kind),
  FOREIGN KEY (workspace_hash, file_path)
    REFERENCES file_metadata(workspace_hash, file_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(workspace_hash, name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(workspace_hash, file_path);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  signature,
  docstring,
  file_path UNINDEXED,
  workspace_hash UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
);
`;

type ColumnInfo = { name: string };

type WorkspaceProfileRow = {
	workspace_hash: string;
	workspace_root: string;
	last_scanned_at: number;
	language_stack: string;
	frameworks: string;
	package_managers: string;
	build_commands: string;
	test_commands: string;
	lint_commands: string;
	typecheck_commands: string;
	project_purpose: string | null;
	architecture_summary: string | null;
	file_count: number | null;
	total_loc: number | null;
	stale: number;
};

export const hashWorkspaceRoot = (workspaceRoot: string): string => {
	return createHash('sha256').update(workspaceRoot).digest('hex');
};

export class RepoIntelligenceDb {
	private _db: Database | null = null;
	private readonly _dbPath: string;

	constructor(dbPath: string) {
		this._dbPath = dbPath;
	}

	async init(): Promise<void> {
		if (this._db) return;
		const sqlite3 = await import('@vscode/sqlite3');
		const db = await new Promise<Database>((resolve, reject) => {
			const connection = new sqlite3.default.Database(this._dbPath, (error) => {
				if (error) reject(error);
				else resolve(connection);
			});
		});
		await this._exec(db, SCHEMA);
		await this._migrate(db);
		this._db = db;
		console.log('[RepoIntelligence] DB initialized at', this._dbPath);
	}

	close(): void {
		this._db?.close();
		this._db = null;
	}

	private _getDb(): Database {
		if (!this._db) throw new Error('RepoIntelligenceDb not initialized');
		return this._db;
	}

	private _exec(db: Database, sql: string): Promise<void> {
		return new Promise((resolve, reject) => {
			db.exec(sql, (error) => error ? reject(error) : resolve());
		});
	}

	private async _migrate(db: Database): Promise<void> {
		const fileMetaColumns = await new Promise<ColumnInfo[]>((resolve, reject) => {
			db.all(`PRAGMA table_info(file_metadata)`, (error, rows) => error ? reject(error) : resolve(rows as ColumnInfo[]));
		});
		if (!fileMetaColumns.some(c => c.name === 'content_hash')) {
			await this._exec(db, `ALTER TABLE file_metadata ADD COLUMN content_hash TEXT`);
		}

		await this._migrateLegacyKnowledgeGraph(db);
		await this._ensureCurrentSymbolsSchema(db);
		await this._ensureFtsTable(
			db,
			'chunks_fts',
			`CREATE VIRTUAL TABLE chunks_fts USING fts5(
				chunk_text,
				file_path UNINDEXED,
				workspace_hash UNINDEXED,
				start_line UNINDEXED,
				end_line UNINDEXED,
				chunk_type UNINDEXED
			)`,
			`INSERT INTO chunks_fts (chunk_text, file_path, workspace_hash, start_line, end_line, chunk_type)
			 SELECT chunk_text, file_path, workspace_hash, start_line, end_line, chunk_type FROM code_chunks`,
		);
		await this._ensureFtsTable(
			db,
			'symbols_fts',
			`CREATE VIRTUAL TABLE symbols_fts USING fts5(
				name,
				signature,
				docstring,
				file_path UNINDEXED,
				workspace_hash UNINDEXED,
				start_line UNINDEXED,
				end_line UNINDEXED
			)`,
			`INSERT INTO symbols_fts (name, signature, docstring, file_path, workspace_hash, start_line, end_line)
			 SELECT name, signature, docstring, file_path, workspace_hash, start_line, end_line FROM symbols`,
		);

		await this._exec(db, `PRAGMA user_version = ${SCHEMA_VERSION}`);
	}

	/** Drop pre-v2 knowledge-graph tables (symbol_id PK, content-backed FTS, edges/embeddings). */
	private async _migrateLegacyKnowledgeGraph(db: Database): Promise<void> {
		const hasLegacySymbols = await this._tableExists(db, 'symbols')
			&& await this._tableHasColumn(db, 'symbols', 'symbol_id');
		const hasLegacyFts = await this._tableExists(db, 'symbols_fts')
			&& !(await this._ftsSupportsWorkspaceFilter(db, 'symbols_fts'));

		if (!hasLegacySymbols && !hasLegacyFts) {
			return;
		}

		console.warn('[RepoIntelligence] Migrating legacy symbol schema to v2 format');
		await this._exec(db, `
			DROP TABLE IF EXISTS symbol_embeddings;
			DROP TABLE IF EXISTS symbol_edges;
			DROP TABLE IF EXISTS file_change_log;
			DROP TABLE IF EXISTS symbols_fts;
			DROP TABLE IF EXISTS symbols;
		`);
	}

	private async _ensureCurrentSymbolsSchema(db: Database): Promise<void> {
		if (await this._tableExists(db, 'symbols')) {
			return;
		}
		await this._exec(db, `
			CREATE TABLE symbols (
				workspace_hash  TEXT NOT NULL,
				file_path       TEXT NOT NULL,
				name            TEXT NOT NULL,
				kind            TEXT NOT NULL,
				start_line      INTEGER NOT NULL,
				end_line        INTEGER NOT NULL,
				signature       TEXT,
				docstring       TEXT,
				is_exported     INTEGER NOT NULL DEFAULT 0,
				content_hash    TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, file_path, name, kind),
				FOREIGN KEY (workspace_hash, file_path)
					REFERENCES file_metadata(workspace_hash, file_path) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(workspace_hash, name);
			CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(workspace_hash, file_path);
		`);
	}

	private async _tableExists(db: Database, tableName: string): Promise<boolean> {
		const row = await new Promise<{ cnt: number } | undefined>((resolve, reject) => {
			db.get(
				`SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
				[tableName],
				(error, result) => error ? reject(error) : resolve(result as { cnt: number } | undefined),
			);
		});
		return (row?.cnt ?? 0) > 0;
	}

	private async _tableHasColumn(db: Database, tableName: string, columnName: string): Promise<boolean> {
		const rows = await new Promise<ColumnInfo[]>((resolve, reject) => {
			db.all(`PRAGMA table_info(${tableName})`, (error, result) => error ? reject(error) : resolve(result as ColumnInfo[]));
		});
		return rows.some(c => c.name === columnName);
	}

	private async _ftsSupportsWorkspaceFilter(db: Database, tableName: string): Promise<boolean> {
		try {
			await new Promise<void>((resolve, reject) => {
				db.run(`DELETE FROM ${tableName} WHERE workspace_hash IS NULL`, (error) => error ? reject(error) : resolve());
			});
			return true;
		} catch {
			return false;
		}
	}

	private async _ensureFtsTable(
		db: Database,
		tableName: string,
		createSql: string,
		backfillSql: string,
	): Promise<void> {
		const exists = await this._tableExists(db, tableName);
		if (exists && await this._ftsSupportsWorkspaceFilter(db, tableName)) {
			return;
		}
		if (exists) {
			console.warn(`[RepoIntelligence] Recreating ${tableName} — missing workspace_hash column`);
			await this._exec(db, `DROP TABLE IF EXISTS ${tableName}`);
		}
		await this._exec(db, createSql);
		try {
			await this._exec(db, backfillSql);
		} catch (err) {
			console.warn(`[RepoIntelligence] ${tableName} backfill skipped:`, err);
		}
	}

	private _run(sql: string, params: unknown[] = []): Promise<void> {
		return new Promise((resolve, reject) => {
			this._getDb().run(sql, params, (error) => error ? reject(error) : resolve());
		});
	}

	private _get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
		return new Promise((resolve, reject) => {
			this._getDb().get(sql, params, (error, row) => error ? reject(error) : resolve(row as T | undefined));
		});
	}

	private _all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
		return new Promise((resolve, reject) => {
			this._getDb().all(sql, params, (error, rows) => error ? reject(error) : resolve(rows as T[]));
		});
	}

	private _rowToProfile(row: WorkspaceProfileRow): WorkspaceProfile {
		return {
			workspaceRoot: row.workspace_root,
			lastScannedAt: row.last_scanned_at,
			languageStack: JSON.parse(row.language_stack),
			frameworks: JSON.parse(row.frameworks) as FrameworkEntry[],
			packageManagers: JSON.parse(row.package_managers),
			buildCommands: JSON.parse(row.build_commands) as CommandEntry[],
			testCommands: JSON.parse(row.test_commands) as CommandEntry[],
			lintCommands: JSON.parse(row.lint_commands) as CommandEntry[],
			typecheckCommands: JSON.parse(row.typecheck_commands) as CommandEntry[],
			projectPurpose: row.project_purpose,
			architectureSummary: row.architecture_summary,
			fileCount: row.file_count ?? 0,
			totalLoc: row.total_loc ?? 0,
			isStale: row.stale === 1,
		};
	}

	async getProfile(workspaceHash: string): Promise<WorkspaceProfile | null> {
		const row = await this._get<WorkspaceProfileRow>(
			`SELECT * FROM workspace_profiles WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return row ? this._rowToProfile(row) : null;
	}

	async getFileMetadata(workspaceHash: string): Promise<FileMetadataEntry[]> {
		type FileMetaRow = {
			file_path: string;
			language: string | null;
			last_modified: number;
			size_bytes: number | null;
		};
		const rows = await this._all<FileMetaRow>(
			`SELECT file_path, language, last_modified, size_bytes FROM file_metadata WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(row => ({
			filePath: row.file_path,
			language: row.language,
			lastModified: row.last_modified,
			sizeBytes: row.size_bytes ?? 0,
		}));
	}

	async getFileHashes(workspaceHash: string): Promise<Map<string, string>> {
		const rows = await this._all<{ file_path: string; content_hash: string }>(
			`SELECT file_path, content_hash FROM file_metadata
			 WHERE workspace_hash = ? AND content_hash IS NOT NULL`,
			[workspaceHash],
		);
		return new Map(rows.map(r => [r.file_path, r.content_hash]));
	}

	async upsertFileHash(workspaceHash: string, filePath: string, contentHash: string): Promise<void> {
		await this._run(
			`UPDATE file_metadata SET content_hash = ? WHERE workspace_hash = ? AND file_path = ?`,
			[contentHash, workspaceHash, filePath],
		);
	}

	async replaceSymbolsForFile(workspaceHash: string, filePath: string, symbols: ExtractedSymbol[]): Promise<void> {
		await this._run(`DELETE FROM symbols WHERE workspace_hash = ? AND file_path = ?`, [workspaceHash, filePath]);
		await this._run(`DELETE FROM symbols_fts WHERE workspace_hash = ? AND file_path = ?`, [workspaceHash, filePath]);
		for (const s of symbols) {
			await this._run(
				`INSERT OR REPLACE INTO symbols
				 (workspace_hash, file_path, name, kind, start_line, end_line, signature, docstring, is_exported, content_hash)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[workspaceHash, filePath, s.name, s.kind, s.startLine, s.endLine, s.signature, s.docstring, s.isExported ? 1 : 0, s.contentHash],
			);
			await this._run(
				`INSERT INTO symbols_fts (name, signature, docstring, file_path, workspace_hash, start_line, end_line)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[s.name, s.signature, s.docstring, filePath, workspaceHash, s.startLine, s.endLine],
			);
		}
	}

	async getFileOutline(workspaceHash: string, filePath: string): Promise<ExtractedSymbol[]> {
		type SymbolRow = {
			name: string;
			kind: ExtractedSymbol['kind'];
			file_path: string;
			start_line: number;
			end_line: number;
			signature: string | null;
			docstring: string | null;
			is_exported: number;
			content_hash: string;
		};
		const rows = await this._all<SymbolRow>(
			`SELECT name, kind, file_path, start_line, end_line, signature, docstring, is_exported, content_hash
			 FROM symbols WHERE workspace_hash = ? AND file_path = ?
			 ORDER BY start_line ASC`,
			[workspaceHash, filePath],
		);
		return rows.map(row => ({
			name: row.name,
			kind: row.kind,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			signature: row.signature ?? '',
			docstring: row.docstring ?? '',
			isExported: row.is_exported === 1,
			contentHash: row.content_hash,
		}));
	}

	async getSymbol(workspaceHash: string, filePath: string, symbolName: string): Promise<ExtractedSymbol | null> {
		type SymbolRow = {
			name: string;
			kind: ExtractedSymbol['kind'];
			file_path: string;
			start_line: number;
			end_line: number;
			signature: string | null;
			docstring: string | null;
			is_exported: number;
			content_hash: string;
		};
		const row = await this._get<SymbolRow>(
			`SELECT name, kind, file_path, start_line, end_line, signature, docstring, is_exported, content_hash
			 FROM symbols WHERE workspace_hash = ? AND file_path = ? AND name = ?
			 LIMIT 1`,
			[workspaceHash, filePath, symbolName],
		);
		if (!row) {
			return null;
		}
		return {
			name: row.name,
			kind: row.kind,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			signature: row.signature ?? '',
			docstring: row.docstring ?? '',
			isExported: row.is_exported === 1,
			contentHash: row.content_hash,
		};
	}

	async searchSymbols(workspaceHash: string, query: string, maxResults = 20): Promise<ExtractedSymbol[]> {
		type SymbolRow = {
			name: string;
			kind: ExtractedSymbol['kind'];
			file_path: string;
			start_line: number;
			end_line: number;
			signature: string | null;
			docstring: string | null;
			is_exported: number;
			content_hash: string;
		};
		const mapRow = (row: SymbolRow): ExtractedSymbol => ({
			name: row.name,
			kind: row.kind,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			signature: row.signature ?? '',
			docstring: row.docstring ?? '',
			isExported: row.is_exported === 1,
			contentHash: row.content_hash,
		});

		try {
			const ftsResults = await this._all<SymbolRow>(
				`SELECT s.name, s.kind, s.file_path, s.start_line, s.end_line,
				        s.signature, s.docstring, s.is_exported, s.content_hash
				 FROM symbols_fts f
				 JOIN symbols s ON s.file_path = f.file_path
				  AND s.workspace_hash = f.workspace_hash
				  AND s.name = f.name
				  AND s.start_line = f.start_line
				 WHERE f MATCH ? AND s.workspace_hash = ?
				 ORDER BY rank LIMIT ?`,
				[query.replace(FTS_SPECIAL_CHARS, ' '), workspaceHash, maxResults],
			);
			if (ftsResults.length > 0) {
				return ftsResults.map(mapRow);
			}
		} catch {
			// FTS parse error — fall through to LIKE
		}

		return (await this._all<SymbolRow>(
			`SELECT name, kind, file_path, start_line, end_line, signature, docstring, is_exported, content_hash
			 FROM symbols WHERE workspace_hash = ? AND name LIKE ?
			 LIMIT ?`,
			[workspaceHash, `%${query}%`, maxResults],
		)).map(mapRow);
	}

	async upsertProfile(workspaceHash: string, profile: WorkspaceProfile, fileMeta: FileMetadataEntry[]): Promise<void> {
		await this._run(
			`INSERT INTO workspace_profiles (
				workspace_hash, workspace_root, last_scanned_at, language_stack, frameworks,
				package_managers, build_commands, test_commands, lint_commands, typecheck_commands,
				project_purpose, architecture_summary, file_count, total_loc, stale
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
			ON CONFLICT(workspace_hash) DO UPDATE SET
				workspace_root = excluded.workspace_root,
				last_scanned_at = excluded.last_scanned_at,
				language_stack = excluded.language_stack,
				frameworks = excluded.frameworks,
				package_managers = excluded.package_managers,
				build_commands = excluded.build_commands,
				test_commands = excluded.test_commands,
				lint_commands = excluded.lint_commands,
				typecheck_commands = excluded.typecheck_commands,
				project_purpose = COALESCE(excluded.project_purpose, project_purpose),
				architecture_summary = COALESCE(excluded.architecture_summary, architecture_summary),
				file_count = excluded.file_count,
				total_loc = excluded.total_loc,
				stale = 0`,
			[
				workspaceHash,
				profile.workspaceRoot,
				profile.lastScannedAt,
				JSON.stringify(profile.languageStack),
				JSON.stringify(profile.frameworks),
				JSON.stringify(profile.packageManagers),
				JSON.stringify(profile.buildCommands),
				JSON.stringify(profile.testCommands),
				JSON.stringify(profile.lintCommands),
				JSON.stringify(profile.typecheckCommands),
				profile.projectPurpose,
				profile.architectureSummary,
				profile.fileCount,
				profile.totalLoc,
			],
		);

		await this._run(`DELETE FROM file_metadata WHERE workspace_hash = ?`, [workspaceHash]);
		for (const file of fileMeta) {
			await this._run(
				`INSERT INTO file_metadata (workspace_hash, file_path, language, last_modified, size_bytes)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, file.filePath, file.language, file.lastModified, file.sizeBytes],
			);
		}
	}

	async updateSummaries(workspaceHash: string, projectPurpose: string | null, architectureSummary: string | null): Promise<void> {
		await this._run(
			`UPDATE workspace_profiles SET project_purpose = ?, architecture_summary = ? WHERE workspace_hash = ?`,
			[projectPurpose, architectureSummary, workspaceHash],
		);
	}

	async markStale(workspaceHash: string): Promise<void> {
		await this._run(`UPDATE workspace_profiles SET stale = 1 WHERE workspace_hash = ?`, [workspaceHash]);
	}

	async getChunkCount(workspaceHash: string): Promise<number> {
		const row = await this._get<{ count: number }>(
			`SELECT COUNT(*) AS count FROM code_chunks WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return row?.count ?? 0;
	}

	async replaceChunks(workspaceHash: string, chunks: CodeChunk[]): Promise<void> {
		await this._run(`DELETE FROM code_chunks WHERE workspace_hash = ?`, [workspaceHash]);
		await this._run(`DELETE FROM chunks_fts WHERE workspace_hash = ?`, [workspaceHash]);

		for (const chunk of chunks) {
			await this._run(
				`INSERT INTO code_chunks (id, workspace_hash, file_path, chunk_text, start_line, end_line, chunk_type)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[chunk.id, workspaceHash, chunk.filePath, chunk.chunkText, chunk.startLine, chunk.endLine, chunk.chunkType],
			);
			await this._run(
				`INSERT INTO chunks_fts (chunk_text, file_path, workspace_hash, start_line, end_line, chunk_type)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[chunk.chunkText, chunk.filePath, workspaceHash, chunk.startLine, chunk.endLine, chunk.chunkType],
			);
		}
	}

	async searchChunks(workspaceHash: string, query: string, limit: number): Promise<CodebaseSearchResult[]> {
		const ftsQuery = buildFtsQuery(query);
		if (!ftsQuery) return [];

		type FtsRow = {
			file_path: string;
			start_line: number;
			end_line: number;
			chunk_text: string;
			score: number;
		};

		const rows = await this._all<FtsRow>(
			`SELECT file_path, start_line, end_line, chunk_text, bm25(chunks_fts) AS score
			 FROM chunks_fts
			 WHERE chunks_fts MATCH ? AND workspace_hash = ?
			 ORDER BY score
			 LIMIT ?`,
			[ftsQuery, workspaceHash, limit],
		);

		return rows.map(row => ({
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			snippet: truncateSnippet(row.chunk_text, 400),
			score: row.score,
		}));
	}
}

const truncateSnippet = (text: string, maxLen: number): string => {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + '…';
};

const FTS_SPECIAL_CHARS = /["\-^*():]/g;

const buildFtsQuery = (query: string): string | null => {
	const tokens = query
		.toLowerCase()
		.replace(FTS_SPECIAL_CHARS, ' ')
		.split(/\s+/)
		.filter(t => t.length >= 2);

	if (tokens.length === 0) return null;
	return tokens.map(t => `"${t}"*`).join(' OR ');
};

export const getRepoIntelligenceDbPath = (userDataPath: string): string => {
	return join(userDataPath, 'User', 'globalStorage', 'trove-repo-intelligence.db');
};
