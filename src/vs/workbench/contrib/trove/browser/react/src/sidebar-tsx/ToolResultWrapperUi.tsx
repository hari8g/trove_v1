/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { ChevronRight, AlertTriangle, Ban, CircleEllipsis } from 'lucide-react';
import { useAccessor } from '../util/services.js';
import { ChatMessage, ToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { BuiltinToolCallParams, BuiltinToolName, LintErrorItem, ToolName } from '../../../../common/toolsServiceTypes.js';
import { builtinToolNames, isABuiltinToolName } from '../../../../common/prompt/prompts.js';
import { removeMCPToolNamePrefix } from '../../../../common/mcpServiceTypes.js';
import { CompactActivityRow, CompactCompletedToolRow } from './ChatActivityUI.js';
import { getBasename, getFolderName, getRelative } from './toolResultPathUtils.js';


// --- IconLoading ---
export const IconLoading = ({ className = '' }: { className?: string }) => {

	const [loadingText, setLoadingText] = useState('.');

	useEffect(() => {
		let intervalId;

		// Function to handle the animation
		const toggleLoadingText = () => {
			if (loadingText === '...') {
				setLoadingText('.');
			} else {
				setLoadingText(loadingText + '.');
			}
		};

		// Start the animation loop
		intervalId = setInterval(toggleLoadingText, 300);

		// Cleanup function to clear the interval when component unmounts
		return () => clearInterval(intervalId);
	}, [loadingText, setLoadingText]);

	return <div className={`${className}`}>{loadingText}</div>;

}

// --- ToolHeaderWrapper ---
export type ToolHeaderParams = {
	icon?: React.ReactNode;
	title: React.ReactNode;
	desc1: React.ReactNode;
	desc1OnClick?: () => void;
	desc2?: React.ReactNode;
	isError?: boolean;
	info?: string;
	desc1Info?: string;
	isRejected?: boolean;
	numResults?: number;
	hasNextPage?: boolean;
	children?: React.ReactNode;
	bottomChildren?: React.ReactNode;
	onClick?: () => void;
	desc2OnClick?: () => void;
	isOpen?: boolean;
	className?: string;
}

export const ToolHeaderWrapper = ({
	icon,
	title,
	desc1,
	desc1OnClick,
	desc1Info,
	desc2,
	numResults,
	hasNextPage,
	children,
	info,
	bottomChildren,
	isError,
	onClick,
	desc2OnClick,
	isOpen,
	isRejected,
	className, // applies to the main content
}: ToolHeaderParams) => {

	const [isOpen_, setIsOpen] = useState(false);
	const isExpanded = isOpen !== undefined ? isOpen : isOpen_

	const isDropdown = children !== undefined // null ALLOWS dropdown
	const isClickable = !!(isDropdown || onClick)

	const isDesc1Clickable = !!desc1OnClick

	const desc1HTML = <span
		className={`text-trove-fg-4 text-xs italic truncate ml-2
			${isDesc1Clickable ? 'cursor-pointer hover:brightness-125 transition-all duration-150' : ''}
		`}
		onClick={desc1OnClick}
		{...desc1Info ? {
			'data-tooltip-id': 'trove-tooltip',
			'data-tooltip-content': desc1Info,
			'data-tooltip-place': 'top',
			'data-tooltip-delay-show': 1000,
		} : {}}
	>{desc1}</span>

	// header-only tools (read file, search, etc.) — single tight line like Cursor
	const isCompactRow = children === undefined && !bottomChildren

	if (isCompactRow) {
		return (
			<CompactCompletedToolRow
				label={title}
				detail={desc1}
				onDetailClick={desc1OnClick}
				suffix={desc2}
				isRejected={isRejected}
			/>
		)
	}

	return (<div className=''>
		<div className={`w-full glass-card overflow-hidden px-1.5 py-0.5 ${className}`}>
			{/* header */}
			<div className={`select-none flex items-center min-h-[18px]`}>
				<div className={`flex items-center w-full gap-x-2 overflow-hidden justify-between ${isRejected ? 'line-through' : ''}`}>
					{/* left */}
					<div // container for if desc1 is clickable
						className='ml-1 flex items-center overflow-hidden'
					>
						{/* title eg "> Edited File" */}
						<div className={`
							flex items-center min-w-0 overflow-hidden grow
							${isClickable ? 'cursor-pointer hover:brightness-125 transition-all duration-150' : ''}
						`}
							onClick={() => {
								if (isDropdown) { setIsOpen(v => !v); }
								if (onClick) { onClick(); }
							}}
						>
							{isDropdown && (<ChevronRight
								className={`
								text-trove-fg-3 mr-0.5 h-4 w-4 flex-shrink-0 transition-transform duration-100 ease-[cubic-bezier(0.4,0,0.2,1)]
								${isExpanded ? 'rotate-90' : ''}
							`}
							/>)}
							<span className="text-trove-fg-3 flex-shrink-0">{title}</span>

							{!isDesc1Clickable && desc1HTML}
						</div>
						{isDesc1Clickable && desc1HTML}
					</div>

					{/* right */}
					<div className="flex items-center gap-x-2 flex-shrink-0">

						{info && <CircleEllipsis
							className='ml-2 text-trove-fg-4 opacity-60 flex-shrink-0'
							size={14}
							data-tooltip-id='trove-tooltip'
							data-tooltip-content={info}
							data-tooltip-place='top-end'
						/>}

						{isError && <AlertTriangle
							className='text-trove-warning opacity-90 flex-shrink-0'
							size={14}
							data-tooltip-id='trove-tooltip'
							data-tooltip-content={'Error running tool'}
							data-tooltip-place='top'
						/>}
						{isRejected && <Ban
							className='text-trove-fg-4 opacity-90 flex-shrink-0'
							size={14}
							data-tooltip-id='trove-tooltip'
							data-tooltip-content={'Canceled'}
							data-tooltip-place='top'
						/>}
						{desc2 && <span className="text-trove-fg-4 text-xs" onClick={desc2OnClick}>
							{desc2}
						</span>}
						{numResults !== undefined && (
							<span className="text-trove-fg-4 text-xs ml-auto mr-1">
								{`${numResults}${hasNextPage ? '+' : ''} result${numResults !== 1 ? 's' : ''}`}
							</span>
						)}
					</div>
				</div>
			</div>
			{/* children */}
			{<div
				className={`overflow-hidden transition-all duration-200 ease-in-out ${isExpanded ? 'opacity-100 py-0.5' : 'max-h-0 opacity-0'}
					text-trove-fg-4 rounded-sm overflow-x-auto
				  `}
			//    bg-black bg-opacity-10 border border-trove-border-4 border-opacity-50
			>
				{children}
			</div>}
		</div>
		{bottomChildren}
	</div>);
};

// --- SmallProseWrapper ---
export const SmallProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
text-trove-fg-4
prose
prose-sm
break-words
max-w-none
leading-snug
text-[13px]

[&>:first-child]:!mt-0
[&>:last-child]:!mb-0

prose-h1:text-[14px]
prose-h1:my-4

prose-h2:text-[13px]
prose-h2:my-4

prose-h3:text-[13px]
prose-h3:my-3

prose-h4:text-[13px]
prose-h4:my-2

prose-p:my-2
prose-p:leading-snug
prose-hr:my-2

prose-ul:my-2
prose-ul:pl-4
prose-ul:list-outside
prose-ul:list-disc
prose-ul:leading-snug


prose-ol:my-2
prose-ol:pl-4
prose-ol:list-outside
prose-ol:list-decimal
prose-ol:leading-snug

marker:text-inherit

prose-blockquote:pl-2
prose-blockquote:my-2

prose-code:text-trove-fg-3
prose-code:text-[12px]
prose-code:before:content-none
prose-code:after:content-none

prose-pre:text-[12px]
prose-pre:p-2
prose-pre:my-2

prose-table:text-[13px]
'>
		{children}
	</div>
}

// --- titles ---
const loadingTitleWrapper = (item: React.ReactNode): React.ReactNode => {
	return <span className='flex items-center flex-nowrap'>
		{item}
		<IconLoading className='w-3 text-sm' />
	</span>
}

const titleOfBuiltinToolName = {
	'read_file': { done: 'Read file', proposed: 'Read file', running: loadingTitleWrapper('Reading file') },
	'ls_dir': { done: 'Inspected folder', proposed: 'Inspect folder', running: loadingTitleWrapper('Inspecting folder') },
	'get_dir_tree': { done: 'Inspected folder tree', proposed: 'Inspect folder tree', running: loadingTitleWrapper('Inspecting folder tree') },
	'search_pathnames_only': { done: 'Searched by file name', proposed: 'Search by file name', running: loadingTitleWrapper('Searching by file name') },
	'search_for_files': { done: 'Searched', proposed: 'Search', running: loadingTitleWrapper('Searching') },
	'search_codebase': { done: 'Searched codebase', proposed: 'Search codebase', running: loadingTitleWrapper('Searching codebase') },
	'search_web': { done: 'Searched web', proposed: 'Search web', running: loadingTitleWrapper('Searching web') },
	'get_file_outline': { done: 'Read file outline', proposed: 'Read file outline', running: loadingTitleWrapper('Reading file outline') },
	'get_symbol': { done: 'Looked up symbol', proposed: 'Look up symbol', running: loadingTitleWrapper('Looking up symbol') },
	'search_symbols': { done: 'Searched symbols', proposed: 'Search symbols', running: loadingTitleWrapper('Searching symbols') },
	'get_import_graph': { done: 'Read import graph', proposed: 'Read import graph', running: loadingTitleWrapper('Reading import graph') },
	'get_tests_for_file': { done: 'Found tests', proposed: 'Find tests', running: loadingTitleWrapper('Finding tests') },
	'get_recently_changed': { done: 'Listed recent changes', proposed: 'List recent changes', running: loadingTitleWrapper('Listing recent changes') },
	'query_service_topology': { done: 'Queried service topology', proposed: 'Query service topology', running: loadingTitleWrapper('Querying service topology') },
	'resolve_api_contract': { done: 'Resolved API contract', proposed: 'Resolve API contract', running: loadingTitleWrapper('Resolving API contract') },
	'get_maven_impact': { done: 'Checked Maven impact', proposed: 'Check Maven impact', running: loadingTitleWrapper('Checking Maven impact') },
	'get_npm_impact': { done: 'Checked npm impact', proposed: 'Check npm impact', running: loadingTitleWrapper('Checking npm impact') },
	'get_config_drift': { done: 'Checked config drift', proposed: 'Check config drift', running: loadingTitleWrapper('Checking config drift') },
	'verify_security_compliance': { done: 'Verified security compliance', proposed: 'Verify security compliance', running: loadingTitleWrapper('Verifying security compliance') },
	'create_file_or_folder': { done: `Created`, proposed: `Create`, running: loadingTitleWrapper(`Creating`) },
	'delete_file_or_folder': { done: `Deleted`, proposed: `Delete`, running: loadingTitleWrapper(`Deleting`) },
	'edit_file': { done: `Edited file`, proposed: 'Edit file', running: loadingTitleWrapper('Editing file') },
	'rewrite_file': { done: `Wrote file`, proposed: 'Write file', running: loadingTitleWrapper('Writing file') },
	'run_command': { done: `Ran terminal`, proposed: 'Run terminal', running: loadingTitleWrapper('Running terminal') },
	'run_persistent_command': { done: `Ran terminal`, proposed: 'Run terminal', running: loadingTitleWrapper('Running terminal') },

	'open_persistent_terminal': { done: `Opened terminal`, proposed: 'Open terminal', running: loadingTitleWrapper('Opening terminal') },
	'kill_persistent_terminal': { done: `Killed terminal`, proposed: 'Kill terminal', running: loadingTitleWrapper('Killing terminal') },

	'read_lint_errors': { done: `Read lint errors`, proposed: 'Read lint errors', running: loadingTitleWrapper('Reading lint errors') },
	'search_in_file': { done: 'Searched in file', proposed: 'Search in file', running: loadingTitleWrapper('Searching in file') },
} as const satisfies Record<BuiltinToolName, { done: any, proposed: any, running: any }>


export const getTitle = (toolMessage: Pick<ChatMessage & { role: 'tool' }, 'name' | 'type' | 'mcpServerName'>): React.ReactNode => {
	const t = toolMessage

	// non-built-in title
	if (!builtinToolNames.includes(t.name as BuiltinToolName)) {
		// descriptor of Running or Ran etc
		const descriptor =
			t.type === 'success' ? 'Called'
				: t.type === 'running_now' ? 'Calling'
					: t.type === 'tool_request' ? 'Call'
						: t.type === 'rejected' ? 'Call'
							: t.type === 'invalid_params' ? 'Call'
								: t.type === 'tool_error' ? 'Call'
									: 'Call'


		const title = `${descriptor} ${toolMessage.mcpServerName || 'MCP'}`
		if (t.type === 'running_now' || t.type === 'tool_request')
			return loadingTitleWrapper(title)
		return title
	}

	// built-in title
	else {
		const toolName = t.name as BuiltinToolName
		if (t.type === 'success') return titleOfBuiltinToolName[toolName].done
		if (t.type === 'running_now') return titleOfBuiltinToolName[toolName].running
		return titleOfBuiltinToolName[toolName].proposed
	}
}


export const toolNameToDesc = (toolName: BuiltinToolName, _toolParams: BuiltinToolCallParams[BuiltinToolName] | undefined, accessor: ReturnType<typeof useAccessor>): {
	desc1: React.ReactNode,
	desc1Info?: string,
} => {

	if (!_toolParams) {
		return { desc1: '', };
	}

	const x = {
		'read_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['read_file']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'ls_dir': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['ls_dir']
			return {
				desc1: getFolderName(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'search_pathnames_only': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_pathnames_only']
			return {
				desc1: `"${toolParams.query}"`,
			}
		},
		'search_for_files': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_for_files']
			return {
				desc1: `"${toolParams.query}"`,
			}
		},
		'search_codebase': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_codebase']
			return {
				desc1: `"${toolParams.query}"`,
			}
		},
		'search_in_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_in_file'];
			return {
				desc1: `"${toolParams.query}"`,
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'create_file_or_folder': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['create_file_or_folder']
			return {
				desc1: toolParams.isFolder ? getFolderName(toolParams.uri.fsPath) ?? '/' : getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'delete_file_or_folder': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['delete_file_or_folder']
			return {
				desc1: toolParams.isFolder ? getFolderName(toolParams.uri.fsPath) ?? '/' : getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'rewrite_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['rewrite_file']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'edit_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['edit_file']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'run_command': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['run_command']
			return {
				desc1: `"${toolParams.command}"`,
			}
		},
		'run_persistent_command': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['run_persistent_command']
			return {
				desc1: `"${toolParams.command}"`,
			}
		},
		'open_persistent_terminal': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['open_persistent_terminal']
			return { desc1: '' }
		},
		'kill_persistent_terminal': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['kill_persistent_terminal']
			return { desc1: toolParams.persistentTerminalId }
		},
		'get_dir_tree': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['get_dir_tree']
			return {
				desc1: getFolderName(toolParams.uri.fsPath) ?? '/',
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'read_lint_errors': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['read_lint_errors']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'search_web': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_web']
			return { desc1: `"${toolParams.query}"` }
		},
		'get_file_outline': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['get_file_outline']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'get_symbol': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['get_symbol']
			return {
				desc1: toolParams.symbolName,
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'search_symbols': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_symbols']
			return { desc1: `"${toolParams.query}"` }
		},
		'get_import_graph': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['get_import_graph']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'get_tests_for_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['get_tests_for_file']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'get_recently_changed': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['get_recently_changed']
			return { desc1: toolParams.limit ? `Last ${toolParams.limit}` : 'Recent files' }
		},
		'query_service_topology': () => ({ desc1: '' }),
		'resolve_api_contract': () => ({ desc1: '' }),
		'get_maven_impact': () => ({ desc1: '' }),
		'get_npm_impact': () => ({ desc1: '' }),
		'get_config_drift': () => ({ desc1: '' }),
		'verify_security_compliance': () => ({ desc1: '' }),
	}

	try {
		return x[toolName]?.() || { desc1: '' }
	}
	catch {
		return { desc1: '' }
	}
}

export const RunningToolActivityRow = ({ toolMessage }: { toolMessage: Exclude<ToolMessage, { type: 'invalid_params' }> }) => {
	const accessor = useAccessor()
	const title = getTitle(toolMessage)
	const desc1 = isABuiltinToolName(toolMessage.name)
		? toolNameToDesc(toolMessage.name, toolMessage.params, accessor).desc1
		: removeMCPToolNamePrefix(toolMessage.name)
	return <CompactActivityRow label={title} detail={desc1} isActive />
}

// --- children wrappers ---
export const ToolChildrenWrapper = ({ children, className }: { children: React.ReactNode, className?: string }) => {
	return <div className={`${className ? className : ''} cursor-default select-none`}>
		<div className='px-2 min-w-full overflow-hidden'>
			{children}
		</div>
	</div>
}
export const CodeChildren = ({ children, className }: { children: React.ReactNode, className?: string }) => {
	return <div className={`${className ?? ''} p-1 rounded-sm overflow-auto text-sm`}>
		<div className='!select-text cursor-auto'>
			{children}
		</div>
	</div>
}

export const ListableToolItem = ({ name, onClick, isSmall, className, showDot }: { name: React.ReactNode, onClick?: () => void, isSmall?: boolean, className?: string, showDot?: boolean }) => {
	return <div
		className={`
			${onClick ? 'hover:brightness-125 hover:cursor-pointer transition-all duration-200 ' : ''}
			flex items-center flex-nowrap whitespace-nowrap
			${className ? className : ''}
			`}
		onClick={onClick}
	>
		{showDot === false ? null : <div className="flex-shrink-0"><svg className="w-1 h-1 opacity-60 mr-1.5 fill-current" viewBox="0 0 100 40"><rect x="0" y="15" width="100" height="10" /></svg></div>}
		<div className={`${isSmall ? 'italic text-trove-fg-4 flex items-center' : ''}`}>{name}</div>
	</div>
}



export const LintErrorChildren = ({ lintErrors }: { lintErrors: LintErrorItem[] }) => {
	return <div className="text-xs text-trove-fg-4 opacity-80 border-l-2 border-trove-warning px-2 py-0.5 flex flex-col gap-0.5 overflow-x-auto whitespace-nowrap">
		{lintErrors.map((error, i) => (
			<div key={i}>Lines {error.startLineNumber}-{error.endLineNumber}: {error.message}</div>
		))}
	</div>
}

export const BottomChildren = ({ children, title }: { children: React.ReactNode, title: string }) => {
	const [isOpen, setIsOpen] = useState(false);
	if (!children) return null;
	return (
		<div className="w-full px-2 mt-0.5">
			<div
				className={`flex items-center cursor-pointer select-none transition-colors duration-150 pl-0 py-0.5 rounded group`}
				onClick={() => setIsOpen(o => !o)}
				style={{ background: 'none' }}
			>
				<ChevronRight
					className={`mr-1 h-3 w-3 flex-shrink-0 transition-transform duration-100 text-trove-fg-4 group-hover:text-trove-fg-3 ${isOpen ? 'rotate-90' : ''}`}
				/>
				<span className="font-medium text-trove-fg-4 group-hover:text-trove-fg-3 text-xs">{title}</span>
			</div>
			<div
				className={`overflow-hidden transition-all duration-200 ease-in-out ${isOpen ? 'opacity-100' : 'max-h-0 opacity-0'} text-xs pl-4`}
			>
				<div className="overflow-x-auto text-trove-fg-4 opacity-90 border-l-2 border-trove-warning px-2 py-0.5">
					{children}
				</div>
			</div>
		</div>
	);
};
