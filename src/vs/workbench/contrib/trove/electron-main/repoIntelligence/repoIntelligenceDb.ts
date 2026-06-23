/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { join } from 'path';
import type { Database } from '@vscode/sqlite3';
import { CommandEntry, CodeChunk, CodebaseSearchResult, ExtractedSymbol, FileMetadataEntry, FrameworkEntry, RepoIntelligenceIndexingStats, WorkspaceProfile } from '../../common/repoIntelligenceTypes.js';

const SCHEMA_VERSION = 5;

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

-- ── STaaS polyglot extensions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS java_spring_endpoints (
  workspace_hash    TEXT NOT NULL,
  service_name      TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  http_method       TEXT NOT NULL,
  path_pattern      TEXT NOT NULL,
  controller_class  TEXT NOT NULL,
  handler_method    TEXT NOT NULL,
  request_dto       TEXT,
  response_dto      TEXT,
  PRIMARY KEY (workspace_hash, service_name, http_method, path_pattern),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_endpoints_path ON java_spring_endpoints(workspace_hash, path_pattern);
CREATE INDEX IF NOT EXISTS idx_endpoints_service ON java_spring_endpoints(workspace_hash, service_name);

CREATE TABLE IF NOT EXISTS feign_clients (
  workspace_hash    TEXT NOT NULL,
  caller_service    TEXT NOT NULL,
  target_service    TEXT NOT NULL,
  interface_name    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, caller_service, target_service, interface_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_feign_caller ON feign_clients(workspace_hash, caller_service);
CREATE INDEX IF NOT EXISTS idx_feign_target ON feign_clients(workspace_hash, target_service);

CREATE TABLE IF NOT EXISTS maven_dependencies (
  workspace_hash    TEXT NOT NULL,
  consumer_path     TEXT NOT NULL,
  group_id          TEXT NOT NULL,
  artifact_id       TEXT NOT NULL,
  version           TEXT,
  scope             TEXT,
  PRIMARY KEY (workspace_hash, consumer_path, group_id, artifact_id),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_maven_artifact ON maven_dependencies(workspace_hash, artifact_id);
CREATE INDEX IF NOT EXISTS idx_maven_consumer ON maven_dependencies(workspace_hash, consumer_path);

CREATE TABLE IF NOT EXISTS k8s_resources (
  workspace_hash    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  name              TEXT NOT NULL,
  namespace         TEXT,
  env_label         TEXT,
  image_tag         TEXT,
  PRIMARY KEY (workspace_hash, file_path, kind, name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_k8s_kind ON k8s_resources(workspace_hash, kind);
CREATE INDEX IF NOT EXISTS idx_k8s_name ON k8s_resources(workspace_hash, name);

CREATE TABLE IF NOT EXISTS gateway_routes (
  workspace_hash    TEXT NOT NULL,
  route_id          TEXT NOT NULL,
  path_predicate    TEXT NOT NULL,
  target_service    TEXT NOT NULL,
  strip_prefix      INTEGER,
  PRIMARY KEY (workspace_hash, route_id),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routes_path ON gateway_routes(workspace_hash, path_predicate);

-- ── Phase β: NPM impact + config drift ─────────────────────────────────

CREATE TABLE IF NOT EXISTS npm_package_edges (
  workspace_hash  TEXT NOT NULL,
  consumer_path   TEXT NOT NULL,
  package_name    TEXT NOT NULL,
  version         TEXT,
  dep_type        TEXT,
  PRIMARY KEY (workspace_hash, consumer_path, package_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_npm_package ON npm_package_edges(workspace_hash, package_name);
CREATE INDEX IF NOT EXISTS idx_npm_consumer ON npm_package_edges(workspace_hash, consumer_path);

CREATE TABLE IF NOT EXISTS config_env_drift (
  workspace_hash    TEXT NOT NULL,
  service_name      TEXT NOT NULL,
  config_key        TEXT NOT NULL,
  env_values_json   TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, service_name, config_key),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drift_service ON config_env_drift(workspace_hash, service_name);

-- ── Phase γ: Terraform IaC + GitLab CI (persisted) ───────────────────────

CREATE TABLE IF NOT EXISTS terraform_resources (
  workspace_hash    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  resource_type     TEXT NOT NULL,
  resource_name     TEXT NOT NULL,
  provider          TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, file_path, resource_type, resource_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tf_resource_type ON terraform_resources(workspace_hash, resource_type);
CREATE INDEX IF NOT EXISTS idx_tf_provider ON terraform_resources(workspace_hash, provider);

CREATE TABLE IF NOT EXISTS terraform_modules (
  workspace_hash    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  module_name       TEXT NOT NULL,
  source            TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, file_path, module_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS terraform_index_meta (
  workspace_hash    TEXT PRIMARY KEY,
  file_count        INTEGER NOT NULL,
  providers_json    TEXT NOT NULL,
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pipeline_jobs (
  workspace_hash    TEXT NOT NULL,
  job_name          TEXT NOT NULL,
  stage             TEXT NOT NULL,
  needs_json        TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, job_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON pipeline_jobs(workspace_hash, stage);

CREATE TABLE IF NOT EXISTS pipeline_index_meta (
  workspace_hash    TEXT PRIMARY KEY,
  file_count        INTEGER NOT NULL,
  has_manual_gates  INTEGER NOT NULL,
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
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

export type SpringEndpoint = {
	serviceName: string;
	filePath: string;
	httpMethod: string;
	pathPattern: string;
	controllerClass: string;
	handlerMethod: string;
	requestDto?: string;
	responseDto?: string;
};

export type FeignClientEdge = {
	callerService: string;
	targetService: string;
	interfaceName: string;
	filePath: string;
};

export type MavenDep = {
	consumerPath: string;
	groupId: string;
	artifactId: string;
	version?: string;
	scope?: string;
};

export type GatewayRoute = {
	routeId: string;
	pathPredicate: string;
	targetService: string;
	stripPrefix: boolean;
};

export type K8sResource = {
	filePath: string;
	kind: string;
	name: string;
	namespace?: string;
	envLabel?: string;
	imageTag?: string;
};

export type NpmPackageEdge = {
	consumerPath: string;
	packageName: string;
	version: string;
	depType: 'dependencies' | 'devDependencies' | 'peerDependencies';
};

export type { EnvDrift } from './configEnvIndexer.js';
export type { TerraformResource, TerraformModule } from './terraformIndexer.js';
export type { PipelineJob } from './gitlabCiIndexer.js';

export type TerraformIndexMeta = {
	fileCount: number;
	providers: string[];
};

export type PipelineIndexMeta = {
	fileCount: number;
	hasManualGates: boolean;
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

		// v3 migration: STaaS polyglot tables
		await this._ensureTable(db, 'java_spring_endpoints',
			`CREATE TABLE IF NOT EXISTS java_spring_endpoints (
				workspace_hash TEXT NOT NULL, service_name TEXT NOT NULL,
				file_path TEXT NOT NULL, http_method TEXT NOT NULL, path_pattern TEXT NOT NULL,
				controller_class TEXT NOT NULL, handler_method TEXT NOT NULL,
				request_dto TEXT, response_dto TEXT,
				PRIMARY KEY (workspace_hash, service_name, http_method, path_pattern)
			)`);
		await this._ensureTable(db, 'feign_clients',
			`CREATE TABLE IF NOT EXISTS feign_clients (
				workspace_hash TEXT NOT NULL, caller_service TEXT NOT NULL,
				target_service TEXT NOT NULL, interface_name TEXT NOT NULL, file_path TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, caller_service, target_service, interface_name)
			)`);
		await this._ensureTable(db, 'maven_dependencies',
			`CREATE TABLE IF NOT EXISTS maven_dependencies (
				workspace_hash TEXT NOT NULL, consumer_path TEXT NOT NULL,
				group_id TEXT NOT NULL, artifact_id TEXT NOT NULL, version TEXT, scope TEXT,
				PRIMARY KEY (workspace_hash, consumer_path, group_id, artifact_id)
			)`);
		await this._ensureTable(db, 'k8s_resources',
			`CREATE TABLE IF NOT EXISTS k8s_resources (
				workspace_hash TEXT NOT NULL, file_path TEXT NOT NULL,
				kind TEXT NOT NULL, name TEXT NOT NULL, namespace TEXT,
				env_label TEXT, image_tag TEXT,
				PRIMARY KEY (workspace_hash, file_path, kind, name)
			)`);
		await this._ensureTable(db, 'gateway_routes',
			`CREATE TABLE IF NOT EXISTS gateway_routes (
				workspace_hash TEXT NOT NULL, route_id TEXT NOT NULL,
				path_predicate TEXT NOT NULL, target_service TEXT NOT NULL, strip_prefix INTEGER,
				PRIMARY KEY (workspace_hash, route_id)
			)`);
		await this._ensureTable(db, 'npm_package_edges',
			`CREATE TABLE IF NOT EXISTS npm_package_edges (
				workspace_hash TEXT NOT NULL, consumer_path TEXT NOT NULL,
				package_name TEXT NOT NULL, version TEXT, dep_type TEXT,
				PRIMARY KEY (workspace_hash, consumer_path, package_name)
			)`);
		await this._ensureTable(db, 'config_env_drift',
			`CREATE TABLE IF NOT EXISTS config_env_drift (
				workspace_hash TEXT NOT NULL, service_name TEXT NOT NULL,
				config_key TEXT NOT NULL, env_values_json TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, service_name, config_key)
			)`);
		await this._ensureTable(db, 'terraform_resources',
			`CREATE TABLE IF NOT EXISTS terraform_resources (
				workspace_hash TEXT NOT NULL, file_path TEXT NOT NULL,
				resource_type TEXT NOT NULL, resource_name TEXT NOT NULL, provider TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, file_path, resource_type, resource_name)
			)`);
		await this._ensureTable(db, 'terraform_modules',
			`CREATE TABLE IF NOT EXISTS terraform_modules (
				workspace_hash TEXT NOT NULL, file_path TEXT NOT NULL,
				module_name TEXT NOT NULL, source TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, file_path, module_name)
			)`);
		await this._ensureTable(db, 'terraform_index_meta',
			`CREATE TABLE IF NOT EXISTS terraform_index_meta (
				workspace_hash TEXT PRIMARY KEY, file_count INTEGER NOT NULL, providers_json TEXT NOT NULL
			)`);
		await this._ensureTable(db, 'pipeline_jobs',
			`CREATE TABLE IF NOT EXISTS pipeline_jobs (
				workspace_hash TEXT NOT NULL, job_name TEXT NOT NULL,
				stage TEXT NOT NULL, needs_json TEXT NOT NULL, file_path TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, job_name)
			)`);
		await this._ensureTable(db, 'pipeline_index_meta',
			`CREATE TABLE IF NOT EXISTS pipeline_index_meta (
				workspace_hash TEXT PRIMARY KEY, file_count INTEGER NOT NULL, has_manual_gates INTEGER NOT NULL
			)`);

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

	private async _ensureTable(db: Database, tableName: string, createSql: string): Promise<void> {
		const exists = await this._tableExists(db, tableName);
		if (!exists) {
			await this._exec(db, createSql);
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

	async getDistinctChunkFileCount(workspaceHash: string): Promise<number> {
		const row = await this._get<{ count: number }>(
			`SELECT COUNT(DISTINCT file_path) AS count FROM code_chunks WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return row?.count ?? 0;
	}

	async getIndexingStats(workspaceHash: string): Promise<RepoIntelligenceIndexingStats> {
		const countRow = async (sql: string): Promise<number> => {
			const row = await this._get<{ count: number }>(sql, [workspaceHash]);
			return row?.count ?? 0;
		};

		const groupedCounts = async (sql: string): Promise<Record<string, number>> => {
			const rows = await this._all<{ key: string; count: number }>(sql, [workspaceHash]);
			const result: Record<string, number> = {};
			for (const row of rows) {
				if (row.key) {
					result[row.key] = row.count;
				}
			}
			return result;
		};

		const [
			chunkCount,
			indexedFileCount,
			totalFileCount,
			indexableFileCount,
			symbolCount,
			symbolFileCount,
			chunksByType,
			filesByLanguage,
			chunksByLanguage,
			symbolsByLanguage,
			springEndpoints,
			feignClients,
			mavenDeps,
			k8sResources,
			gatewayRoutes,
			npmEdges,
			configDrift,
			terraformResources,
			pipelineJobs,
		] = await Promise.all([
			countRow(`SELECT COUNT(*) AS count FROM code_chunks WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(DISTINCT file_path) AS count FROM code_chunks WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM file_metadata WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM file_metadata WHERE workspace_hash = ? AND language IS NOT NULL AND language NOT IN ('Markdown', 'JSON', 'YAML', 'TOML', 'HTML', 'CSS', 'SCSS', 'Sass', 'Less')`),
			countRow(`SELECT COUNT(*) AS count FROM symbols WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(DISTINCT file_path) AS count FROM symbols WHERE workspace_hash = ?`),
			groupedCounts(`SELECT chunk_type AS key, COUNT(*) AS count FROM code_chunks WHERE workspace_hash = ? GROUP BY chunk_type`),
			groupedCounts(`SELECT COALESCE(language, 'Unknown') AS key, COUNT(*) AS count FROM file_metadata WHERE workspace_hash = ? GROUP BY language`),
			groupedCounts(
				`SELECT COALESCE(fm.language, 'Unknown') AS key, COUNT(*) AS count
				 FROM code_chunks cc
				 JOIN file_metadata fm ON fm.workspace_hash = cc.workspace_hash AND fm.file_path = cc.file_path
				 WHERE cc.workspace_hash = ?
				 GROUP BY fm.language`,
			),
			groupedCounts(
				`SELECT COALESCE(fm.language, 'Unknown') AS key, COUNT(*) AS count
				 FROM symbols s
				 JOIN file_metadata fm ON fm.workspace_hash = s.workspace_hash AND fm.file_path = s.file_path
				 WHERE s.workspace_hash = ?
				 GROUP BY fm.language`,
			),
			countRow(`SELECT COUNT(*) AS count FROM java_spring_endpoints WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM feign_clients WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM maven_dependencies WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM k8s_resources WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM gateway_routes WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM npm_package_edges WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM config_env_drift WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM terraform_resources WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM pipeline_jobs WHERE workspace_hash = ?`),
		]);

		return {
			chunkCount,
			indexedFileCount,
			totalFileCount,
			indexableFileCount,
			symbolCount,
			symbolFileCount,
			chunksByType,
			filesByLanguage,
			chunksByLanguage,
			symbolsByLanguage,
			springEndpoints,
			feignClients,
			mavenDeps,
			k8sResources,
			gatewayRoutes,
			npmEdges,
			configDrift,
			terraformResources,
			pipelineJobs,
			statsSource: 'database',
		};
	}

	async replaceChunks(workspaceHash: string, chunks: CodeChunk[]): Promise<void> {
		await this._run(`DELETE FROM code_chunks WHERE workspace_hash = ?`, [workspaceHash]);
		await this._run(`DELETE FROM chunks_fts WHERE workspace_hash = ?`, [workspaceHash]);

		if (chunks.length === 0) {
			return;
		}

		await this._run(`BEGIN IMMEDIATE`);
		try {
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
			await this._run(`COMMIT`);
		} catch (err) {
			await this._run(`ROLLBACK`).catch(() => { });
			throw err;
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

	// ── α methods ────────────────────────────────────────────────────────────

	async replaceSpringEndpoints(workspaceHash: string, endpoints: SpringEndpoint[]): Promise<void> {
		await this._run(`DELETE FROM java_spring_endpoints WHERE workspace_hash = ?`, [workspaceHash]);
		for (const ep of endpoints) {
			await this._run(
				`INSERT OR REPLACE INTO java_spring_endpoints
					(workspace_hash, service_name, file_path, http_method, path_pattern,
					 controller_class, handler_method, request_dto, response_dto)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[workspaceHash, ep.serviceName, ep.filePath, ep.httpMethod, ep.pathPattern,
					ep.controllerClass, ep.handlerMethod, ep.requestDto ?? null, ep.responseDto ?? null],
			);
		}
	}

	async getSpringEndpoints(workspaceHash: string): Promise<SpringEndpoint[]> {
		type Row = {
			service_name: string; file_path: string; http_method: string;
			path_pattern: string; controller_class: string; handler_method: string;
			request_dto: string | null; response_dto: string | null;
		};
		const rows = await this._all<Row>(
			`SELECT service_name, file_path, http_method, path_pattern,
					controller_class, handler_method, request_dto, response_dto
			 FROM java_spring_endpoints WHERE workspace_hash = ? ORDER BY path_pattern`,
			[workspaceHash],
		);
		return rows.map(r => ({
			serviceName: r.service_name, filePath: r.file_path, httpMethod: r.http_method,
			pathPattern: r.path_pattern, controllerClass: r.controller_class,
			handlerMethod: r.handler_method, requestDto: r.request_dto ?? undefined,
			responseDto: r.response_dto ?? undefined,
		}));
	}

	async replaceFeignClients(workspaceHash: string, clients: FeignClientEdge[]): Promise<void> {
		await this._run(`DELETE FROM feign_clients WHERE workspace_hash = ?`, [workspaceHash]);
		for (const c of clients) {
			await this._run(
				`INSERT OR REPLACE INTO feign_clients
					(workspace_hash, caller_service, target_service, interface_name, file_path)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, c.callerService, c.targetService, c.interfaceName, c.filePath],
			);
		}
	}

	async getFeignClients(workspaceHash: string): Promise<FeignClientEdge[]> {
		type Row = { caller_service: string; target_service: string; interface_name: string; file_path: string };
		const rows = await this._all<Row>(
			`SELECT caller_service, target_service, interface_name, file_path
			 FROM feign_clients WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			callerService: r.caller_service, targetService: r.target_service,
			interfaceName: r.interface_name, filePath: r.file_path,
		}));
	}

	async replaceMavenDependencies(workspaceHash: string, deps: MavenDep[]): Promise<void> {
		await this._run(`DELETE FROM maven_dependencies WHERE workspace_hash = ?`, [workspaceHash]);
		for (const d of deps) {
			await this._run(
				`INSERT OR REPLACE INTO maven_dependencies
					(workspace_hash, consumer_path, group_id, artifact_id, version, scope)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[workspaceHash, d.consumerPath, d.groupId, d.artifactId, d.version ?? null, d.scope ?? null],
			);
		}
	}

	async getMavenConsumers(workspaceHash: string, artifactId: string): Promise<MavenDep[]> {
		type Row = { consumer_path: string; group_id: string; artifact_id: string; version: string | null; scope: string | null };
		const rows = await this._all<Row>(
			`SELECT consumer_path, group_id, artifact_id, version, scope
			 FROM maven_dependencies WHERE workspace_hash = ? AND artifact_id = ?`,
			[workspaceHash, artifactId],
		);
		return rows.map(r => ({
			consumerPath: r.consumer_path, groupId: r.group_id, artifactId: r.artifact_id,
			version: r.version ?? undefined, scope: r.scope ?? undefined,
		}));
	}

	async getAllMavenDependencies(workspaceHash: string): Promise<MavenDep[]> {
		type Row = { consumer_path: string; group_id: string; artifact_id: string; version: string | null; scope: string | null };
		const rows = await this._all<Row>(
			`SELECT consumer_path, group_id, artifact_id, version, scope
			 FROM maven_dependencies WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			consumerPath: r.consumer_path, groupId: r.group_id, artifactId: r.artifact_id,
			version: r.version ?? undefined, scope: r.scope ?? undefined,
		}));
	}

	async replaceGatewayRoutes(workspaceHash: string, routes: GatewayRoute[]): Promise<void> {
		await this._run(`DELETE FROM gateway_routes WHERE workspace_hash = ?`, [workspaceHash]);
		for (const r of routes) {
			await this._run(
				`INSERT OR REPLACE INTO gateway_routes
					(workspace_hash, route_id, path_predicate, target_service, strip_prefix)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, r.routeId, r.pathPredicate, r.targetService, r.stripPrefix ? 1 : 0],
			);
		}
	}

	async getGatewayRoutes(workspaceHash: string): Promise<GatewayRoute[]> {
		type Row = { route_id: string; path_predicate: string; target_service: string; strip_prefix: number };
		const rows = await this._all<Row>(
			`SELECT route_id, path_predicate, target_service, strip_prefix
			 FROM gateway_routes WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			routeId: r.route_id, pathPredicate: r.path_predicate,
			targetService: r.target_service, stripPrefix: r.strip_prefix === 1,
		}));
	}

	async replaceK8sResources(workspaceHash: string, resources: K8sResource[]): Promise<void> {
		await this._run(`DELETE FROM k8s_resources WHERE workspace_hash = ?`, [workspaceHash]);
		for (const r of resources) {
			await this._run(
				`INSERT OR REPLACE INTO k8s_resources
					(workspace_hash, file_path, kind, name, namespace, env_label, image_tag)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[workspaceHash, r.filePath, r.kind, r.name,
					r.namespace ?? null, r.envLabel ?? null, r.imageTag ?? null],
			);
		}
	}

	async getK8sResources(workspaceHash: string): Promise<K8sResource[]> {
		type Row = { file_path: string; kind: string; name: string; namespace: string | null; env_label: string | null; image_tag: string | null };
		const rows = await this._all<Row>(
			`SELECT file_path, kind, name, namespace, env_label, image_tag
			 FROM k8s_resources WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			filePath: r.file_path, kind: r.kind, name: r.name,
			namespace: r.namespace ?? undefined, envLabel: r.env_label ?? undefined,
			imageTag: r.image_tag ?? undefined,
		}));
	}

	// ── β methods ─────────────────────────────────────────────────────────────

	async replaceNpmEdges(workspaceHash: string, edges: NpmPackageEdge[]): Promise<void> {
		await this._run(`DELETE FROM npm_package_edges WHERE workspace_hash = ?`, [workspaceHash]);
		for (const e of edges) {
			await this._run(
				`INSERT OR REPLACE INTO npm_package_edges
					(workspace_hash, consumer_path, package_name, version, dep_type)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, e.consumerPath, e.packageName, e.version, e.depType],
			);
		}
	}

	async getNpmConsumers(workspaceHash: string, packageName: string): Promise<string[]> {
		type Row = { consumer_path: string };
		const rows = await this._all<Row>(
			`SELECT DISTINCT consumer_path FROM npm_package_edges
			 WHERE workspace_hash = ? AND package_name = ?`,
			[workspaceHash, packageName],
		);
		return rows.map(r => r.consumer_path);
	}

	async getAllNpmEdges(workspaceHash: string): Promise<NpmPackageEdge[]> {
		type Row = { consumer_path: string; package_name: string; version: string | null; dep_type: string };
		const rows = await this._all<Row>(
			`SELECT consumer_path, package_name, version, dep_type FROM npm_package_edges WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			consumerPath: r.consumer_path,
			packageName: r.package_name,
			version: r.version ?? '',
			depType: r.dep_type as NpmPackageEdge['depType'],
		}));
	}

	async replaceConfigDrift(workspaceHash: string, drifts: import('./configEnvIndexer.js').EnvDrift[]): Promise<void> {
		await this._run(`DELETE FROM config_env_drift WHERE workspace_hash = ?`, [workspaceHash]);
		for (const d of drifts) {
			await this._run(
				`INSERT OR REPLACE INTO config_env_drift
					(workspace_hash, service_name, config_key, env_values_json)
				 VALUES (?, ?, ?, ?)`,
				[workspaceHash, d.serviceName, d.key, JSON.stringify(d.envValues)],
			);
		}
	}

	async getConfigDriftForService(
		workspaceHash: string,
		serviceName: string,
	): Promise<{ key: string; serviceName: string; envValues: Record<string, string> }[]> {
		type Row = { service_name: string; config_key: string; env_values_json: string };
		const rows = await this._all<Row>(
			`SELECT service_name, config_key, env_values_json
			 FROM config_env_drift WHERE workspace_hash = ? AND service_name = ?
			 ORDER BY config_key`,
			[workspaceHash, serviceName],
		);
		return rows.map(r => ({
			key: r.config_key,
			serviceName: r.service_name,
			envValues: JSON.parse(r.env_values_json) as Record<string, string>,
		}));
	}

	async getConfigDriftStats(workspaceHash: string): Promise<{ driftCount: number; topDriftedServices: string[] }> {
		type Row = { service_name: string };
		const rows = await this._all<Row>(
			`SELECT DISTINCT service_name FROM config_env_drift WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		const countRow = await this._get<{ count: number }>(
			`SELECT COUNT(*) AS count FROM config_env_drift WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return {
			driftCount: countRow?.count ?? 0,
			topDriftedServices: rows.map(r => r.service_name).slice(0, 5),
		};
	}

	// ── γ methods (Terraform + GitLab CI) ─────────────────────────────────────

	async replaceTerraformIndex(
		workspaceHash: string,
		result: import('./terraformIndexer.js').TerraformIndexResult,
	): Promise<void> {
		await this._run(`DELETE FROM terraform_resources WHERE workspace_hash = ?`, [workspaceHash]);
		await this._run(`DELETE FROM terraform_modules WHERE workspace_hash = ?`, [workspaceHash]);
		await this._run(`DELETE FROM terraform_index_meta WHERE workspace_hash = ?`, [workspaceHash]);

		for (const r of result.resources) {
			await this._run(
				`INSERT OR REPLACE INTO terraform_resources
					(workspace_hash, file_path, resource_type, resource_name, provider)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, r.filePath, r.resourceType, r.resourceName, r.provider],
			);
		}
		for (const m of result.modules) {
			await this._run(
				`INSERT OR REPLACE INTO terraform_modules
					(workspace_hash, file_path, module_name, source)
				 VALUES (?, ?, ?, ?)`,
				[workspaceHash, m.filePath, m.moduleName, m.source],
			);
		}
		if (result.fileCount > 0 || result.resources.length > 0 || result.modules.length > 0) {
			await this._run(
				`INSERT OR REPLACE INTO terraform_index_meta (workspace_hash, file_count, providers_json)
				 VALUES (?, ?, ?)`,
				[workspaceHash, result.fileCount, JSON.stringify(result.providers)],
			);
		}
	}

	async getTerraformResources(workspaceHash: string): Promise<import('./terraformIndexer.js').TerraformResource[]> {
		type Row = { file_path: string; resource_type: string; resource_name: string; provider: string };
		const rows = await this._all<Row>(
			`SELECT file_path, resource_type, resource_name, provider
			 FROM terraform_resources WHERE workspace_hash = ? ORDER BY resource_type, resource_name`,
			[workspaceHash],
		);
		return rows.map(r => ({
			filePath: r.file_path,
			resourceType: r.resource_type,
			resourceName: r.resource_name,
			provider: r.provider,
		}));
	}

	async getTerraformModules(workspaceHash: string): Promise<import('./terraformIndexer.js').TerraformModule[]> {
		type Row = { file_path: string; module_name: string; source: string };
		const rows = await this._all<Row>(
			`SELECT file_path, module_name, source FROM terraform_modules WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({ filePath: r.file_path, moduleName: r.module_name, source: r.source }));
	}

	async getTerraformIndexMeta(workspaceHash: string): Promise<TerraformIndexMeta | null> {
		const row = await this._get<{ file_count: number; providers_json: string }>(
			`SELECT file_count, providers_json FROM terraform_index_meta WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		if (!row) return null;
		return {
			fileCount: row.file_count,
			providers: JSON.parse(row.providers_json) as string[],
		};
	}

	async replacePipelineIndex(
		workspaceHash: string,
		result: import('./gitlabCiIndexer.js').PipelineIndexResult,
	): Promise<void> {
		await this._run(`DELETE FROM pipeline_jobs WHERE workspace_hash = ?`, [workspaceHash]);
		await this._run(`DELETE FROM pipeline_index_meta WHERE workspace_hash = ?`, [workspaceHash]);

		for (const job of result.jobs) {
			await this._run(
				`INSERT OR REPLACE INTO pipeline_jobs
					(workspace_hash, job_name, stage, needs_json, file_path)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, job.name, job.stage, JSON.stringify(job.needs), job.filePath],
			);
		}
		if (result.fileCount > 0 || result.jobs.length > 0) {
			await this._run(
				`INSERT OR REPLACE INTO pipeline_index_meta (workspace_hash, file_count, has_manual_gates)
				 VALUES (?, ?, ?)`,
				[workspaceHash, result.fileCount, result.hasManualGates ? 1 : 0],
			);
		}
	}

	async getPipelineJobs(workspaceHash: string): Promise<import('./gitlabCiIndexer.js').PipelineJob[]> {
		type Row = { job_name: string; stage: string; needs_json: string; file_path: string };
		const rows = await this._all<Row>(
			`SELECT job_name, stage, needs_json, file_path FROM pipeline_jobs WHERE workspace_hash = ? ORDER BY stage, job_name`,
			[workspaceHash],
		);
		return rows.map(r => ({
			name: r.job_name,
			stage: r.stage,
			needs: JSON.parse(r.needs_json) as string[],
			filePath: r.file_path,
		}));
	}

	async getPipelineIndexMeta(workspaceHash: string): Promise<PipelineIndexMeta | null> {
		const row = await this._get<{ file_count: number; has_manual_gates: number }>(
			`SELECT file_count, has_manual_gates FROM pipeline_index_meta WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		if (!row) return null;
		return { fileCount: row.file_count, hasManualGates: row.has_manual_gates === 1 };
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
