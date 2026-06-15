/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { join } from 'path';
import type { Database } from '@vscode/sqlite3';
import { CommandEntry, FileMetadataEntry, FrameworkEntry, WorkspaceProfile } from '../../common/repoIntelligenceTypes.js';

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
`;

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
}

export const getRepoIntelligenceDbPath = (userDataPath: string): string => {
	return join(userDataPath, 'User', 'globalStorage', 'trove-repo-intelligence.db');
};
