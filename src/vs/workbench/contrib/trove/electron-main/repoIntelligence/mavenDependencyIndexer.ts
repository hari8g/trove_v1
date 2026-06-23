/*---------------------------------------------------------------------------
 * MavenDependencyIndexer — parses all pom.xml files in a workspace and builds
 * a dependency graph for shared library impact analysis.
 * Uses xml2js (already in package.json as ^0.5.0).
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { createRequire } from 'module';
import { join, relative } from 'path';
import { MavenDep } from './repoIntelligenceDb.js';

const require = createRequire(import.meta.url);
const { parseStringPromise } = require('xml2js') as {
	parseStringPromise: (xml: string, opts?: { explicitArray?: boolean }) => Promise<unknown>;
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'out', '.gradle']);

function findPomFiles(dir: string, results: string[] = [], depth = 0): string[] {
	if (depth > 6) return results;
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return results; }
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) findPomFiles(full, results, depth + 1);
		else if (entry === 'pom.xml') results.push(full);
	}
	return results;
}

function getStr(node: unknown): string {
	if (Array.isArray(node)) return String(node[0] ?? '');
	return String(node ?? '');
}

export type MavenIndexResult = {
	deps: MavenDep[];
	pomCount: number;
};

export async function indexMavenDependencies(workspaceRoot: string): Promise<MavenIndexResult> {
	const pomFiles = findPomFiles(workspaceRoot);
	const deps: MavenDep[] = [];

	for (const pomPath of pomFiles) {
		let content: string;
		try { content = readFileSync(pomPath, 'utf8'); } catch { continue; }

		let parsed: any;
		try { parsed = await parseStringPromise(content, { explicitArray: true }); }
		catch { continue; }

		const project = parsed?.project;
		if (!project) continue;

		const relPath = relative(workspaceRoot, pomPath);
		const dependenciesNode = project.dependencies?.[0]?.dependency ?? [];

		for (const dep of dependenciesNode) {
			const groupId = getStr(dep.groupId);
			const artifactId = getStr(dep.artifactId);
			if (!groupId || !artifactId) continue;

			deps.push({
				consumerPath: relPath,
				groupId,
				artifactId,
				version: getStr(dep.version) || undefined,
				scope: getStr(dep.scope) || undefined,
			});
		}

		const dmDeps = project.dependencyManagement?.[0]?.dependencies?.[0]?.dependency ?? [];
		for (const dep of dmDeps) {
			const groupId = getStr(dep.groupId);
			const artifactId = getStr(dep.artifactId);
			if (!groupId || !artifactId) continue;
			deps.push({
				consumerPath: relPath,
				groupId,
				artifactId,
				version: getStr(dep.version) || undefined,
				scope: 'management',
			});
		}
	}

	return { deps, pomCount: pomFiles.length };
}
