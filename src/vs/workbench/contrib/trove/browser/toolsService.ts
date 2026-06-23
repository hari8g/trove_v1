import { CancellationToken } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js'
import { ITroveModelService } from '../common/troveModelService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { ITroveCommandBarService } from './troveCommandBarService.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { timeout } from '../../../../base/common/async.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_COMMAND_TIME, getTerminalInactiveTimeoutSeconds, isDevServerCommand, isBackgroundShellCommand, isPackageInstallCommand, packageInstallLooksSuccessful, stripBackgroundShellSuffix } from '../common/prompt/prompts.js'
import { ITroveSettingsService } from '../common/troveSettingsService.js'
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js'
import { IWebSearchService } from '../common/webSearchTypes.js'
import { buildVerificationReminder } from '../common/prompt/prompts.js'
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { errorEditDiagnostic, logEditDiagnostic, uriPathForLog } from './agentEditDiagnostics.js'


// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}


// We are NOT checking to make sure in workspace
const validateURI = (uriStr: unknown) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (uriStr.includes('://')) {
		try {
			const uri = URI.parse(uriStr)
			return uri
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`)
		}
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		const uri = URI.file(uriStr)
		return uri
	}
}

const validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITroveModelService troveModelService: ITroveModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@ITroveCommandBarService private readonly commandBarService: ITroveCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ITroveSettingsService private readonly troveSettingsService: ITroveSettingsService,
		@IRepoIntelligenceService private readonly repoIntelligenceService: IRepoIntelligenceService,
		@IWebSearchService private readonly webSearchService: IWebSearchService,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		this.validateParams = {
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_codebase: (params: RawToolParamsObj) => {
				const { query: queryUnknown, max_results: maxResultsUnknown } = params
				const query = validateStr('query', queryUnknown)
				const maxResults = validateNumber(maxResultsUnknown, { default: 10 }) ?? 10
				return { query, maxResults: Math.min(Math.max(maxResults, 1), 50) }
			},
			get_file_outline: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},
			get_symbol: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, symbol_name: symbolNameUnknown } = params
				const uri = validateURI(uriUnknown)
				const symbolName = validateStr('symbolName', symbolNameUnknown)
				return { uri, symbolName }
			},
			search_symbols: (params: RawToolParamsObj) => {
				const { query: queryUnknown, max_results: maxResultsUnknown } = params
				const query = validateStr('query', queryUnknown)
				const maxResults = validateNumber(maxResultsUnknown, { default: 15 }) ?? 15
				return { query, maxResults: Math.min(Math.max(maxResults, 1), 50) }
			},
			search_web: (params: RawToolParamsObj) => {
				const { query: queryUnknown, max_results: maxResultsUnknown } = params
				const query = validateStr('query', queryUnknown)
				const maxResults = validateNumber(maxResultsUnknown, { default: 5 }) ?? 5
				return { query, maxResults: Math.min(Math.max(maxResults, 1), 10) }
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURI(uriStr)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

			query_service_topology: (params: RawToolParamsObj) => {
				const query = validateStr('query', params.query);
				return { query };
			},
			resolve_api_contract: (params: RawToolParamsObj) => {
				const httpMethod = validateStr('httpMethod', params.http_method ?? params.httpMethod);
				const pathPattern = validateStr('pathPattern', params.path_pattern ?? params.pathPattern);
				return { httpMethod, pathPattern };
			},
			get_maven_impact: (params: RawToolParamsObj) => {
				const artifactId = validateStr('artifactId', params.artifact_id ?? params.artifactId);
				return { artifactId };
			},
			get_npm_impact: (params: RawToolParamsObj) => ({
				packageName: validateStr('packageName', params.package_name ?? params.packageName),
			}),
			get_config_drift: (params: RawToolParamsObj) => ({
				serviceName: validateStr('serviceName', params.service_name ?? params.serviceName),
			}),
			verify_security_compliance: (params: RawToolParamsObj) => ({
				code: validateStr('code', params.code),
				fileExtension: validateStr('fileExtension', params.file_extension ?? params.fileExtension),
			}),

		}


		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				await troveModelService.initializeModel(uri)
				const { model } = await troveModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; File does not exist.`) }

				let contents: string
				if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
				}
				else {
					const startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? model.getLineCount() : endLine
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
				}

				const totalNumLines = model.getLineCount()

				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				const fileContents = contents.slice(fromIdx, toIdx + 1) // paginate
				const hasNextPage = (contents.length - 1) - toIdx >= 1
				const totalFileLen = contents.length
				return { result: { fileContents, totalFileLen, hasNextPage, totalNumLines } }
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders)

				const data = await searchService.textSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { queryStr, uris, hasNextPage } }
			},
			search_codebase: async ({ query, maxResults }) => {
				const folders = workspaceContextService.getWorkspace().folders
				if (folders.length === 0) {
					throw new Error('No workspace folder open.')
				}
				const workspaceRoot = folders[0].uri.fsPath
				const searchResults = await this.repoIntelligenceService.searchCodebase(workspaceRoot, query, maxResults)
				const results = searchResults.map(r => ({
					filePath: r.filePath,
					startLine: r.startLine,
					endLine: r.endLine,
					snippet: r.snippet,
				}))
				return { result: { results, query } }
			},
			get_file_outline: async ({ uri }) => {
				const folders = workspaceContextService.getWorkspace().folders
				if (folders.length === 0) {
					throw new Error('No workspace folder open.')
				}
				const workspaceRoot = folders[0].uri.fsPath
				const symbols = await this.repoIntelligenceService.getFileOutline(workspaceRoot, uri.fsPath)

				if (symbols.length === 0) {
					return {
						result: {
							outline: `No indexed symbols found in ${uri.fsPath}.\n` +
								`The file may not be indexed yet, or may use an unsupported language.\n` +
								`Try read_file instead, or wait for indexing to complete.`,
						},
					}
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
				}
			},
			get_symbol: async ({ uri, symbolName }) => {
				const folders = workspaceContextService.getWorkspace().folders
				if (folders.length === 0) {
					throw new Error('No workspace folder open.')
				}
				const workspaceRoot = folders[0].uri.fsPath
				const sym = await this.repoIntelligenceService.getSymbol(workspaceRoot, uri.fsPath, symbolName)

				if (!sym) {
					return {
						result: {
							error: `Symbol '${symbolName}' not found in ${uri.fsPath}.\n` +
								`Use get_file_outline to see all available symbols.`,
						},
					}
				}

				const fileContent = await fileService.readFile(uri)
				const allLines = fileContent.value.toString().split('\n')
				const slice = allLines.slice(sym.startLine - 1, sym.endLine).join('\n')
				const header = sym.docstring ? `// ${sym.docstring}\n` : ''

				return {
					result: {
						source: `// ${uri.fsPath} — ${symbolName} (L${sym.startLine}–${sym.endLine})\n` +
							'```\n' + header + slice + '\n```',
						startLine: sym.startLine,
						endLine: sym.endLine,
					},
				}
			},
			search_symbols: async ({ query, maxResults }) => {
				const folders = workspaceContextService.getWorkspace().folders
				if (folders.length === 0) {
					throw new Error('No workspace folder open.')
				}
				const workspaceRoot = folders[0].uri.fsPath
				const found = await this.repoIntelligenceService.searchSymbols(workspaceRoot, query, maxResults)

				if (found.length === 0) {
					return { result: { results: `No symbols found matching '${query}'.` } }
				}

				const lines = found.map(s =>
					`  ${s.kind.padEnd(10)} ${s.name.padEnd(30)} ` +
					`${s.filePath}:${s.startLine}` +
					(s.docstring ? `\n              ${s.docstring.slice(0, 80)}` : '')
				)
				return { result: { results: `Symbols matching '${query}' (${found.length}):\n${lines.join('\n')}` } }
			},
			search_web: async ({ query, maxResults }) => {
				const results = await this.webSearchService.search(query, maxResults)
				return { result: { results, query } }
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				await troveModelService.initializeModel(uri);
				const { model } = await troveModelService.getModelSafe(uri);
				if (model === null) { throw new Error(`No contents; File does not exist.`); }
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }) => {
				logEditDiagnostic('tool_execute_start', { toolName: 'rewrite_file', uri: uriPathForLog(uri), contentLen: newContent.length })
				await troveModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					errorEditDiagnostic('tool_execute_error', { toolName: 'rewrite_file', uri: uriPathForLog(uri), error: 'file already streaming' })
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})
				return { result: lintErrorsPromise }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				logEditDiagnostic('tool_execute_start', { toolName: 'edit_file', uri: uriPathForLog(uri), blocksLen: searchReplaceBlocks.length })
				await troveModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					errorEditDiagnostic('tool_execute_error', { toolName: 'edit_file', uri: uriPathForLog(uri), error: 'file already streaming' })
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks })

				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})

				return { result: lintErrorsPromise }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? null
				const resolvedCwd = cwd ?? workspaceRoot
				// Dev servers and `cmd &` must not use a temporary terminal — it is disposed after the tool returns and kills background jobs.
				if (isDevServerCommand(command) || isBackgroundShellCommand(command)) {
					const cleaned = stripBackgroundShellSuffix(command)
					const existingIds = this.terminalToolService.listPersistentTerminalIds()
					const persistentTerminalId = existingIds[0] ?? await this.terminalToolService.createPersistentTerminal({ cwd: resolvedCwd })
					const { resPromise, interrupt } = await this.terminalToolService.runCommand(cleaned, { type: 'persistent', persistentTerminalId })
					return {
						result: resPromise.then(r => ({ ...r, autoPersistentTerminalId: persistentTerminalId })),
						interruptTool: interrupt,
					}
				}
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd: resolvedCwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const existingIds = this.terminalToolService.listPersistentTerminalIds()
				if (existingIds.length) {
					return { result: { persistentTerminalId: existingIds[0] } }
				}
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},

			query_service_topology: async ({ query }) => {
				const profile = this.repoIntelligenceService.getProfileSync();
				const topo = profile?.serviceTopologySummary;
				if (!topo) {
					return { result: { summary: 'No Spring Boot services detected in this workspace. Ensure pom.xml files with spring-boot dependency exist.' } };
				}
				const queryLower = query.toLowerCase();
				let summary = `Service Topology — ${topo.serviceCount} services, ${topo.totalEndpoints} endpoints\n\n`;

				if (queryLower.includes('gateway') || queryLower.includes('route')) {
					summary += `Gateway Routes:\n${topo.gatewayRoutes.map(r => `  ${r.pathPattern} → ${r.targetService}`).join('\n')}`;
				} else if (queryLower.includes('feign') || queryLower.includes('call') || queryLower.includes('depend')) {
					summary += `Feign Dependencies:\n${topo.feignEdges.map(e => `  ${e.caller} calls: ${e.targets.join(', ')}`).join('\n')}`;
				} else {
					summary += `Services: ${topo.serviceNames.join(', ')}\n\n`;
					summary += `Gateway Routes:\n${topo.gatewayRoutes.slice(0, 10).map(r => `  ${r.pathPattern} → ${r.targetService}`).join('\n')}`;
				}
				return { result: { summary } };
			},

			resolve_api_contract: async ({ httpMethod, pathPattern }) => {
				const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
				if (!workspaceRoot) return { result: { contract: 'No workspace open.' } };

				const contract = await this.repoIntelligenceService.resolveApiContract(workspaceRoot, httpMethod, pathPattern);
				if (!contract) {
					return { result: { contract: `No endpoint found for ${httpMethod} ${pathPattern}. Check that the workspace has been indexed.` } };
				}

				const lines = [
					`API Contract: ${contract.httpMethod} ${contract.pathPattern}`,
					`Backend service: ${contract.backendService}`,
					`Controller: ${contract.controllerClass}.${contract.handlerMethod}()`,
					`File: ${contract.filePath}`,
				];
				if (contract.requestDto) lines.push(`@RequestBody: ${contract.requestDto}`);
				if (contract.responseDto) lines.push(`Response type: ${contract.responseDto}`);

				return { result: { contract: lines.join('\n') } };
			},

			get_maven_impact: async ({ artifactId }) => {
				const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
				if (!workspaceRoot) return { result: { consumers: [], impactLevel: 'low' as const } };

				const consumers = await this.repoIntelligenceService.getMavenImpact(workspaceRoot, artifactId);
				const count = consumers.length;
				const impactLevel = count >= 10 ? 'critical' : count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low';

				return { result: { consumers, impactLevel } };
			},

			get_npm_impact: async ({ packageName }) => {
				const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
				if (!workspaceRoot) return { result: { consumers: [], impactLevel: 'low' as const } };

				const consumers = await this.repoIntelligenceService.getNpmConsumers(workspaceRoot, packageName);
				const count = consumers.length;
				const impactLevel =
					count >= 5 ? 'critical' :
						count >= 3 ? 'high' :
							count >= 1 ? 'medium' : 'low';
				return { result: { consumers, impactLevel } };
			},

			get_config_drift: async ({ serviceName }) => {
				const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
				if (!workspaceRoot) return { result: { drifts: [], summary: 'No workspace open.' } };

				const drifts = await this.repoIntelligenceService.getConfigDrift(workspaceRoot, serviceName);
				if (drifts.length === 0) {
					return { result: { drifts: [], summary: `No config drift detected for ${serviceName} across environments.` } };
				}

				const lines = [`Config drift for ${serviceName} (${drifts.length} properties):\n`];
				for (const d of drifts.slice(0, 20)) {
					const envPairs = Object.entries(d.envValues).map(([e, v]) => `${e}=${v}`).join(', ');
					lines.push(`  ${d.key}: ${envPairs}`);
				}
				if (drifts.length > 20) lines.push(`  …(${drifts.length - 20} more properties)`);

				return { result: { drifts, summary: lines.join('\n') } };
			},

			verify_security_compliance: async ({ code, fileExtension }) => {
				const { verifySecurityCompliance } = await import('./securityVerifierTool.js');
				const result = verifySecurityCompliance(code, fileExtension);
				return { result };
			},
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				return `${params.uri.fsPath}\n\`\`\`\n${result.fileContents}\n\`\`\`${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info because truncated: this file has ${result.totalNumLines} lines, or ${result.totalFileLen} characters.` : ''}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_codebase: (params, result) => {
				if (result.results.length === 0) {
					return `No codebase matches found for query: "${result.query}".`
				}
				const lines = result.results.map((r, i) => {
					return `${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine}\n\`\`\`\n${r.snippet}\n\`\`\``
				})
				return `Codebase search results for "${result.query}" (${result.results.length} matches):\n\n${lines.join('\n\n')}`
			},
			get_file_outline: (_params, result) => {
				return result.outline
			},
			get_symbol: (_params, result) => {
				if (result.error) {
					return result.error
				}
				return result.source ?? ''
			},
			search_symbols: (_params, result) => {
				return result.results
			},
			search_web: (params, result) => {
				if (result.results.length === 0) {
					return `No web results found for query: "${result.query}".`
				}
				const lines = result.results.map((r, i) => {
					return `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
				})
				return `Web search results for "${result.query}" (${result.results.length} matches):\n\n${lines.join('\n\n')}`
			},
			search_in_file: (params, result) => {
				const { model } = troveModelService.getModel(params.uri)
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
				return lines;
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			// ---
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.troveSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}${buildVerificationReminder(this.repoIntelligenceService.getProfileSync())}`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.troveSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}${buildVerificationReminder(this.repoIntelligenceService.getProfileSync())}`
			},
			create_file_or_folder: (params, result) => {
				if (params.isFolder) {
					return `URI ${params.uri.fsPath} successfully created.`
				}
				return `URI ${params.uri.fsPath} successfully created.${buildVerificationReminder(this.repoIntelligenceService.getProfileSync())}`
			},
			run_command: (params, result) => {
				const { resolveReason, result: result_, autoPersistentTerminalId } = result
				const plain = removeAnsiEscapeCodes(result_)
				const autoNote = autoPersistentTerminalId
					? `\n[Auto-routed to persistent terminal ${autoPersistentTerminalId} — do NOT use trailing & on run_command. Process keeps running; use run_command curl to verify endpoints.]`
					: ''
				// success
				if (resolveReason.type === 'done') {
					const persistNote = /\b(npm|pnpm|yarn)\s+(install|ci|add)\b/i.test(params.command)
						? '\n(package changes are on disk in the real workspace — node_modules is shared with your terminal)'
						: ''
					const emptyOutputNote = !plain.trim() || plain.trim() === `$ ${params.command.trim()}`
						? '\n\nWARNING: No command output was captured. If you need stdout, retry the command once — do NOT run more than 2 diagnostic loops.'
						: ''
					const installFailedNote = isPackageInstallCommand(params.command) && resolveReason.exitCode === 0 && !packageInstallLooksSuccessful(plain)
						? '\n\nINSTALL NOT VERIFIED — output does not confirm packages were installed. Retry run_command with the same install command and read errors above. Do NOT tell the user setup is complete.'
						: ''
					const curlNote = /\b(curl|wget|httpie|httpx)\b/i.test(params.command) && /\b(localhost|127\.0\.0\.1)\b/i.test(params.command) && resolveReason.exitCode === 0
						? '\n\nVERIFICATION COMPLETE — localhost responded successfully. Trove opened the preview in the editor. Give a concise summary to the user. Do NOT run more terminal commands or ask the user to run install/build/start.'
						: ''
					return `${plain}\n(exit code ${resolveReason.exitCode})${persistNote}${installFailedNote}${emptyOutputNote}${curlNote}${autoNote}`
				}
				if (resolveReason.type === 'server_ready') {
					return `${plain}\nDev server appears ready in persistent terminal ${autoPersistentTerminalId ?? 'unknown'}. Run ONE run_command curl against the URL shown above — then stop.${autoNote}`
				}
				// timed out
				if (resolveReason.type === 'timeout') {
					if (resolveReason.reason === 'absolute') {
						return `${plain}\nTerminal command ran in the chat sandbox but was killed after ${MAX_TERMINAL_COMMAND_TIME}s (maximum allowed time). Try running a narrower command or split the work into smaller steps.${autoNote}`
					}
					if (resolveReason.reason === 'snapshot') {
						return `${plain}\nDev server snapshot after ${MAX_TERMINAL_BG_COMMAND_TIME}s in persistent terminal ${autoPersistentTerminalId ?? 'unknown'}. Process is still running — verify with run_command curl.${autoNote}`
					}
					const inactiveLimit = resolveReason.inactiveTimeoutSeconds
					return `${plain}\nTerminal command was killed after ${inactiveLimit}s of inactivity and did not finish successfully. Build/compile/test commands allow up to ${getTerminalInactiveTimeoutSeconds(params.command)}s of silence — retry with run_command.${autoNote}`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const plain = removeAnsiEscapeCodes(result_)
				const { persistentTerminalId } = params
				if (resolveReason.type === 'done') {
					return `${plain}\n(exit code ${resolveReason.exitCode})`
				}
				if (resolveReason.type === 'server_ready') {
					return `${plain}\nDev server is ready in terminal ${persistentTerminalId}. Use run_command curl to hit the endpoint while this process keeps running.`
				}
				if (resolveReason.type === 'timeout') {
					return `${plain}\nProcess is running in terminal ${persistentTerminalId} (snapshot after ${MAX_TERMINAL_BG_COMMAND_TIME}s). Use run_command curl to verify while it stays alive.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Persistent terminal ready. persistentTerminalId="${persistentTerminalId}". Reuse this ID — do NOT open another. Prefer run_command with the Start script from repository_context (auto-routes to persistent terminal).`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
			query_service_topology: (_params, result) => result.summary,
			resolve_api_contract: (_params, result) => result.contract,
			get_maven_impact: (_params, result) => {
				const { consumers, impactLevel } = result;
				if (consumers.length === 0) return 'No consumers found for this artifact.';
				return `Impact level: ${impactLevel.toUpperCase()} — ${consumers.length} consumer(s):\n${consumers.join('\n')}`;
			},
			get_npm_impact: (_p, result) => {
				if (result.consumers.length === 0) return `No consumers found for this package.`;
				return `Impact: ${result.impactLevel.toUpperCase()} — ${result.consumers.length} consumer(s):\n${result.consumers.join('\n')}`;
			},
			get_config_drift: (_p, result) => result.summary,
			verify_security_compliance: (_p, result) => {
				if (result.violations.length === 0) return result.summary;
				const lines = [result.summary, ''];
				for (const v of result.violations) {
					lines.push(`[${v.severity.toUpperCase()}] ${v.rule}: ${v.message}`);
				}
				return lines.join('\n');
			},
		}



	}


	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
