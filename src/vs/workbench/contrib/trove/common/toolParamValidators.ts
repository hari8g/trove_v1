/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { normalizeSearchReplaceBlocks } from './helpers/extractCodeFromResult.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';
import { BuiltinToolCallParams, BuiltinToolName } from './toolsServiceTypes.js';

export type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] };

const isHeredocTerminalCommand = (command: string): boolean =>
	/<<\s*-?\s*['"]?\w*['"]?/.test(command.trim());

const isFalsy = (u: unknown) => {
return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
return value
}

/** Accept string or JSON object (models often emit structured file bodies as objects). */
const validateContentStr = (argName: string, value: unknown) => {
if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
if (typeof value === 'string') return value
if (typeof value === 'object') return JSON.stringify(value, null, 2)
throw new Error(`Invalid LLM output format: ${argName} must be a string or JSON object, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
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


const validateParams: ValidateBuiltinParams = {
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
		const newContent = validateContentStr('newContent', newContentUnknown)
		return { uri, newContent }
	},

	edit_file: (params: RawToolParamsObj) => {
		const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
		const uri = validateURI(uriStr)
		const rawBlocks = validateContentStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
		const searchReplaceBlocks = normalizeSearchReplaceBlocks(rawBlocks)
		return { uri, searchReplaceBlocks }
	},

	// ---

	run_command: (params: RawToolParamsObj) => {
		const { command: commandUnknown, cwd: cwdUnknown } = params
		const command = validateStr('command', commandUnknown)
		if (isHeredocTerminalCommand(command)) {
			throw new Error('run_command does not support shell heredocs (<<). Use create_file_or_folder, then rewrite_file with the full file contents instead of cat/echo heredocs.')
		}
		const cwd = validateOptionalStr('cwd', cwdUnknown)
		const terminalId = generateUuid()
		return { command, cwd, terminalId }
	},
	run_persistent_command: (params: RawToolParamsObj) => {
		const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
		const command = validateStr('command', commandUnknown);
		if (isHeredocTerminalCommand(command)) {
			throw new Error('run_persistent_command does not support shell heredocs (<<). Use create_file_or_folder, then rewrite_file with the full file contents instead of cat/echo heredocs.')
		}
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
	get_import_graph: (params: RawToolParamsObj) => ({
	uri: URI.file(validateStr('uri', params.uri)),
	direction: (params.direction as 'imports' | 'importedBy' | 'both' | undefined) ?? 'both',
	}),
	get_tests_for_file: (params: RawToolParamsObj) => ({
	uri: URI.file(validateStr('uri', params.uri)),
	}),
	get_recently_changed: (params: RawToolParamsObj) => ({
	limit: typeof params.limit === 'number' ? params.limit : undefined,
	}),
	verify_security_compliance: (params: RawToolParamsObj) => ({
		code: validateStr('code', params.code),
		fileExtension: validateStr('fileExtension', params.file_extension ?? params.fileExtension),
	}),

};

export const createBuiltinToolValidators = (): ValidateBuiltinParams => validateParams;
