/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { timeout } from '../../../../base/common/async.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { computeDirectoryTree1Deep, IDirectoryStrService } from '../common/directoryStrService.js';
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, isBackgroundShellCommand, isDevServerCommand, stripBackgroundShellSuffix } from '../common/prompt/prompts.js';
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js';
import { ITroveSettingsService } from '../common/troveSettingsService.js';
import { ITroveModelService } from '../common/troveModelService.js';
import { BuiltinToolCallParams, BuiltinToolName, BuiltinToolResultType, LintErrorItem } from '../common/toolsServiceTypes.js';
import { IWebSearchService } from '../common/webSearchTypes.js';
import { StaasBuiltinToolCallHandlers } from '../extensions/staas/staasToolHandlers.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { ITerminalToolService } from './terminalToolService.js';
import { ITroveCommandBarService } from './troveCommandBarService.js';
import { errorEditDiagnostic, logEditDiagnostic, uriPathForLog } from './agentEditDiagnostics.js';

type CoreToolCallReturn<T extends BuiltinToolName> = Promise<{
	result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>;
	interruptTool?: () => void;
}>;

export type CoreBuiltinToolCallHandlers = {
	[T in Exclude<BuiltinToolName, keyof StaasBuiltinToolCallHandlers>]: (
		params: BuiltinToolCallParams[T],
	) => CoreToolCallReturn<T>;
};

export type CoreToolHandlerDeps = {
	fileService: IFileService;
	workspaceContextService: IWorkspaceContextService;
	searchService: ISearchService;
	queryBuilder: QueryBuilder;
	troveModelService: ITroveModelService;
	editCodeService: IEditCodeService;
	terminalToolService: ITerminalToolService;
	commandBarService: ITroveCommandBarService;
	directoryStrService: IDirectoryStrService;
	troveSettingsService: ITroveSettingsService;
	repoIntelligenceService: IRepoIntelligenceService;
	webSearchService: IWebSearchService;
	getLintErrors: (uri: URI) => { lintErrors: LintErrorItem[] | null };
};

export const createCoreBuiltinToolCallHandlers = (deps: CoreToolHandlerDeps): CoreBuiltinToolCallHandlers => ({
	read_file: async ({ uri, startLine, endLine, pageNumber }) => {
		await deps.troveModelService.initializeModel(uri);
		const { model } = await deps.troveModelService.getModelSafe(uri);
		if (model === null) { throw new Error(`No contents; File does not exist.`); }

		let contents: string;
		if (startLine === null && endLine === null) {
			contents = model.getValue(EndOfLinePreference.LF);
		} else {
			const startLineNumber = startLine === null ? 1 : startLine;
			const endLineNumber = endLine === null ? model.getLineCount() : endLine;
			contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF);
		}

		const totalNumLines = model.getLineCount();
		const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1);
		const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1;
		const fileContents = contents.slice(fromIdx, toIdx + 1);
		const hasNextPage = (contents.length - 1) - toIdx >= 1;
		const totalFileLen = contents.length;
		return { result: { fileContents, totalFileLen, hasNextPage, totalNumLines } };
	},

	ls_dir: async ({ uri, pageNumber }) => {
		const dirResult = await computeDirectoryTree1Deep(deps.fileService, uri, pageNumber);
		return { result: dirResult };
	},

	get_dir_tree: async ({ uri }) => {
		const str = await deps.directoryStrService.getDirectoryStrTool(uri);
		return { result: { str } };
	},

	search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {
		const query = deps.queryBuilder.file(deps.workspaceContextService.getWorkspace().folders.map(f => f.uri), {
			filePattern: queryStr,
			includePattern: includePattern ?? undefined,
			sortByScore: true,
		});
		const data = await deps.searchService.fileSearch(query, CancellationToken.None);

		const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1);
		const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1;
		const uris = data.results
			.slice(fromIdx, toIdx + 1)
			.map(({ resource }) => resource);

		const hasNextPage = (data.results.length - 1) - toIdx >= 1;
		return { result: { uris, hasNextPage } };
	},

	search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
		const searchFolders = searchInFolder === null
			? deps.workspaceContextService.getWorkspace().folders.map(f => f.uri)
			: [searchInFolder];

		const query = deps.queryBuilder.text({
			pattern: queryStr,
			isRegExp: isRegex,
		}, searchFolders);

		const data = await deps.searchService.textSearch(query, CancellationToken.None);

		const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1);
		const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1;
		const uris = data.results
			.slice(fromIdx, toIdx + 1)
			.map(({ resource }) => resource);

		const hasNextPage = (data.results.length - 1) - toIdx >= 1;
		return { result: { queryStr, uris, hasNextPage } };
	},

	search_codebase: async ({ query, maxResults }) => {
		const folders = deps.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			throw new Error('No workspace folder open.');
		}
		const workspaceRoot = folders[0].uri.fsPath;
		const useVec = deps.troveSettingsService.state.globalSettings.enableVectorSearch;
		const searchResults = useVec
			? await deps.repoIntelligenceService.searchCodebaseHybrid(workspaceRoot, query, maxResults)
			: await deps.repoIntelligenceService.searchCodebase(workspaceRoot, query, maxResults);
		const results = searchResults.map(r => ({
			filePath: r.filePath,
			startLine: r.startLine,
			endLine: r.endLine,
			snippet: r.snippet,
		}));
		return { result: { results, query } };
	},

	get_file_outline: async ({ uri }) => {
		const folders = deps.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			throw new Error('No workspace folder open.');
		}
		const workspaceRoot = folders[0].uri.fsPath;
		const symbols = await deps.repoIntelligenceService.getFileOutline(workspaceRoot, uri.fsPath);

		if (symbols.length === 0) {
			return {
				result: {
					outline: `No indexed symbols found in ${uri.fsPath}.\n` +
						`The file may not be indexed yet, or may use an unsupported language.\n` +
						`Try read_file instead, or wait for indexing to complete.`,
				},
			};
		}

		const lines = symbols.map(s => {
			const exportTag = s.isExported ? 'export ' : '       ';
			const range = `L${s.startLine}–${s.endLine}`.padEnd(12);
			const sig = (s.signature || `${s.kind} ${s.name}`).slice(0, 80);
			return `  ${range} ${exportTag}${s.kind.padEnd(10)} ${sig}`;
		});

		return {
			result: {
				outline: `File outline: ${uri.fsPath}\n${'─'.repeat(60)}\n${lines.join('\n')}`,
			},
		};
	},

	get_symbol: async ({ uri, symbolName }) => {
		const folders = deps.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			throw new Error('No workspace folder open.');
		}
		const workspaceRoot = folders[0].uri.fsPath;
		const sym = await deps.repoIntelligenceService.getSymbol(workspaceRoot, uri.fsPath, symbolName);

		if (!sym) {
			return {
				result: {
					error: `Symbol '${symbolName}' not found in ${uri.fsPath}.\n` +
						`Use get_file_outline to see all available symbols.`,
				},
			};
		}

		const fileContent = await deps.fileService.readFile(uri);
		const allLines = fileContent.value.toString().split('\n');
		const slice = allLines.slice(sym.startLine - 1, sym.endLine).join('\n');
		const header = sym.docstring ? `// ${sym.docstring}\n` : '';

		return {
			result: {
				source: `// ${uri.fsPath} — ${symbolName} (L${sym.startLine}–${sym.endLine})\n` +
					'```\n' + header + slice + '\n```',
				startLine: sym.startLine,
				endLine: sym.endLine,
			},
		};
	},

	search_symbols: async ({ query, maxResults }) => {
		const folders = deps.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			throw new Error('No workspace folder open.');
		}
		const workspaceRoot = folders[0].uri.fsPath;
		const found = await deps.repoIntelligenceService.searchSymbols(workspaceRoot, query, maxResults);

		if (found.length === 0) {
			return { result: { results: `No symbols found matching '${query}'.` } };
		}

		const lines = found.map(s =>
			`  ${s.kind.padEnd(10)} ${s.name.padEnd(30)} ` +
			`${s.filePath}:${s.startLine}` +
			(s.docstring ? `\n              ${s.docstring.slice(0, 80)}` : '')
		);
		return { result: { results: `Symbols matching '${query}' (${found.length}):\n${lines.join('\n')}` } };
	},

	search_web: async ({ query, maxResults }) => {
		const results = await deps.webSearchService.search(query, maxResults);
		return { result: { results, query } };
	},

	search_in_file: async ({ uri, query, isRegex }) => {
		await deps.troveModelService.initializeModel(uri);
		const { model } = await deps.troveModelService.getModelSafe(uri);
		if (model === null) { throw new Error(`No contents; File does not exist.`); }
		const contents = model.getValue(EndOfLinePreference.LF);
		const contentOfLine = contents.split('\n');
		const totalLines = contentOfLine.length;
		const regex = isRegex ? new RegExp(query) : null;
		const lines: number[] = [];
		for (let i = 0; i < totalLines; i++) {
			const line = contentOfLine[i];
			if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
				lines.push(i + 1);
			}
		}
		return { result: { lines } };
	},

	read_lint_errors: async ({ uri }) => {
		await timeout(1000);
		const { lintErrors } = deps.getLintErrors(uri);
		return { result: { lintErrors } };
	},

	create_file_or_folder: async ({ uri, isFolder }) => {
		if (isFolder) {
			await deps.fileService.createFolder(uri);
		} else {
			await deps.fileService.createFile(uri);
		}
		return { result: {} };
	},

	delete_file_or_folder: async ({ uri, isRecursive }) => {
		await deps.fileService.del(uri, { recursive: isRecursive });
		return { result: {} };
	},

	rewrite_file: async ({ uri, newContent }) => {
		logEditDiagnostic('tool_execute_start', { toolName: 'rewrite_file', uri: uriPathForLog(uri), contentLen: newContent.length });
		await deps.troveModelService.initializeModel(uri);
		if (deps.commandBarService.getStreamState(uri) === 'streaming') {
			errorEditDiagnostic('tool_execute_error', { toolName: 'rewrite_file', uri: uriPathForLog(uri), error: 'file already streaming' });
			throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`);
		}
		await deps.editCodeService.callBeforeApplyOrEdit(uri);
		deps.editCodeService.instantlyRewriteFile({ uri, newContent });
		const lintErrorsPromise = Promise.resolve().then(async () => {
			await timeout(2000);
			const { lintErrors } = deps.getLintErrors(uri);
			return { lintErrors };
		});
		return { result: lintErrorsPromise };
	},

	edit_file: async ({ uri, searchReplaceBlocks }) => {
		logEditDiagnostic('tool_execute_start', { toolName: 'edit_file', uri: uriPathForLog(uri), blocksLen: searchReplaceBlocks.length });
		await deps.troveModelService.initializeModel(uri);
		if (deps.commandBarService.getStreamState(uri) === 'streaming') {
			errorEditDiagnostic('tool_execute_error', { toolName: 'edit_file', uri: uriPathForLog(uri), error: 'file already streaming' });
			throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`);
		}
		await deps.editCodeService.callBeforeApplyOrEdit(uri);
		deps.editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks });

		const lintErrorsPromise = Promise.resolve().then(async () => {
			await timeout(2000);
			const { lintErrors } = deps.getLintErrors(uri);
			return { lintErrors };
		});

		return { result: lintErrorsPromise };
	},

	run_command: async ({ command, cwd, terminalId }) => {
		const workspaceRoot = deps.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? null;
		const resolvedCwd = cwd ?? workspaceRoot;
		if (isDevServerCommand(command) || isBackgroundShellCommand(command)) {
			const cleaned = stripBackgroundShellSuffix(command);
			const existingIds = deps.terminalToolService.listPersistentTerminalIds();
			const persistentTerminalId = existingIds[0] ?? await deps.terminalToolService.createPersistentTerminal({ cwd: resolvedCwd });
			const { resPromise, interrupt } = await deps.terminalToolService.runCommand(cleaned, { type: 'persistent', persistentTerminalId });
			return {
				result: resPromise.then(r => ({ ...r, autoPersistentTerminalId: persistentTerminalId })),
				interruptTool: interrupt,
			};
		}
		const { resPromise, interrupt } = await deps.terminalToolService.runCommand(command, { type: 'temporary', cwd: resolvedCwd, terminalId });
		return { result: resPromise, interruptTool: interrupt };
	},

	run_persistent_command: async ({ command, persistentTerminalId }) => {
		const { resPromise, interrupt } = await deps.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId });
		return { result: resPromise, interruptTool: interrupt };
	},

	open_persistent_terminal: async ({ cwd }) => {
		const existingIds = deps.terminalToolService.listPersistentTerminalIds();
		if (existingIds.length) {
			return { result: { persistentTerminalId: existingIds[0] } };
		}
		const persistentTerminalId = await deps.terminalToolService.createPersistentTerminal({ cwd });
		return { result: { persistentTerminalId } };
	},

	kill_persistent_terminal: async ({ persistentTerminalId }) => {
		await deps.terminalToolService.killPersistentTerminal(persistentTerminalId);
		return { result: {} };
	},

	get_import_graph: async ({ uri, direction }) => {
		const workspaceRoot = deps.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (!workspaceRoot) return { result: { imports: [], importedBy: [], externalDeps: [] } };
		const absPath = uri.fsPath;
		const relPath = absPath.startsWith(workspaceRoot)
			? absPath.slice(workspaceRoot.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
			: absPath.replace(/\\/g, '/');
		const result = await deps.repoIntelligenceService.getImportGraph(workspaceRoot, relPath, direction ?? 'both');
		return { result };
	},

	get_tests_for_file: async ({ uri }) => {
		const workspaceRoot = deps.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (!workspaceRoot) return { result: { tests: [] } };
		const absPath = uri.fsPath;
		const relPath = absPath.startsWith(workspaceRoot)
			? absPath.slice(workspaceRoot.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
			: absPath.replace(/\\/g, '/');
		const tests = await deps.repoIntelligenceService.getTestsForFile(workspaceRoot, relPath);
		return { result: { tests } };
	},

	get_recently_changed: async ({ limit }) => {
		const workspaceRoot = deps.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		if (!workspaceRoot) return { result: { files: [] } };
		const files = await deps.repoIntelligenceService.getGitRecentlyChanged(workspaceRoot, limit);
		return { result: { files } };
	},
});
