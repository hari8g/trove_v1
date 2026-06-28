import { URI } from '../../../../base/common/uri.js'
import { RawMCPToolCall } from './mcpServiceTypes.js';
import { builtinTools } from './prompt/prompts.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';
import type { StaasBuiltinToolCallParams, StaasBuiltinToolResultType } from '../extensions/staas/staasToolTypes.js';

export type { StaasBuiltinToolCallParams, StaasBuiltinToolResultType, StaasImpactLevel, StaasConfigDriftEntry } from '../extensions/staas/staasToolTypes.js';



export type TerminalResolveReason =
	| { type: 'timeout', inactiveTimeoutSeconds: number, reason: 'inactivity' | 'absolute' | 'snapshot' }
	| { type: 'done', exitCode: number }
	| { type: 'server_ready' }

export type LintErrorItem = { code: string, message: string, startLineNumber: number, endLineNumber: number }

// Partial of IFileStat
export type ShallowDirectoryItem = {
	uri: URI;
	name: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}


export const approvalTypeOfBuiltinToolName: Partial<{ [T in BuiltinToolName]?: 'edits' | 'terminal' | 'MCP tools' }> = {
	'create_file_or_folder': 'edits',
	'delete_file_or_folder': 'edits',
	'rewrite_file': 'edits',
	'edit_file': 'edits',
	'run_command': 'terminal',
	'run_persistent_command': 'terminal',
	'open_persistent_terminal': 'terminal',
	'kill_persistent_terminal': 'terminal',
}


export type ToolApprovalType = NonNullable<(typeof approvalTypeOfBuiltinToolName)[keyof typeof approvalTypeOfBuiltinToolName]>;


export const toolApprovalTypes = new Set<ToolApprovalType>([
	...Object.values(approvalTypeOfBuiltinToolName),
	'MCP tools',
])




// PARAMS OF TOOL CALL
export type CoreBuiltinToolCallParams = {
	'read_file': { uri: URI, startLine: number | null, endLine: number | null, pageNumber: number },
	'ls_dir': { uri: URI, pageNumber: number },
	'get_dir_tree': { uri: URI },
	'search_pathnames_only': { query: string, includePattern: string | null, pageNumber: number },
	'search_for_files': { query: string, isRegex: boolean, searchInFolder: URI | null, pageNumber: number },
	'search_codebase': { query: string, maxResults: number },
	'get_file_outline': { uri: URI },
	'get_symbol': { uri: URI, symbolName: string },
	'search_symbols': { query: string, maxResults: number },
	'search_web': { query: string, maxResults: number },
	'get_import_graph': { uri: URI; direction?: 'imports' | 'importedBy' | 'both' },
	'get_tests_for_file': { uri: URI },
	'get_recently_changed': { limit?: number },
	'search_in_file': { uri: URI, query: string, isRegex: boolean },
	'read_lint_errors': { uri: URI },
	// ---
	'rewrite_file': { uri: URI, newContent: string },
	'edit_file': { uri: URI, searchReplaceBlocks: string },
	'create_file_or_folder': { uri: URI, isFolder: boolean },
	'delete_file_or_folder': { uri: URI, isRecursive: boolean, isFolder: boolean },
	// ---
	'run_command': { command: string; cwd: string | null, terminalId: string },
	'open_persistent_terminal': { cwd: string | null },
	'run_persistent_command': { command: string; persistentTerminalId: string },
	'kill_persistent_terminal': { persistentTerminalId: string },
}

export type BuiltinToolCallParams = CoreBuiltinToolCallParams & StaasBuiltinToolCallParams;

// RESULT OF TOOL CALL
export type CoreBuiltinToolResultType = {
	'read_file': { fileContents: string, totalFileLen: number, totalNumLines: number, hasNextPage: boolean },
	'ls_dir': { children: ShallowDirectoryItem[] | null, hasNextPage: boolean, hasPrevPage: boolean, itemsRemaining: number },
	'get_dir_tree': { str: string, },
	'search_pathnames_only': { uris: URI[], hasNextPage: boolean },
	'search_for_files': { uris: URI[], hasNextPage: boolean },
	'search_codebase': { results: { filePath: string, startLine: number, endLine: number, snippet: string }[], query: string },
	'get_file_outline': { outline: string },
	'get_symbol': { source?: string, startLine?: number, endLine?: number, error?: string },
	'search_symbols': { results: string },
	'search_web': { results: { title: string, url: string, snippet: string }[], query: string },
	'get_import_graph': { imports: string[]; importedBy: string[]; externalDeps: string[] },
	'get_tests_for_file': { tests: { testFile: string; confidence: 'high' | 'medium' }[] },
	'get_recently_changed': { files: { file: string; changeCount: number; lastChanged: string }[] },
	'search_in_file': { lines: number[]; },
	'read_lint_errors': { lintErrors: LintErrorItem[] | null },
	// ---
	'rewrite_file': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'edit_file': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'create_file_or_folder': {},
	'delete_file_or_folder': {},
	// ---
	'run_command': { result: string; resolveReason: TerminalResolveReason; autoPersistentTerminalId?: string },
	'run_persistent_command': { result: string; resolveReason: TerminalResolveReason; },
	'open_persistent_terminal': { persistentTerminalId: string },
	'kill_persistent_terminal': {},
}

export type BuiltinToolResultType = CoreBuiltinToolResultType & StaasBuiltinToolResultType;


export type ToolCallParams<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolCallParams[T] : RawToolParamsObj
export type ToolResult<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolResultType[T] : RawMCPToolCall

export type BuiltinToolName = keyof BuiltinToolResultType

type BuiltinToolParamNameOfTool<T extends BuiltinToolName> = keyof (typeof builtinTools)[T]['params']
export type BuiltinToolParamName = { [T in BuiltinToolName]: BuiltinToolParamNameOfTool<T> }[BuiltinToolName]


export type ToolName = BuiltinToolName | (string & {})
export type ToolParamName<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolParamNameOfTool<T> : string
