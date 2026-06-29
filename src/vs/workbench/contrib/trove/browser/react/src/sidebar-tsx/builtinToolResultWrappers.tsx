/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { URI } from '../../../../../../../base/common/uri.js';
import { useAccessor } from '../util/services.js';
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js';
import { BuiltinToolCallParams, BuiltinToolName, ToolName } from '../../../../common/toolsServiceTypes.js';
import { ToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { MAX_FILE_CHARS_PAGE } from '../../../../common/prompt/prompts.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { IToolsService } from '../../../toolsService.js';
import { persistentTerminalNameOfId, ITerminalToolService } from '../../../terminalToolService.js';
import { CollapsibleCodeSnippet } from './ChatActivityUI.js';
import {
	ToolHeaderParams,
	ToolHeaderWrapper,
	ToolChildrenWrapper,
	SmallProseWrapper,
	getTitle,
	toolNameToDesc,
	RunningToolActivityRow,
	BottomChildren,
	CodeChildren,
	ListableToolItem,
	LintErrorChildren,
} from './ToolResultWrapperUi.js';
import { getBasename, getRelative, voidOpenFileFn } from './toolResultPathUtils.js';
import {
	ResultWrapper,
	WrapperProps,
	createStandardToolResultWrapper,
} from './toolResultWrapperFactory.js';
import { isRedundantEmptyFileRead } from '../../../toolResultDisplayUtils.js';

export type { ResultWrapper, WrapperProps } from './toolResultWrapperFactory.js';

export type BuiltinToolResultComponents = {
	EditTool: React.ComponentType<WrapperProps<'edit_file' | 'rewrite_file'> & { content: string }>;
	CommandTool: React.ComponentType<{ threadId: string } & ({
		toolMessage: Exclude<ToolMessage<'run_command'>, { type: 'invalid_params' }>;
		type: 'run_command';
	} | {
		toolMessage: Exclude<ToolMessage<'run_persistent_command'>, { type: 'invalid_params' }>;
		type: 'run_persistent_command';
	})>;
};

export const buildBuiltinToolNameToComponent = (
	{ EditTool, CommandTool }: BuiltinToolResultComponents,
): { [T in BuiltinToolName]: { resultWrapper: ResultWrapper<T> } } => ({
	'read_file': {
		resultWrapper: ({ toolMessage, messageIdx, threadId }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const chatThreadsService = accessor.get('IChatThreadService')

			const title = getTitle(toolMessage)

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const messages = chatThreadsService.state.allThreads[threadId]?.messages ?? []
			if (toolMessage.type === 'success' && isRedundantEmptyFileRead(toolMessage, messages, messageIdx)) {
				return null;
			}

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			let range: [number, number] | undefined = undefined
			if (toolMessage.params.startLine !== null || toolMessage.params.endLine !== null) {
				const start = toolMessage.params.startLine === null ? `1` : `${toolMessage.params.startLine}`
				const end = toolMessage.params.endLine === null ? `` : `${toolMessage.params.endLine}`
				const addStr = `(${start}-${end})`
				componentParams.desc1 += ` ${addStr}`
				range = [params.startLine || 1, params.endLine || 1]
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor, range) }
				if (result.hasNextPage && params.pageNumber === 1)  // first page
					componentParams.desc2 = `(truncated after ${Math.round(MAX_FILE_CHARS_PAGE) / 1000}k)`
				else if (params.pageNumber > 1) // subsequent pages
					componentParams.desc2 = `(part ${params.pageNumber})`
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				// JumpToFileButton removed in favor of FileLinkText
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'get_dir_tree': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.uri) {
				const rel = getRelative(params.uri, accessor)
				if (rel) componentParams.info = `Only search in ${rel}`
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.children = <ToolChildrenWrapper>
					<SmallProseWrapper>
						<ChatMarkdownRender
							string={`\`\`\`\n${result.str}\n\`\`\``}
							chatMessageLocation={undefined}
							isApplyEnabled={false}
							isLinkDetectionEnabled={true}
						/>
					</SmallProseWrapper>
				</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />

		}
	},
	'ls_dir': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const explorerService = accessor.get('IExplorerService')
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.uri) {
				const rel = getRelative(params.uri, accessor)
				if (rel) componentParams.info = `Only search in ${rel}`
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.numResults = result.children?.length
				componentParams.hasNextPage = result.hasNextPage
				componentParams.children = !result.children || (result.children.length ?? 0) === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.children.map((child, i) => (<ListableToolItem key={i}
							name={`${child.name}${child.isDirectory ? '/' : ''}`}
							className='w-full overflow-auto'
							onClick={() => {
								voidOpenFileFn(child.uri, accessor)
								// commandService.executeCommand('workbench.view.explorer'); // open in explorer folders view instead
								// explorerService.select(child.uri, true);
							}}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={`Results truncated (${result.itemsRemaining} remaining).`} isSmall={true} className='w-full overflow-auto' />
						}
					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'search_pathnames_only': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.includePattern) {
				componentParams.info = `Only search in ${params.includePattern}`
			}

			if (toolMessage.type === 'success') {
				const { result, rawParams } = toolMessage
				componentParams.numResults = result.uris.length
				componentParams.hasNextPage = result.hasNextPage
				componentParams.children = result.uris.length === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.uris.map((uri, i) => (<ListableToolItem key={i}
							name={getBasename(uri.fsPath)}
							className='w-full overflow-auto'
							onClick={() => { voidOpenFileFn(uri, accessor) }}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={'Results truncated.'} isSmall={true} className='w-full overflow-auto' />
						}

					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'search_for_files': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.searchInFolder || params.isRegex) {
				let info: string[] = []
				if (params.searchInFolder) {
					const rel = getRelative(params.searchInFolder, accessor)
					if (rel) info.push(`Only search in ${rel}`)
				}
				if (params.isRegex) { info.push(`Uses regex search`) }
				componentParams.info = info.join('; ')
			}

			if (toolMessage.type === 'success') {
				const { result, rawParams } = toolMessage
				componentParams.numResults = result.uris.length
				componentParams.hasNextPage = result.hasNextPage
				componentParams.children = result.uris.length === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.uris.map((uri, i) => (<ListableToolItem key={i}
							name={getBasename(uri.fsPath)}
							className='w-full overflow-auto'
							onClick={() => { voidOpenFileFn(uri, accessor) }}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={`Results truncated.`} isSmall={true} className='w-full overflow-auto' />
						}

					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'search_codebase': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const workspaceContextService = accessor.get('IWorkspaceContextService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const { params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.numResults = result.results.length
				componentParams.children = result.results.length === 0
					? <ToolChildrenWrapper>
						<div className='text-trove-fg-3 text-sm px-2 py-1'>No matches found.</div>
					</ToolChildrenWrapper>
					: <ToolChildrenWrapper>
						{result.results.map((match, i) => {
							const folder = workspaceContextService.getWorkspace().folders[0]
							const uri = folder ? URI.joinPath(folder.uri, match.filePath) : URI.file(match.filePath)
							const lineLabel = `${match.startLine}-${match.endLine}`
							return (
								<CollapsibleCodeSnippet
									key={i}
									fileName={getBasename(match.filePath)}
									subtitle={lineLabel}
									code={match.snippet}
									onFileClick={() => { voidOpenFileFn(uri, accessor, [match.startLine, match.endLine]) }}
								/>
							)
						})}
					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			return <ToolHeaderWrapper {...componentParams} />
		}
	},

	'search_in_file': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const toolsService = accessor.get('IToolsService');
			const title = getTitle(toolMessage);
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null;

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected };

			const infoarr: string[] = []
			const uriStr = getRelative(params.uri, accessor)
			if (uriStr) infoarr.push(uriStr)
			if (params.isRegex) infoarr.push('Uses regex search')
			componentParams.info = infoarr.join('; ')

			if (toolMessage.type === 'success') {
				const { result } = toolMessage; // result is array of snippets
				componentParams.numResults = result.lines.length;
				componentParams.children = result.lines.length === 0 ? undefined :
					<ToolChildrenWrapper>
						<CollapsibleCodeSnippet
							fileName={getBasename(params.uri.fsPath)}
							subtitle={`${result.lines.length} match${result.lines.length === 1 ? '' : 'es'}`}
							code={toolsService.stringOfResult['search_in_file'](params, result)}
							onFileClick={() => { voidOpenFileFn(params.uri, accessor) }}
						/>
					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />;
		}
	},

	'read_lint_errors': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)

			const { uri } = toolMessage.params ?? {}
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			componentParams.info = getRelative(uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
				if (result.lintErrors)
					componentParams.children = <LintErrorChildren lintErrors={result.lintErrors} />
				else
					componentParams.children = `No lint errors found.`

			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				// JumpToFileButton removed in favor of FileLinkText
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},

	// ---

	'create_file_or_folder': {
		resultWrapper: createStandardToolResultWrapper<'create_file_or_folder'>({
			hideToolRequest: false,
			customize: ({ accessor, toolMessage, componentParams }) => {
				if (toolMessage.type === 'invalid_params') return;
				const { params } = toolMessage;
				componentParams.info = getRelative(params.uri, accessor);
				if (toolMessage.type === 'success' || toolMessage.type === 'rejected' || toolMessage.type === 'tool_error' || toolMessage.type === 'running_now' || toolMessage.type === 'tool_request') {
					componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); };
				}
			},
		}),
	},
	'delete_file_or_folder': {
		resultWrapper: createStandardToolResultWrapper<'delete_file_or_folder'>({
			hideToolRequest: false,
			customize: ({ accessor, toolMessage, componentParams }) => {
				if (toolMessage.type === 'invalid_params') return;
				const { params } = toolMessage;
				componentParams.info = getRelative(params.uri, accessor);
				if (toolMessage.type === 'success' || toolMessage.type === 'rejected' || toolMessage.type === 'tool_error' || toolMessage.type === 'running_now' || toolMessage.type === 'tool_request') {
					componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor); };
				}
			},
		}),
	},
	'rewrite_file': {
		resultWrapper: (params) => {
			return <EditTool {...params} content={params.toolMessage.params.newContent} />
		}
	},
	'edit_file': {
		resultWrapper: (params) => {
			return <EditTool {...params} content={params.toolMessage.params.searchReplaceBlocks} />
		}
	},

	// ---

	'run_command': {
		resultWrapper: (params) => {
			return <CommandTool {...params} type='run_command' />
		}
	},

	'run_persistent_command': {
		resultWrapper: (params) => {
			return <CommandTool {...params} type='run_persistent_command' />
		}
	},
	'open_persistent_terminal': {
		resultWrapper: createStandardToolResultWrapper<'open_persistent_terminal'>({
			customize: ({ accessor, toolMessage, componentParams }) => {
				if (toolMessage.type === 'invalid_params') return;
				const terminalToolsService = accessor.get('ITerminalToolService');
				const relativePath = toolMessage.params.cwd ? getRelative(URI.file(toolMessage.params.cwd), accessor) : '';
				componentParams.info = relativePath ? `Running in ${relativePath}` : undefined;
				if (toolMessage.type === 'success') {
					const { persistentTerminalId } = toolMessage.result;
					componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId);
					componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId);
				}
			},
		}),
	},
	'kill_persistent_terminal': {
		resultWrapper: createStandardToolResultWrapper<'kill_persistent_terminal'>({
			customize: ({ accessor, toolMessage, componentParams }) => {
				if (toolMessage.type === 'invalid_params') return;
				const terminalToolsService = accessor.get('ITerminalToolService');
				if (toolMessage.type === 'success') {
					const { persistentTerminalId } = toolMessage.params;
					componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId);
					componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId);
				}
			},
		}),
	},
	'search_web': {
		resultWrapper: createStandardToolResultWrapper<'search_web'>({
			customize: ({ toolMessage, componentParams }) => {
				if (toolMessage.type === 'success') {
					componentParams.numResults = toolMessage.result.results.length;
				}
			},
		}),
	},
	'get_file_outline': {
		resultWrapper: createStandardToolResultWrapper<'get_file_outline'>({
			customize: ({ accessor, toolMessage, componentParams }) => {
				if (toolMessage.type === 'success') {
					componentParams.onClick = () => { voidOpenFileFn(toolMessage.params.uri, accessor); };
					componentParams.children = <ToolChildrenWrapper>
						<SmallProseWrapper>
							<ChatMarkdownRender
								string={toolMessage.result.outline}
								chatMessageLocation={undefined}
								isApplyEnabled={false}
								isLinkDetectionEnabled={true}
							/>
						</SmallProseWrapper>
					</ToolChildrenWrapper>;
				}
			},
		}),
	},
	'get_symbol': {
		resultWrapper: createStandardToolResultWrapper<'get_symbol'>({
			customize: ({ accessor, toolMessage, componentParams }) => {
				if (toolMessage.type === 'success' && toolMessage.result.source) {
					const range = toolMessage.result.startLine && toolMessage.result.endLine
						? [toolMessage.result.startLine, toolMessage.result.endLine] as [number, number]
						: undefined;
					componentParams.onClick = () => { voidOpenFileFn(toolMessage.params.uri, accessor, range); };
					componentParams.children = <ToolChildrenWrapper>
						<SmallProseWrapper>
							<ChatMarkdownRender
								string={`\`\`\`\n${toolMessage.result.source}\n\`\`\``}
								chatMessageLocation={undefined}
								isApplyEnabled={false}
								isLinkDetectionEnabled={false}
							/>
						</SmallProseWrapper>
					</ToolChildrenWrapper>;
				}
			},
		}),
	},
	'search_symbols': {
		resultWrapper: createStandardToolResultWrapper<'search_symbols'>({
			customize: ({ toolMessage, componentParams }) => {
				if (toolMessage.type === 'success') {
					componentParams.children = <ToolChildrenWrapper>
						<SmallProseWrapper>
							<ChatMarkdownRender
								string={toolMessage.result.results}
								chatMessageLocation={undefined}
								isApplyEnabled={false}
								isLinkDetectionEnabled={true}
							/>
						</SmallProseWrapper>
					</ToolChildrenWrapper>;
				}
			},
		}),
	},
	'get_import_graph': {
		resultWrapper: createStandardToolResultWrapper<'get_import_graph'>({
			customize: ({ accessor, toolMessage, componentParams }) => {
				if (toolMessage.type === 'success') {
					componentParams.onClick = () => { voidOpenFileFn(toolMessage.params.uri, accessor); };
					const { imports, importedBy, externalDeps } = toolMessage.result;
					componentParams.numResults = imports.length + importedBy.length + externalDeps.length;
				}
			},
		}),
	},
	'get_tests_for_file': {
		resultWrapper: createStandardToolResultWrapper<'get_tests_for_file'>({
			customize: ({ accessor, toolMessage, componentParams }) => {
				if (toolMessage.type === 'success') {
					componentParams.onClick = () => { voidOpenFileFn(toolMessage.params.uri, accessor); };
					componentParams.numResults = toolMessage.result.tests.length;
				}
			},
		}),
	},
	'get_recently_changed': {
		resultWrapper: createStandardToolResultWrapper<'get_recently_changed'>({
			customize: ({ toolMessage, componentParams }) => {
				if (toolMessage.type === 'success') {
					componentParams.numResults = toolMessage.result.files.length;
				}
			},
		}),
	},
	'query_service_topology': { resultWrapper: createStandardToolResultWrapper<'query_service_topology'>() },
	'resolve_api_contract': { resultWrapper: createStandardToolResultWrapper<'resolve_api_contract'>() },
	'get_maven_impact': { resultWrapper: createStandardToolResultWrapper<'get_maven_impact'>() },
	'get_npm_impact': { resultWrapper: createStandardToolResultWrapper<'get_npm_impact'>() },
	'get_config_drift': { resultWrapper: createStandardToolResultWrapper<'get_config_drift'>() },
	'verify_security_compliance': { resultWrapper: createStandardToolResultWrapper<'verify_security_compliance'>() },
});
