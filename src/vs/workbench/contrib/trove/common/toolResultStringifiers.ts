/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { stringifyDirectoryTree1Deep } from './directoryStrService.js';
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from './toolsServiceTypes.js';

export type BuiltinToolResultToString = {
	[T in BuiltinToolName]: (
		p: BuiltinToolCallParams[T],
		result: Awaited<BuiltinToolResultType[T]>,
	) => string;
};

const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : '';

export const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
	return lintErrors
		.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
		.join('\n\n');
};

export type ToolResultStringifierDeps = {
	getModelLineContent: (uri: URI, line: number) => string | null;
	stringifyDirectoryTree: typeof stringifyDirectoryTree1Deep;
	formatEditSuccess: (uri: URI, lintErrors: LintErrorItem[] | null | undefined) => string;
	formatCreateSuccess: (uri: URI, isFolder: boolean) => string;
	formatRunCommandResult: (
		params: BuiltinToolCallParams['run_command'],
		result: Awaited<BuiltinToolResultType['run_command']>,
	) => string;
	formatRunPersistentCommandResult: (
		params: BuiltinToolCallParams['run_persistent_command'],
		result: Awaited<BuiltinToolResultType['run_persistent_command']>,
	) => string;
};

export const createBuiltinToolResultStringifiers = (deps: ToolResultStringifierDeps): BuiltinToolResultToString => ({
	read_file: (params, result) => {
		return `${params.uri.fsPath}\n\`\`\`\n${result.fileContents}\n\`\`\`${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info because truncated: this file has ${result.totalNumLines} lines, or ${result.totalFileLen} characters.` : ''}`;
	},
	ls_dir: (params, result) => deps.stringifyDirectoryTree(params, result),
	get_dir_tree: (_params, result) => result.str,
	search_pathnames_only: (_params, result) => {
		return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage);
	},
	search_for_files: (_params, result) => {
		return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage);
	},
	search_codebase: (_params, result) => {
		if (result.results.length === 0) {
			return `No codebase matches found for query: "${result.query}".`;
		}
		const lines = result.results.map((r, i) => {
			return `${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine}\n\`\`\`\n${r.snippet}\n\`\`\``;
		});
		return `Codebase search results for "${result.query}" (${result.results.length} matches):\n\n${lines.join('\n\n')}`;
	},
	get_file_outline: (_params, result) => result.outline,
	get_symbol: (_params, result) => result.error ? result.error : (result.source ?? ''),
	search_symbols: (_params, result) => result.results,
	search_web: (_params, result) => {
		if (result.results.length === 0) {
			return `No web results found for query: "${result.query}".`;
		}
		const lines = result.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
		return `Web search results for "${result.query}" (${result.results.length} matches):\n\n${lines.join('\n\n')}`;
	},
	search_in_file: (params, result) => {
		const lines = result.lines.map(n => {
			const lineContent = deps.getModelLineContent(params.uri, n);
			if (lineContent === null) {
				return `<Error getting string of result>`;
			}
			return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``;
		}).join('\n\n');
		return lines;
	},
	read_lint_errors: (_params, result) => {
		return result.lintErrors ? stringifyLintErrors(result.lintErrors) : 'No lint errors found.';
	},
	delete_file_or_folder: (params, _result) => `URI ${params.uri.fsPath} successfully deleted.`,
	edit_file: (params, result) => deps.formatEditSuccess(params.uri, result.lintErrors),
	rewrite_file: (params, result) => deps.formatEditSuccess(params.uri, result.lintErrors),
	create_file_or_folder: (params, _result) => deps.formatCreateSuccess(params.uri, params.isFolder),
	run_command: deps.formatRunCommandResult,
	run_persistent_command: deps.formatRunPersistentCommandResult,
	open_persistent_terminal: (_params, result) => {
		const { persistentTerminalId } = result;
		return `Persistent terminal ready. persistentTerminalId="${persistentTerminalId}". Reuse this ID — do NOT open another. Prefer run_command with the Start script from repository_context (auto-routes to persistent terminal).`;
	},
	kill_persistent_terminal: (params, _result) => `Successfully closed terminal "${params.persistentTerminalId}".`,
	query_service_topology: (_params, result) => result.summary,
	resolve_api_contract: (_params, result) => result.contract,
	get_maven_impact: (_params, result) => {
		const { consumers, impactLevel } = result;
		if (consumers.length === 0) {
			return 'No consumers found for this artifact.';
		}
		return `Impact level: ${impactLevel.toUpperCase()} — ${consumers.length} consumer(s):\n${consumers.join('\n')}`;
	},
	get_npm_impact: (_params, result) => {
		if (result.consumers.length === 0) {
			return `No consumers found for this package.`;
		}
		return `Impact: ${result.impactLevel.toUpperCase()} — ${result.consumers.length} consumer(s):\n${result.consumers.join('\n')}`;
	},
	get_config_drift: (_params, result) => result.summary,
	get_import_graph: (params, result) => {
		const lines: string[] = [`Import graph for ${params.uri.fsPath}:`];
		if (result.imports.length > 0) {
			lines.push(`  Imports (${result.imports.length}):\n    ${result.imports.join('\n    ')}`);
		}
		if (result.importedBy.length > 0) {
			lines.push(`  Imported by (${result.importedBy.length}):\n    ${result.importedBy.join('\n    ')}`);
		}
		if (result.externalDeps.length > 0) {
			lines.push(`  External deps: ${result.externalDeps.join(', ')}`);
		}
		if (result.imports.length === 0 && result.importedBy.length === 0) {
			lines.push('  No import edges found (index may not be built yet — run refresh).');
		}
		return lines.join('\n');
	},
	get_tests_for_file: (params, result) => {
		if (result.tests.length === 0) {
			return `No test files found covering ${params.uri.fsPath}.`;
		}
		const lines = [`Tests covering ${params.uri.fsPath} (${result.tests.length} found):`];
		for (const t of result.tests) {
			lines.push(`  [${t.confidence}] ${t.testFile}`);
		}
		return lines.join('\n');
	},
	get_recently_changed: (_params, result) => {
		if (result.files.length === 0) {
			return 'No recently changed files found (not a git repo, or no commit history).';
		}
		const lines = ['Recently changed files (by commit frequency):'];
		for (const f of result.files) {
			lines.push(`  ${f.file} — ${f.changeCount} changes, last: ${f.lastChanged}`);
		}
		return lines.join('\n');
	},
	verify_security_compliance: (_params, result) => {
		if (result.violations.length === 0) {
			return result.summary;
		}
		const lines = [result.summary, ''];
		for (const v of result.violations) {
			lines.push(`[${v.severity.toUpperCase()}] ${v.rule}: ${v.message}`);
		}
		return lines.join('\n');
	},
});
