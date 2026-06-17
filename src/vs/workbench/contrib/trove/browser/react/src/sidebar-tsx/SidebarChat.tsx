/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { ButtonHTMLAttributes, FormEvent, FormHTMLAttributes, Fragment, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';


import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useSettingsState, useActiveURI, useFullChatThreadsStreamState, useAgentDelivery } from '../util/services.js';
import { ScrollType } from '../../../../../../../editor/common/editorCommon.js';

import { ChatMarkdownRender, ChatMessageLocation, getApplyBoxId } from '../markdown/ChatMarkdownRender.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { ErrorDisplay } from './ErrorDisplay.js';
import { BlockCode, TextAreaFns, TroveCustomDropdownBox, TroveInputBox2, TroveSlider, TroveSwitch } from '../util/inputs.js';
import { ModelDropdown, } from '../trove-settings-tsx/ModelDropdown.js';
import { PastThreadsList } from './SidebarThreadSelector.js';
import { TROVE_OPEN_SETTINGS_ACTION_ID } from '../../../troveSettingsPane.js';
import { ChatMode, displayInfoOfProviderName, FeatureName, isFeatureNameDisabled } from '../../../../../../../workbench/contrib/trove/common/troveSettingsTypes.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { WarningBox } from '../trove-settings-tsx/WarningBox.js';
import { getModelCapabilities, getIsReasoningEnabledState } from '../../../../common/modelCapabilities.js';
import { AlertTriangle, File, Ban, Check, ChevronRight, Dot, FileIcon, Pencil, Undo, Undo2, X, Flag, Copy as CopyIcon, Info, CirclePlus, Ellipsis, CircleEllipsis, Folder, ALargeSmall, TypeOutline, Text } from 'lucide-react';
import { ChatMessage, CheckpointEntry, StagingSelectionItem, ToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { InlineContextPills } from './ContextPills.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolName, ToolName, LintErrorItem, ToolApprovalType, toolApprovalTypes } from '../../../../common/toolsServiceTypes.js';
import { CopyButton, EditToolAcceptRejectButtonsHTML, IconShell1, JumpToFileButton, JumpToTerminalButton, StatusIndicator, StatusIndicatorForApplyButton, useApplyStreamState, useEditToolStreamState } from '../markdown/ApplyBlockHoverButtons.js';
import { IsRunningType } from '../../../chatThreadService.js';
import { acceptAllBg, acceptBorder, buttonFontSize, buttonTextColor, rejectAllBg, rejectBg, rejectBorder } from '../../../../common/helpers/colors.js';
import { builtinToolNames, isABuiltinToolName, MAX_FILE_CHARS_PAGE } from '../../../../common/prompt/prompts.js';
import { RawToolCallObj } from '../../../../common/sendLLMMessageTypes.js';
import ErrorBoundary from './ErrorBoundary.js';
import { ToolApprovalTypeSwitch } from '../trove-settings-tsx/Settings.js';

import { persistentTerminalNameOfId, ITerminalToolService } from '../../../terminalToolService.js';
import { AnsiTerminalOutput } from '../util/ansiOutput.js';
import { removeMCPToolNamePrefix } from '../../../../common/mcpServiceTypes.js';
import { BackgroundActivityPanel, ChatInlineDiffButtons, CollapsibleCodeSnippet, CompactActivityRow, CompactCompletedToolRow, EditToolChatBlock, formatAnthropicReasoning, LiveReasoningBlock, StreamingEditToolCard, summarizeAgentTurnActivity, type BackgroundActivityPhase } from './ChatActivityUI.js';
import { PlanView } from './PlanView.js';
import { ChatInlineDiffView, computeChatDiff } from './ChatInlineDiffView.js';
import { AgentDeliverySummaryCard } from './AgentDeliverySummary.js';



export const IconX = ({ size, className = '', ...props }: { size: number, className?: string } & React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			xmlns='http://www.w3.org/2000/svg'
			width={size}
			height={size}
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			className={className}
			{...props}
		>
			<path
				strokeLinecap='round'
				strokeLinejoin='round'
				d='M6 18 18 6M6 6l12 12'
			/>
		</svg>
	);
};

const IconArrowUp = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			width={size}
			height={size}
			className={className}
			viewBox="0 0 20 20"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fill="black"
				fillRule="evenodd"
				clipRule="evenodd"
				d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 7.414V15a1 1 0 11-2 0V7.414L6.707 9.707a1 1 0 01-1.414 0z"
			></path>
		</svg>
	);
};


const IconSquare = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			className={className}
			stroke="black"
			fill="black"
			strokeWidth="0"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<rect x="2" y="2" width="20" height="20" rx="4" ry="4" />
		</svg>
	);
};


export const IconWarning = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			className={className}
			stroke="currentColor"
			fill="currentColor"
			strokeWidth="0"
			viewBox="0 0 16 16"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z"
			/>
		</svg>
	);
};


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



// SLIDER ONLY:
const ReasoningOptionSlider = ({ featureName }: { featureName: FeatureName }) => {
	const accessor = useAccessor()

	const troveSettingsService = accessor.get('ITroveSettingsService')
	const troveSettingsState = useSettingsState()

	const modelSelection = troveSettingsState.modelSelectionOfFeature[featureName]
	const overridesOfModel = troveSettingsState.overridesOfModel

	if (!modelSelection) return null

	const { modelName, providerName } = modelSelection
	const { reasoningCapabilities } = getModelCapabilities(providerName, modelName, overridesOfModel)
	const { canTurnOffReasoning, reasoningSlider: reasoningBudgetSlider } = reasoningCapabilities || {}

	const modelSelectionOptions = troveSettingsState.optionsOfModelSelection[featureName][providerName]?.[modelName]
	const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)

	if (canTurnOffReasoning && !reasoningBudgetSlider) { // if it's just a on/off toggle without a power slider
		return <div className='flex items-center gap-x-2'>
			<span className='text-trove-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<TroveSwitch
				size='xxs'
				value={isReasoningEnabled}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && !newVal
					troveSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff })
				}}
			/>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'budget_slider') { // if it's a slider
		const { min: min_, max, default: defaultVal } = reasoningBudgetSlider

		const nSteps = 8 // only used in calculating stepSize, stepSize is what actually matters
		const stepSize = Math.round((max - min_) / nSteps)

		const valueIfOff = min_ - stepSize
		const min = canTurnOffReasoning ? valueIfOff : min_
		const value = isReasoningEnabled ? troveSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningBudget ?? defaultVal
			: valueIfOff

		return <div className='flex items-center gap-x-2'>
			<span className='text-trove-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<TroveSlider
				width={50}
				size='xs'
				min={min}
				max={max}
				step={stepSize}
				value={value}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					troveSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningBudget: newVal })
				}}
			/>
			<span className='text-trove-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? `${value} tokens` : 'Thinking disabled'}</span>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'effort_slider') {

		const { values, default: defaultVal } = reasoningBudgetSlider

		const min = canTurnOffReasoning ? -1 : 0
		const max = values.length - 1

		const currentEffort = troveSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningEffort ?? defaultVal
		const valueIfOff = -1
		const value = isReasoningEnabled && currentEffort ? values.indexOf(currentEffort) : valueIfOff

		const currentEffortCapitalized = currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1, Infinity)

		return <div className='flex items-center gap-x-2'>
			<span className='text-trove-fg-3 text-xs pointer-events-none inline-block w-10 pr-1'>Thinking</span>
			<TroveSlider
				width={30}
				size='xs'
				min={min}
				max={max}
				step={1}
				value={value}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					troveSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningEffort: values[newVal] ?? undefined })
				}}
			/>
			<span className='text-trove-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? `${currentEffortCapitalized}` : 'Thinking disabled'}</span>
		</div>
	}

	return null
}



const nameOfChatMode = {
	'normal': 'Chat',
	'gather': 'Gather',
	'agent': 'Agent',
}

const detailOfChatMode = {
	'normal': 'Normal chat',
	'gather': 'Reads files, but can\'t edit',
	'agent': 'Edits files and uses tools',
}


const ChatModeDropdown = ({ className }: { className: string }) => {
	const accessor = useAccessor()

	const troveSettingsService = accessor.get('ITroveSettingsService')
	const settingsState = useSettingsState()

	const options: ChatMode[] = useMemo(() => ['normal', 'gather', 'agent'], [])

	const onChangeOption = useCallback((newVal: ChatMode) => {
		troveSettingsService.setGlobalSetting('chatMode', newVal)
	}, [troveSettingsService])

	return <TroveCustomDropdownBox
		className={className}
		options={options}
		selectedOption={settingsState.globalSettings.chatMode}
		onChangeOption={onChangeOption}
		getOptionDisplayName={(val) => nameOfChatMode[val]}
		getOptionDropdownName={(val) => nameOfChatMode[val]}
		getOptionDropdownDetail={(val) => detailOfChatMode[val]}
		getOptionsEqual={(a, b) => a === b}
	/>

}





interface TroveChatAreaProps {
	// Required
	children: React.ReactNode; // This will be the input component

	// Form controls
	onSubmit: () => void;
	onAbort: () => void;
	isStreaming: boolean;
	isDisabled?: boolean;
	divRef?: React.RefObject<HTMLDivElement | null>;
	streamingStatusText?: string;

	// UI customization
	className?: string;
	showModelDropdown?: boolean;
	showSelections?: boolean;
	showProspectiveSelections?: boolean;
	loadingIcon?: React.ReactNode;

	selections?: StagingSelectionItem[]
	setSelections?: (s: StagingSelectionItem[]) => void
	// selections?: any[];
	// onSelectionsChange?: (selections: any[]) => void;

	onClickAnywhere?: () => void;
	// Optional close button
	onClose?: () => void;

	featureName: FeatureName;
}

export const TroveChatArea: React.FC<TroveChatAreaProps> = ({
	children,
	onSubmit,
	onAbort,
	onClose,
	onClickAnywhere,
	divRef,
	isStreaming = false,
	isDisabled = false,
	streamingStatusText,
	className = '',
	showModelDropdown = true,
	showSelections = false,
	showProspectiveSelections = false,
	selections,
	setSelections,
	featureName,
	loadingIcon,
}) => {
	return (
		<div
			ref={divRef}
			className={`
                flex flex-col relative shrink-0 mx-2 mb-2
                rounded-xl
                glass-panel
				transition-all duration-200
				shadow-sm
                ${className}
            `}
			onClick={(e) => {
				onClickAnywhere?.()
			}}
		>
			{/* Input section */}
			<div className="relative w-full px-3 pt-2.5 pb-1">
				{children}

				{/* Close button (X) if onClose is provided */}
				{onClose && (
					<div className='absolute top-1 right-1 cursor-pointer z-1'>
						<IconX
							size={12}
							className="stroke-[2] opacity-80 text-trove-fg-3 hover:brightness-95"
							onClick={onClose}
						/>
					</div>
				)}
			</div>

			{/* Bottom toolbar */}
			<div className='flex flex-row justify-between items-center gap-2 px-2 pb-2 pt-0.5'>
				{showModelDropdown ? (
					<div className='flex items-center flex-wrap gap-1.5 min-w-0'>
						{featureName === 'Chat' && (
							<ChatModeDropdown className='text-[11px] text-trove-fg-3 bg-trove-bg-1/80 border border-trove-border-3/50 rounded-md py-0.5 px-1.5' />
						)}
						<ModelDropdown featureName={featureName} className='text-[11px] text-trove-fg-3 bg-trove-bg-1/80 border border-trove-border-3/50 rounded-md py-0.5 px-1.5' />
						<ReasoningOptionSlider featureName={featureName} />
					</div>
				) : <div />}

				<div className="flex items-center gap-1.5 shrink-0">

					{isStreaming ? (
						<span className="text-[10px] text-trove-fg-4 italic max-w-[220px] truncate" title={streamingStatusText ?? 'Working…'}>
							{streamingStatusText ?? 'Working…'}
						</span>
					) : null}

					{isStreaming && loadingIcon}

					{isStreaming ? (
						<ButtonStop onClick={onAbort} />
					) : (
						<ButtonSubmit
							onClick={onSubmit}
							disabled={isDisabled}
						/>
					)}
				</div>

			</div>
		</div>
	);
};




type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>
const DEFAULT_BUTTON_SIZE = 22;
export const ButtonSubmit = ({ className, disabled, ...props }: ButtonProps & Required<Pick<ButtonProps, 'disabled'>>) => {

	return <button
		type='button'
		className={`rounded-full flex-shrink-0 flex-grow-0 flex items-center justify-center w-[26px] h-[26px]
			${disabled ? 'opacity-40 cursor-default' : 'cursor-pointer hover:brightness-110'}
			${className}
		`}
		style={disabled ? undefined : {
			backgroundColor: 'var(--vscode-button-background)',
			color: 'var(--vscode-button-foreground)',
		}}
		// data-tooltip-id='trove-tooltip'
		// data-tooltip-content={'Send'}
		// data-tooltip-place='left'
		{...props}
	>
		<IconArrowUp size={DEFAULT_BUTTON_SIZE} className="stroke-[2] p-[2px]" />
	</button>
}

export const ButtonStop = ({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
	return <button
		className={`rounded-full flex-shrink-0 flex-grow-0 cursor-pointer flex items-center justify-center
			bg-white
			${className}
		`}
		type='button'
		{...props}
	>
		<IconSquare size={DEFAULT_BUTTON_SIZE} className="stroke-[3] p-[7px]" />
	</button>
}



const scrollToBottom = (divRef: { current: HTMLElement | null }) => {
	if (divRef.current) {
		divRef.current.scrollTop = divRef.current.scrollHeight;
	}
};



const ScrollToBottomContainer = ({ children, className, style, scrollContainerRef }: { children: React.ReactNode, className?: string, style?: React.CSSProperties, scrollContainerRef: React.MutableRefObject<HTMLDivElement | null> }) => {
	const [isAtBottom, setIsAtBottom] = useState(true); // Start at bottom

	const divRef = scrollContainerRef

	const onScroll = () => {
		const div = divRef.current;
		if (!div) return;

		const isBottom = Math.abs(
			div.scrollHeight - div.clientHeight - div.scrollTop
		) < 4;

		setIsAtBottom(isBottom);
	};

	// When children change (new messages added)
	useEffect(() => {
		if (isAtBottom) {
			scrollToBottom(divRef);
		}
	}, [children, isAtBottom]); // Dependency on children to detect new messages

	// Initial scroll to bottom
	useEffect(() => {
		scrollToBottom(divRef);
	}, []);

	return (
		<div
			ref={divRef}
			onScroll={onScroll}
			className={className}
			style={style}
		>
			{children}
		</div>
	);
};

export const getRelative = (uri: URI, accessor: ReturnType<typeof useAccessor>) => {
	const workspaceContextService = accessor.get('IWorkspaceContextService')
	let path: string
	const isInside = workspaceContextService.isInsideWorkspace(uri)
	if (isInside) {
		const f = workspaceContextService.getWorkspace().folders.find(f => uri.fsPath?.startsWith(f.uri.fsPath))
		if (f) { path = uri.fsPath.replace(f.uri.fsPath, '') }
		else { path = uri.fsPath }
	}
	else {
		path = uri.fsPath
	}
	return path || undefined
}

export const getFolderName = (pathStr: string) => {
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\]+/g, '/') // replace any / or \ or \\ with /
	const parts = pathStr.split('/') // split on /
	// Filter out empty parts (the last element will be empty if path ends with /)
	const nonEmptyParts = parts.filter(part => part.length > 0)
	if (nonEmptyParts.length === 0) return '/' // Root directory
	if (nonEmptyParts.length === 1) return nonEmptyParts[0] + '/' // Only one folder
	// Get the last two parts
	const lastTwo = nonEmptyParts.slice(-2)
	return lastTwo.join('/') + '/'
}

export const getBasename = (pathStr: string, parts: number = 1) => {
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\]+/g, '/') // replace any / or \ or \\ with /
	const allParts = pathStr.split('/') // split on /
	if (allParts.length === 0) return pathStr
	return allParts.slice(-parts).join('/')
}



// Open file utility function
export const voidOpenFileFn = (
	uri: URI,
	accessor: ReturnType<typeof useAccessor>,
	range?: [number, number]
) => {
	const commandService = accessor.get('ICommandService')
	const editorService = accessor.get('ICodeEditorService')

	// Get editor selection from CodeSelection range
	let editorSelection = undefined;

	// If we have a selection, create an editor selection from the range
	if (range) {
		editorSelection = {
			startLineNumber: range[0],
			startColumn: 1,
			endLineNumber: range[1],
			endColumn: Number.MAX_SAFE_INTEGER,
		};
	}

	// open the file
	commandService.executeCommand('vscode.open', uri).then(() => {

		// select the text
		setTimeout(() => {
			if (!editorSelection) return;

			const editor = editorService.getActiveCodeEditor()
			if (!editor) return;

			editor.setSelection(editorSelection)
			editor.revealRange(editorSelection, ScrollType.Immediate)

		}, 50) // needed when document was just opened and needs to initialize

	})

};


export const SelectedFiles = (
	{ type, selections, setSelections, showProspectiveSelections, messageIdx, }:
		| { type: 'past', selections: StagingSelectionItem[]; setSelections?: undefined, showProspectiveSelections?: undefined, messageIdx: number, }
		| { type: 'staging', selections: StagingSelectionItem[]; setSelections: ((newSelections: StagingSelectionItem[]) => void), showProspectiveSelections?: boolean, messageIdx?: number }
) => {

	const accessor = useAccessor()
	const modelReferenceService = accessor.get('ITroveModelService')




	// state for tracking prospective files
	const { uri: currentURI } = useActiveURI()
	const [recentUris, setRecentUris] = useState<URI[]>([])
	const maxRecentUris = 10
	const maxProspectiveFiles = 3
	useEffect(() => { // handle recent files
		if (!currentURI) return
		setRecentUris(prev => {
			const withoutCurrent = prev.filter(uri => uri.fsPath !== currentURI.fsPath) // remove duplicates
			const withCurrent = [currentURI, ...withoutCurrent]
			return withCurrent.slice(0, maxRecentUris)
		})
	}, [currentURI])
	const [prospectiveSelections, setProspectiveSelections] = useState<StagingSelectionItem[]>([])


	// handle prospective files
	useEffect(() => {
		const computeRecents = async () => {
			const prospectiveURIs = recentUris
				.filter(uri => !selections.find(s => s.type === 'File' && s.uri.fsPath === uri.fsPath))
				.slice(0, maxProspectiveFiles)

			const answer: StagingSelectionItem[] = []
			for (const uri of prospectiveURIs) {
				answer.push({
					type: 'File',
					uri: uri,
					language: (await modelReferenceService.getModelSafe(uri)).model?.getLanguageId() || 'plaintext',
					state: { wasAddedAsCurrentFile: false },
				})
			}
			return answer
		}

		// add a prospective file if type === 'staging' and if the user is in a file, and if the file is not selected yet
		if (type === 'staging' && showProspectiveSelections) {
			computeRecents().then((a) => setProspectiveSelections(a))
		}
		else {
			setProspectiveSelections([])
		}
	}, [recentUris, selections, type, showProspectiveSelections])


	const allSelections = [...selections, ...prospectiveSelections]

	if (selections.length === 0 && allSelections.length === 0) {
		return null
	}

	return (
		<div className='context-pills'>
			<InlineContextPills
				selections={selections}
				setSelections={type === 'staging' ? setSelections : undefined}
				type={type === 'staging' ? 'staging' : 'past'}
			/>
		</div>
	)
}


type ToolHeaderParams = {
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

const ToolHeaderWrapper = ({
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



const getFileContentBeforeEdit = (threadId: string, messageIdx: number, uri: URI, chatThreadsService: { state: { allThreads: Record<string, { messages: ChatMessage[] } | undefined> } }): string => {
	const thread = chatThreadsService.state.allThreads[threadId]
	if (!thread) return ''
	for (let i = messageIdx - 1; i >= 0; i--) {
		const m = thread.messages[i]
		if (m.role === 'checkpoint') {
			const snap = m.voidFileSnapshotOfURI?.[uri.fsPath]
			if (snap?.entireFileCode != null) return snap.entireFileCode
		}
	}
	return ''
}

const EditTool = ({ toolMessage, threadId, messageIdx, content }: Parameters<ResultWrapper<'edit_file' | 'rewrite_file'>>[0] & { content: string }) => {
	const accessor = useAccessor()
	const editCodeService = accessor.get('IEditCodeService')
	const chatThreadsService = accessor.get('IChatThreadService')
	const chatThreadsStreamState = useChatThreadsStreamState(threadId)
	const isRunningThread = chatThreadsStreamState?.isRunning

	const isRejected = toolMessage.type === 'rejected'
	const { params } = toolMessage
	const isRunning = toolMessage.type === 'running_now'
	const editToolType = toolMessage.name === 'edit_file' ? 'diff' : 'rewrite'

	const applyBoxId = getApplyBoxId({
		threadId: threadId,
		messageIdx: messageIdx,
		tokenIdx: 'N/A',
	})
	const { streamState } = useEditToolStreamState({ applyBoxId, uri: params.uri })

	const originalContent = editToolType === 'rewrite'
		? getFileContentBeforeEdit(threadId, messageIdx, params.uri, chatThreadsService)
		: undefined

	const diffStats = computeChatDiff(content, editToolType, originalContent)

	const showAcceptReject = streamState === 'idle-has-changes'
		&& isRunningThread !== 'LLM'
		&& isRunningThread !== 'tool'
		&& (toolMessage.type === 'success' || toolMessage.type === 'rejected' || toolMessage.type === 'running_now' || toolMessage.type === 'tool_request')

	const lintErrors = (toolMessage.type === 'success' || toolMessage.type === 'rejected')
		? toolMessage.result?.lintErrors
		: undefined

	const footer = <>
		{showAcceptReject ? (
			<div className="flex items-center justify-end">
				<ChatInlineDiffButtons
					onAccept={() => editCodeService.acceptOrRejectAllDiffAreas({ uri: params.uri, behavior: 'accept', removeCtrlKs: false })}
					onReject={() => editCodeService.acceptOrRejectAllDiffAreas({ uri: params.uri, behavior: 'reject', removeCtrlKs: false })}
					acceptLabel="Accept"
					rejectLabel="Reject"
				/>
			</div>
		) : null}
		{lintErrors?.length ? <LintErrorChildren lintErrors={lintErrors} /> : null}
		{toolMessage.type === 'tool_error' ? (
			<CodeChildren className='bg-trove-bg-3'>
				{toolMessage.result}
			</CodeChildren>
		) : null}
	</>

	return (
		<EditToolChatBlock
			fileName={getBasename(params.uri.fsPath)}
			filePath={params.uri.fsPath}
			addedLines={diffStats.added}
			removedLines={diffStats.removed}
			onFileClick={() => voidOpenFileFn(params.uri, accessor)}
			isRejected={isRejected}
			isRunning={isRunning}
			footer={showAcceptReject || lintErrors?.length || toolMessage.type === 'tool_error' ? footer : undefined}
		>
			<ChatInlineDiffView
				code={content}
				type={editToolType}
				originalContent={originalContent}
			/>
		</EditToolChatBlock>
	)
}

const SimplifiedToolHeader = ({
	title,
	children,
}: {
	title: string;
	children?: React.ReactNode;
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const isDropdown = children !== undefined;
	return (
		<div>
			<div className="w-full">
				{/* header */}
				<div
					className={`select-none flex items-center min-h-[24px] ${isDropdown ? 'cursor-pointer' : ''}`}
					onClick={() => {
						if (isDropdown) { setIsOpen(v => !v); }
					}}
				>
					{isDropdown && (
						<ChevronRight
							className={`text-trove-fg-3 mr-0.5 h-4 w-4 flex-shrink-0 transition-transform duration-100 ease-[cubic-bezier(0.4,0,0.2,1)] ${isOpen ? 'rotate-90' : ''}`}
						/>
					)}
					<div className="flex items-center w-full overflow-hidden">
						<span className="text-trove-fg-3">{title}</span>
					</div>
				</div>
				{/* children */}
				{<div
					className={`overflow-hidden transition-all duration-200 ease-in-out ${isOpen ? 'opacity-100' : 'max-h-0 opacity-0'} text-trove-fg-4`}
				>
					{children}
				</div>}
			</div>
		</div>
	);
};




const UserMessageComponent = ({ chatMessage, messageIdx, isCheckpointGhost, currCheckpointIdx, _scrollToBottom }: { chatMessage: ChatMessage & { role: 'user' }, messageIdx: number, currCheckpointIdx: number | undefined, isCheckpointGhost: boolean, _scrollToBottom: (() => void) | null }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	// global state
	let isBeingEdited = false
	let stagingSelections: StagingSelectionItem[] = []
	let setIsBeingEdited = (_: boolean) => { }
	let setStagingSelections = (_: StagingSelectionItem[]) => { }

	if (messageIdx !== undefined) {
		const _state = chatThreadsService.getCurrentMessageState(messageIdx)
		isBeingEdited = _state.isBeingEdited
		stagingSelections = _state.stagingSelections
		setIsBeingEdited = (v) => chatThreadsService.setCurrentMessageState(messageIdx, { isBeingEdited: v })
		setStagingSelections = (s) => chatThreadsService.setCurrentMessageState(messageIdx, { stagingSelections: s })
	}


	// local state
	const mode: ChatBubbleMode = isBeingEdited ? 'edit' : 'display'
	const [isFocused, setIsFocused] = useState(false)
	const [isHovered, setIsHovered] = useState(false)
	const [isDisabled, setIsDisabled] = useState(false)
	const [textAreaRefState, setTextAreaRef] = useState<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)
	// initialize on first render, and when edit was just enabled
	const _mustInitialize = useRef(true)
	const _justEnabledEdit = useRef(false)
	useEffect(() => {
		const canInitialize = mode === 'edit' && textAreaRefState
		const shouldInitialize = _justEnabledEdit.current || _mustInitialize.current
		if (canInitialize && shouldInitialize) {
			setStagingSelections(
				(chatMessage.selections || []).map(s => { // quick hack so we dont have to do anything more
					if (s.type === 'File') return { ...s, state: { ...s.state, wasAddedAsCurrentFile: false, } }
					else return s
				})
			)

			if (textAreaFnsRef.current)
				textAreaFnsRef.current.setValue(chatMessage.displayContent || '')

			textAreaRefState.focus();

			_justEnabledEdit.current = false
			_mustInitialize.current = false
		}

	}, [chatMessage, mode, _justEnabledEdit, textAreaRefState, textAreaFnsRef.current, _justEnabledEdit.current, _mustInitialize.current])

	const onOpenEdit = () => {
		setIsBeingEdited(true)
		chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx)
		_justEnabledEdit.current = true
	}
	const onCloseEdit = () => {
		setIsFocused(false)
		setIsHovered(false)
		setIsBeingEdited(false)
		chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)

	}

	const EditSymbol = mode === 'display' ? Pencil : X


	let chatbubbleContents: React.ReactNode
	if (mode === 'display') {
		const committedSelections = chatMessage.selections || []
		chatbubbleContents = <>
			{committedSelections.length > 0 ?
				<div className='mb-2'>
					<SelectedFiles type='past' messageIdx={messageIdx} selections={committedSelections} />
				</div>
				: null}
			{chatMessage.displayContent ?
				<span className='px-0.5 block'>{chatMessage.displayContent}</span>
				: null}
		</>
	}
	else if (mode === 'edit') {

		const onSubmit = async () => {

			if (isDisabled) return;
			if (!textAreaRefState) return;
			if (messageIdx === undefined) return;

			// cancel any streams on this thread
			const threadId = chatThreadsService.state.currentThreadId

			await chatThreadsService.abortRunning(threadId)

			// update state
			setIsBeingEdited(false)
			chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)

			// stream the edit
			const userMessage = textAreaRefState.value;
			try {
				await chatThreadsService.editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId })
			} catch (e) {
				console.error('Error while editing message:', e)
			}
			await chatThreadsService.focusCurrentChat()
			requestAnimationFrame(() => _scrollToBottom?.())
		}

		const onAbort = async () => {
			const threadId = chatThreadsService.state.currentThreadId
			await chatThreadsService.abortRunning(threadId)
		}

		const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Escape') {
				onCloseEdit()
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				onSubmit()
			}
		}

		if (!chatMessage.content) { // don't show if empty and not loading (if loading, want to show).
			return null
		}

		chatbubbleContents = <TroveChatArea
			featureName='Chat'
			onSubmit={onSubmit}
			onAbort={onAbort}
			isStreaming={false}
			isDisabled={isDisabled}
		>
			<TroveInputBox2
				enableAtToMention
				inlineSelections={stagingSelections}
				setInlineSelections={setStagingSelections}
				ref={setTextAreaRef}
				className='min-h-[81px] max-h-[500px] px-0.5'
				placeholder="Edit your message..."
				onChangeText={(text) => setIsDisabled(!text)}
				onFocus={() => {
					setIsFocused(true)
					chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx);
				}}
				onBlur={() => {
					setIsFocused(false)
				}}
				onKeyDown={onKeyDown}
				fnsRef={textAreaFnsRef}
				multiline={true}
			/>
		</TroveChatArea>
	}

	const isMsgAfterCheckpoint = currCheckpointIdx !== undefined && currCheckpointIdx === messageIdx - 1

	return <div
		// align chatbubble according to role — full-width Cursor-style user prompt
		className={`
        relative w-full
        ${mode === 'edit' ? 'max-w-full'
				: mode === 'display' ? `whitespace-pre-wrap` : ''
			}

        ${isCheckpointGhost && !isMsgAfterCheckpoint ? 'opacity-50 pointer-events-none' : ''}
    `}
		onMouseEnter={() => setIsHovered(true)}
		onMouseLeave={() => setIsHovered(false)}
	>
		<div
			// style chatbubble according to role
			className={`
            text-left rounded-xl max-w-full
            ${mode === 'edit' ? ''
					: mode === 'display' ? 'px-3 py-2.5 flex flex-col glass-card text-trove-fg-1 overflow-x-auto cursor-pointer' : ''
				}
        `}
			onClick={() => { if (mode === 'display') { onOpenEdit() } }}
		>
			{chatbubbleContents}
		</div>



		<div
			className="absolute -top-1 -right-1 translate-x-0 -translate-y-0 z-1"
		// data-tooltip-id='trove-tooltip'
		// data-tooltip-content='Edit message'
		// data-tooltip-place='left'
		>
			<EditSymbol
				size={18}
				className={`
                    cursor-pointer
                    p-[2px]
                    bg-trove-bg-1 border border-trove-border-1 rounded-md
                    transition-opacity duration-200 ease-in-out
                    ${isHovered || (isFocused && mode === 'edit') ? 'opacity-100' : 'opacity-0'}
                `}
				onClick={() => {
					if (mode === 'display') {
						onOpenEdit()
					} else if (mode === 'edit') {
						onCloseEdit()
					}
				}}
			/>
		</div>


	</div>

}

const SmallProseWrapper = ({ children }: { children: React.ReactNode }) => {
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

const ProseWrapper = ({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'default' | 'assistant-summary' }) => {
	const summaryClass = variant === 'assistant-summary' ? ' trove-assistant-summary-prose' : ''
	return <div className={`text-trove-fg-2 prose prose-sm break-words prose-p:block prose-hr:my-4 prose-pre:my-2 marker:text-inherit prose-ol:list-outside prose-ol:list-decimal prose-ul:list-outside prose-ul:list-disc prose-li:my-0 prose-code:before:content-none prose-code:after:content-none prose-headings:prose-sm prose-headings:font-bold prose-p:leading-normal prose-p:my-1 prose-ol:leading-normal prose-ul:leading-normal max-w-none${summaryClass}`}>
		{children}
	</div>
}
const AssistantMessageComponent = ({ chatMessage, isCheckpointGhost, isCommitted, messageIdx }: { chatMessage: ChatMessage & { role: 'assistant' }, isCheckpointGhost: boolean, messageIdx: number, isCommitted: boolean }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	const anthropicText = formatAnthropicReasoning(chatMessage.anthropicReasoning)
	const reasoningStr = [chatMessage.reasoning?.trim(), anthropicText].filter(Boolean).join('\n\n') || null
	const hasReasoning = !!reasoningStr
	const hasDisplayContent = !!chatMessage.displayContent?.trim()
	const thread = chatThreadsService.getCurrentThread()


	const chatMessageLocation: ChatMessageLocation = {
		threadId: thread.id,
		messageIdx: messageIdx,
	}

	const isEmpty = !chatMessage.displayContent && !hasReasoning
	if (isEmpty) return null

	return <>
		{/* reasoning */}
		{hasReasoning &&
			<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<LiveReasoningBlock
					reasoning={chatMessage.reasoning ?? null}
					anthropicReasoning={chatMessage.anthropicReasoning}
					hasDisplayContent={hasDisplayContent}
					isStreaming={!isCommitted}
				>
					{!isCommitted ? (
						<span>{reasoningStr}</span>
					) : (
						<SmallProseWrapper>
							<ChatMarkdownRender
								string={reasoningStr ?? ''}
								chatMessageLocation={chatMessageLocation}
								isApplyEnabled={false}
								isLinkDetectionEnabled={true}
							/>
						</SmallProseWrapper>
					)}
				</LiveReasoningBlock>
			</div>
		}

		{/* assistant message */}
		{chatMessage.displayContent &&
			<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<ProseWrapper variant={isCommitted ? 'assistant-summary' : 'default'}>
					<ChatMarkdownRender
						string={chatMessage.displayContent || ''}
						chatMessageLocation={chatMessageLocation}
						isApplyEnabled={true}
						isLinkDetectionEnabled={true}
					/>
				</ProseWrapper>
			</div>
		}
	</>

}




// should either be past or "-ing" tense, not present tense. Eg. when the LLM searches for something, the user expects it to say "I searched for X" or "I am searching for X". Not "I search X".

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


const getTitle = (toolMessage: Pick<ChatMessage & { role: 'tool' }, 'name' | 'type' | 'mcpServerName'>): React.ReactNode => {
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


const toolNameToDesc = (toolName: BuiltinToolName, _toolParams: BuiltinToolCallParams[BuiltinToolName] | undefined, accessor: ReturnType<typeof useAccessor>): {
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
		}
	}

	try {
		return x[toolName]?.() || { desc1: '' }
	}
	catch {
		return { desc1: '' }
	}
}

const RunningToolActivityRow = ({ toolMessage }: { toolMessage: Exclude<ToolMessage, { type: 'invalid_params' }> }) => {
	const accessor = useAccessor()
	const title = getTitle(toolMessage)
	const desc1 = isABuiltinToolName(toolMessage.name)
		? toolNameToDesc(toolMessage.name, toolMessage.params, accessor).desc1
		: removeMCPToolNamePrefix(toolMessage.name)
	return <CompactActivityRow label={title} detail={desc1} isActive />
}

const ToolRequestAcceptRejectButtons = ({ toolName }: { toolName: ToolName }) => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	const metricsService = accessor.get('IMetricsService')
	const troveSettingsService = accessor.get('ITroveSettingsService')
	const troveSettingsState = useSettingsState()

	const onAccept = useCallback(() => {
		try { // this doesn't need to be wrapped in try/catch anymore
			const threadId = chatThreadsService.state.currentThreadId
			chatThreadsService.approveLatestToolRequest(threadId)
			metricsService.capture('Tool Request Accepted', {})
		} catch (e) { console.error('Error while approving message in chat:', e) }
	}, [chatThreadsService, metricsService])

	const onReject = useCallback(() => {
		try {
			const threadId = chatThreadsService.state.currentThreadId
			chatThreadsService.rejectLatestToolRequest(threadId)
		} catch (e) { console.error('Error while approving message in chat:', e) }
		metricsService.capture('Tool Request Rejected', {})
	}, [chatThreadsService, metricsService])

	const approvalType = isABuiltinToolName(toolName) ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
	const approvalToggle = approvalType ? <div key={approvalType} className="flex items-center ml-2 gap-x-1">
		<ToolApprovalTypeSwitch size='xs' approvalType={approvalType} desc={`Auto-approve ${approvalType}`} />
	</div> : null

	return <div className="flex gap-2 mx-0.5 items-center py-1">
		<ChatInlineDiffButtons
			onAccept={onAccept}
			onReject={onReject}
			acceptLabel="Approve"
			rejectLabel="Cancel"
		/>
		{approvalToggle}
	</div>
}

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



const LintErrorChildren = ({ lintErrors }: { lintErrors: LintErrorItem[] }) => {
	return <div className="text-xs text-trove-fg-4 opacity-80 border-l-2 border-trove-warning px-2 py-0.5 flex flex-col gap-0.5 overflow-x-auto whitespace-nowrap">
		{lintErrors.map((error, i) => (
			<div key={i}>Lines {error.startLineNumber}-{error.endLineNumber}: {error.message}</div>
		))}
	</div>
}

const BottomChildren = ({ children, title }: { children: React.ReactNode, title: string }) => {
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
}


const InvalidTool = ({ toolName, message, mcpServerName }: { toolName: ToolName, message: string, mcpServerName: string | undefined }) => {
	const accessor = useAccessor()
	const title = getTitle({ name: toolName, type: 'invalid_params', mcpServerName })
	const desc1 = 'Invalid parameters'
	const icon = null
	const isError = true
	const componentParams: ToolHeaderParams = { title, desc1, isError, icon }

	componentParams.children = <ToolChildrenWrapper>
		<CodeChildren className='bg-trove-bg-3'>
			{message}
		</CodeChildren>
	</ToolChildrenWrapper>
	return <ToolHeaderWrapper {...componentParams} />
}

const CanceledTool = ({ toolName, mcpServerName }: { toolName: ToolName, mcpServerName: string | undefined }) => {
	const accessor = useAccessor()
	const title = getTitle({ name: toolName, type: 'rejected', mcpServerName })
	const desc1 = ''
	const icon = null
	const isRejected = true
	const componentParams: ToolHeaderParams = { title, desc1, icon, isRejected }
	return <ToolHeaderWrapper {...componentParams} />
}


const TerminalSuccessCard = ({
	label,
	command,
	output,
	defaultExpanded = false,
}: {
	label: string;
	command?: string;
	output: string;
	defaultExpanded?: boolean;
}) => {
	const [expanded, setExpanded] = useState(defaultExpanded)
	const preview = output.trim().split('\n').filter(l => l.trim()).slice(0, 5).join('\n')
	const hasOutput = preview.length > 0
	return (
		<div className="trove-terminal-success-card">
			<div className="trove-terminal-success-card-header">
				<Check size={14} className="text-[var(--vscode-testing-iconPassed,#3fb950)] shrink-0" />
				<div className="min-w-0 flex-1">
					<div className="text-[13px] font-medium text-trove-fg-1">{label}</div>
					{command && <div className="text-[11px] text-trove-fg-4 truncate font-mono mt-0.5">{command}</div>}
					{!expanded && hasOutput && (
						<pre className="text-[11px] text-trove-fg-3 mt-1.5 whitespace-pre-wrap font-mono line-clamp-4 max-h-20 overflow-hidden">{preview}</pre>
					)}
				</div>
				{hasOutput && (
					<button
						type="button"
						className="trove-terminal-success-toggle"
						onClick={() => setExpanded(v => !v)}
					>
						{expanded ? 'Hide output' : 'Show output'}
					</button>
				)}
			</div>
			{expanded && hasOutput && (
				<div className="trove-terminal-success-card-body trove-chat-terminal-output">
					<AnsiTerminalOutput text={output} />
				</div>
			)}
		</div>
	)
}

const terminalSuccessLabel = (
	command: string,
	resolveReason: { type: string; exitCode?: number; reason?: string },
): string => {
	if (resolveReason.type === 'server_ready') return 'Dev server ready'
	if (resolveReason.type === 'timeout' && resolveReason.reason === 'snapshot') return 'Dev server running in background'
	if (/\b(curl|wget|httpie|httpx)\b/i.test(command) && /\b(localhost|127\.0\.0\.1)\b/i.test(command)) {
		return resolveReason.type === 'done' && resolveReason.exitCode === 0
			? 'Localhost check passed'
			: 'Ran localhost check'
	}
	if (/\b(npm|pnpm|yarn)\s+(install|ci|add)\b/i.test(command)) return 'Dependencies installed'
	if (/\b(compile|build|test|tsc|webpack|vite)\b/i.test(command)) return 'Build completed'
	if (resolveReason.type === 'done' && resolveReason.exitCode === 0) return 'Command succeeded'
	return 'Command finished'
}

const formatElapsed = (seconds: number): string => {
	if (seconds < 60) return `${seconds}s`
	const m = Math.floor(seconds / 60)
	const s = seconds % 60
	return s > 0 ? `${m}m ${s}s` : `${m}m`
}

const RunningTerminalOutput = ({
	type,
	toolMessage,
	liveContent,
}: {
	type: 'run_command' | 'run_persistent_command'
	toolMessage: Exclude<ToolMessage<'run_command' | 'run_persistent_command'>, { type: 'invalid_params' }> & { type: 'running_now' }
	liveContent?: string
}) => {
	const [elapsedSec, setElapsedSec] = useState(0)
	const startedAtRef = useRef(Date.now())

	useEffect(() => {
		startedAtRef.current = Date.now()
		setElapsedSec(0)
		const id = setInterval(() => {
			setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000))
		}, 1000)
		return () => clearInterval(id)
	}, [toolMessage.id])

	const command = toolMessage.params.command
	const outputText = liveContent?.trim()
	const isInstall = /\b(npm|pnpm|yarn|bun)\s+(install|ci|add)\b/i.test(command)
	const onlyCommandEcho = !outputText || outputText === `$ ${command}` || outputText === `$ ${command}\n`
	const waitingForOutput = onlyCommandEcho

	return (
		<ToolChildrenWrapper className='overflow-hidden text-sm'>
			<div className='flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-trove-fg-4 border-b border-trove-border-3 bg-trove-bg-2'>
				<span className='truncate font-mono'>{command}</span>
				<span className='shrink-0 tabular-nums'>{formatElapsed(elapsedSec)}</span>
			</div>
			<div className='relative min-h-[200px] max-h-[320px] overflow-auto trove-chat-terminal-output px-2 py-2 bg-[var(--vscode-terminal-background,#1e1e1e)]'>
				{waitingForOutput ? (
					<div className='flex flex-col gap-2 text-trove-fg-4 text-[12px] py-4'>
						<div className='flex items-center gap-2'>
							<span className='inline-block w-1.5 h-1.5 rounded-full bg-trove-fg-4 animate-pulse' />
							{isInstall ? 'Installing dependencies…' : 'Running command…'}
						</div>
						{isInstall && elapsedSec > 15 ? (
							<p className='text-[11px] opacity-80 pl-3.5'>Large projects can take 1–3 minutes. Output will stream here as npm runs.</p>
						) : null}
					</div>
				) : (
					<AnsiTerminalOutput text={outputText!} />
				)}
			</div>
		</ToolChildrenWrapper>
	)
}

const CommandTool = ({ toolMessage, type, threadId }: { threadId: string } & ({
	toolMessage: Exclude<ToolMessage<'run_command'>, { type: 'invalid_params' }>
	type: 'run_command'
} | {
	toolMessage: Exclude<ToolMessage<'run_persistent_command'>, { type: 'invalid_params' }>
	type: | 'run_persistent_command'
})) => {
	const accessor = useAccessor()

	const commandService = accessor.get('ICommandService')
	const isError = false
	const title = getTitle(toolMessage)
	const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
	const icon = null

	const isRejected = toolMessage.type === 'rejected'
	const { rawParams, params } = toolMessage
	const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

	if (toolMessage.type === 'success') {
		const { result } = toolMessage

		if (type === 'run_persistent_command') {
			componentParams.info = persistentTerminalNameOfId(toolMessage.params.persistentTerminalId)
		}

		const command = toolMessage.params.command
		const { result: raw, resolveReason } = result
		const terminalDisplayText = (() => {
			if (resolveReason.type === 'done') return `${raw.trim()}\n(exit code ${resolveReason.exitCode})`
			return raw.trim()
		})()

		const successLabel = terminalSuccessLabel(command, resolveReason)
		const isCompact = type === 'run_command' || resolveReason.type === 'server_ready' || (resolveReason.type === 'timeout' && resolveReason.reason === 'snapshot')

		componentParams.children = <ToolChildrenWrapper className='overflow-auto text-sm'>
			{isCompact ? (
				<TerminalSuccessCard
					label={successLabel}
					command={command}
					output={terminalDisplayText}
				/>
			) : (
				<div className='!select-text cursor-auto trove-chat-terminal-output'>
					<AnsiTerminalOutput text={terminalDisplayText} />
				</div>
			)}
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
	else if (toolMessage.type === 'running_now') {
		const liveContent = toolMessage.content?.trim() ?? ''
		componentParams.children = <RunningTerminalOutput
			type={type}
			toolMessage={toolMessage}
			liveContent={liveContent.startsWith('(starting terminal sandbox') ? undefined : liveContent || undefined}
		/>
	}
	else if (toolMessage.type === 'rejected' || toolMessage.type === 'tool_request') {
	}

	return <>
		<ToolHeaderWrapper {...componentParams} isOpen={(type === 'run_command' || type === 'run_persistent_command') && toolMessage.type === 'running_now' ? true : undefined} />
	</>
}

type WrapperProps<T extends ToolName> = { toolMessage: Exclude<ToolMessage<T>, { type: 'invalid_params' }>, messageIdx: number, threadId: string }
const MCPToolWrapper = ({ toolMessage }: WrapperProps<string>) => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')

	const title = getTitle(toolMessage)
	const desc1 = removeMCPToolNamePrefix(toolMessage.name)
	const icon = null


	if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

	const isError = false
	const isRejected = toolMessage.type === 'rejected'
	const { rawParams, params } = toolMessage
	const componentParams: ToolHeaderParams = { title, desc1, isError, icon, isRejected, }

	const paramsStr = JSON.stringify(params, null, 2)
	componentParams.desc2 = <CopyButton codeStr={paramsStr} toolTipName={`Copy inputs: ${paramsStr}`} />

	componentParams.info = !toolMessage.mcpServerName ? 'MCP tool not found' : undefined

	// Add copy inputs button in desc2


	if (toolMessage.type === 'success' || toolMessage.type === 'tool_request') {
		const { result } = toolMessage
		const resultStr = result ? mcpService.stringifyResult(result) : 'null'
		componentParams.children = <ToolChildrenWrapper>
			<SmallProseWrapper>
				<ChatMarkdownRender
					string={`\`\`\`json\n${resultStr}\n\`\`\``}
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

type ResultWrapper<T extends ToolName> = (props: WrapperProps<T>) => React.ReactNode

const builtinToolNameToComponent: { [T in BuiltinToolName]: { resultWrapper: ResultWrapper<T>, } } = {
	'read_file': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

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
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null


			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			componentParams.info = getRelative(params.uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'rejected') {
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				if (params) { componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) } }
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			else if (toolMessage.type === 'running_now') {
				// nothing more is needed
			}
			else if (toolMessage.type === 'tool_request') {
				// nothing more is needed
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'delete_file_or_folder': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isFolder = toolMessage.params?.isFolder ?? false
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = null

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			componentParams.info = getRelative(params.uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'rejected') {
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				if (params) { componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) } }
				componentParams.bottomChildren = <BottomChildren title='Error'>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			else if (toolMessage.type === 'running_now') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_request') {
				const { result } = toolMessage
				componentParams.onClick = () => { voidOpenFileFn(params.uri, accessor) }
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
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
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const terminalToolsService = accessor.get('ITerminalToolService')

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const title = getTitle(toolMessage)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			const relativePath = params.cwd ? getRelative(URI.file(params.cwd), accessor) : ''
			componentParams.info = relativePath ? `Running in ${relativePath}` : undefined

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				const { persistentTerminalId } = result
				componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId)
				componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId)
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
		},
	},
	'kill_persistent_terminal': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const terminalToolsService = accessor.get('ITerminalToolService')

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const title = getTitle(toolMessage)
			const icon = null

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (toolMessage.type === 'success') {
				const { persistentTerminalId } = params
				componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId)
				componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId)
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
		},
	},
};


const Checkpoint = ({ message, threadId, messageIdx, isCheckpointGhost, threadIsRunning }: { message: CheckpointEntry, threadId: string; messageIdx: number, isCheckpointGhost: boolean, threadIsRunning: boolean }) => {
	const accessor = useAccessor()
	const chatThreadService = accessor.get('IChatThreadService')
	const streamState = useFullChatThreadsStreamState()

	const isRunning = useChatThreadsStreamState(threadId)?.isRunning
	const isDisabled = useMemo(() => {
		if (isRunning) return true
		return !!Object.keys(streamState).find((threadId2) => streamState[threadId2]?.isRunning)
	}, [isRunning, streamState])

	return <div
		className={`flex items-center justify-center px-2 `}
	>
		<div
			className={`
                    text-xs
                    text-trove-fg-3
                    select-none
                    ${isCheckpointGhost ? 'opacity-50' : 'opacity-100'}
					${isDisabled ? 'cursor-default' : 'cursor-pointer'}
                `}
			style={{ position: 'relative', display: 'inline-block' }} // allow absolute icon
			onClick={() => {
				if (threadIsRunning) return
				if (isDisabled) return
				chatThreadService.jumpToCheckpointBeforeMessageIdx({
					threadId,
					messageIdx,
					jumpToUserModified: messageIdx === (chatThreadService.state.allThreads[threadId]?.messages.length ?? 0) - 1
				})
			}}
			{...isDisabled ? {
				'data-tooltip-id': 'trove-tooltip',
				'data-tooltip-content': `Disabled ${isRunning ? 'when running' : 'because another thread is running'}`,
				'data-tooltip-place': 'top',
			} : {}}
		>
			Checkpoint
		</div>
	</div>
}


type ChatBubbleMode = 'display' | 'edit'
type ChatBubbleProps = {
	chatMessage: ChatMessage,
	messageIdx: number,
	isCommitted: boolean,
	chatIsRunning: IsRunningType,
	threadId: string,
	currCheckpointIdx: number | undefined,
	_scrollToBottom: (() => void) | null,
}

const ChatBubble = (props: ChatBubbleProps) => {
	return <ErrorBoundary>
		<_ChatBubble {...props} />
	</ErrorBoundary>
}

const _ChatBubble = ({ threadId, chatMessage, currCheckpointIdx, isCommitted, messageIdx, chatIsRunning, _scrollToBottom }: ChatBubbleProps) => {
	const role = chatMessage.role

	const isCheckpointGhost = messageIdx > (currCheckpointIdx ?? Infinity) && !chatIsRunning // whether to show as gray (if chat is running, for good measure just dont show any ghosts)

	if (role === 'user') {
		return <UserMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			currCheckpointIdx={currCheckpointIdx}
			messageIdx={messageIdx}
			_scrollToBottom={_scrollToBottom}
		/>
	}
	else if (role === 'assistant') {
		return <AssistantMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			messageIdx={messageIdx}
			isCommitted={isCommitted}
		/>
	}
	else if (role === 'tool') {

		if (chatMessage.type === 'invalid_params') {
			return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<InvalidTool toolName={chatMessage.name} message={chatMessage.content} mcpServerName={chatMessage.mcpServerName} />
			</div>
		}

		const toolName = chatMessage.name
		const isBuiltInTool = isABuiltinToolName(toolName)
		const ToolResultWrapper = isBuiltInTool ? builtinToolNameToComponent[toolName]?.resultWrapper as ResultWrapper<ToolName>
			: MCPToolWrapper as ResultWrapper<ToolName>

		if (ToolResultWrapper)
			return <>
				<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
					<ToolResultWrapper
						toolMessage={chatMessage}
						messageIdx={messageIdx}
						threadId={threadId}
					/>
				</div>
				{chatMessage.type === 'tool_request' ?
					<div className={`${isCheckpointGhost ? 'opacity-50 pointer-events-none' : ''}`}>
						<ToolRequestAcceptRejectButtons toolName={chatMessage.name} />
					</div> : null}
			</>
		return null
	}

	else if (role === 'interrupted_streaming_tool') {
		return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
			<CanceledTool toolName={chatMessage.name} mcpServerName={chatMessage.mcpServerName} />
		</div>
	}

	else if (role === 'checkpoint') {
		return <Checkpoint
			threadId={threadId}
			message={chatMessage}
			messageIdx={messageIdx}
			isCheckpointGhost={isCheckpointGhost}
			threadIsRunning={!!chatIsRunning}
		/>
	}
	else if (role === 'plan') {
		return <PlanView plan={chatMessage} isCheckpointGhost={isCheckpointGhost} />
	}

}

const EditToolSoFar = ({ toolCallSoFar, }: { toolCallSoFar: RawToolCallObj }) => {

	if (!isABuiltinToolName(toolCallSoFar.name)) return null

	const accessor = useAccessor()
	const isEditFile = toolCallSoFar.name === 'edit_file'
	const editToolType = isEditFile ? 'diff' : 'rewrite'

	const uri = toolCallSoFar.rawParams.uri ? URI.file(toolCallSoFar.rawParams.uri) : undefined
	const code = toolCallSoFar.rawParams.search_replace_blocks ?? toolCallSoFar.rawParams.new_content ?? ''
	const streamingDiff = uri ? computeChatDiff(code, editToolType) : undefined

	return (
		<StreamingEditToolCard
			toolCallSoFar={toolCallSoFar}
			addedLines={streamingDiff?.added}
			removedLines={streamingDiff?.removed}
			filePath={uri?.fsPath}
			onFileClick={uri ? () => voidOpenFileFn(uri, accessor) : undefined}
		>
			{uri ? (
				<ChatInlineDiffView code={code} type={editToolType} />
			) : null}
		</StreamingEditToolCard>
	)

}


export const SidebarChat = () => {
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const chatThreadsService = accessor.get('IChatThreadService')

	const settingsState = useSettingsState()
	// ----- HIGHER STATE -----

	// threads state
	const chatThreadsState = useChatThreadsState()

	const currentThread = chatThreadsService.getCurrentThread()
	const previousMessages = currentThread?.messages ?? []

	const selections = currentThread.state.stagingSelections
	const setSelections = (s: StagingSelectionItem[]) => { chatThreadsService.setCurrentThreadState({ stagingSelections: s }) }

	// stream state
	const currThreadStreamState = useChatThreadsStreamState(chatThreadsState.currentThreadId)
	const isRunning = currThreadStreamState?.isRunning
	const latestError = currThreadStreamState?.error
	const { displayContentSoFar, toolCallSoFar, reasoningSoFar } = currThreadStreamState?.llmInfo ?? {}
	const runningToolInfo = currThreadStreamState?.isRunning === 'tool' ? currThreadStreamState.toolInfo : undefined
	const idleStatus = currThreadStreamState?.isRunning === 'idle' ? currThreadStreamState.idleStatus : undefined
	const contextWasTrimmed = !!(currThreadStreamState?.contextWasTrimmed && (isRunning === 'LLM' || isRunning === 'idle'))

	// this is just if it's currently being generated, NOT if it's currently running
	const toolIsGenerating = toolCallSoFar && !toolCallSoFar.isDone // show loading for slow tools (right now just edit)

	const liveActivityDetail = runningToolInfo
		? (isABuiltinToolName(runningToolInfo.toolName)
			? String(toolNameToDesc(runningToolInfo.toolName, runningToolInfo.toolParams, accessor).desc1 ?? '')
			: removeMCPToolNamePrefix(runningToolInfo.toolName))
		: undefined

	const turnActivitySummary = useMemo(
		() => summarizeAgentTurnActivity(previousMessages),
		[previousMessages],
	)

	const modelSelection = settingsState.modelSelectionOfFeature['Chat']
	const modelLabel = modelSelection?.modelName ?? 'model'
	const chatMode = settingsState.globalSettings.chatMode
	const chatModeLabel = chatMode === 'agent' ? 'Agent' : chatMode === 'gather' ? 'Gather' : 'Chat'

	const backgroundActivity = useMemo((): { phase: BackgroundActivityPhase; title: string; detail?: string; contextLine?: string } | null => {
		if (!isRunning) return null

		if (isRunning === 'awaiting_user') {
			return {
				phase: 'awaiting',
				title: 'Waiting for your approval',
				detail: 'Review the pending tool request before the agent continues.',
			}
		}

		if (isRunning === 'tool' && runningToolInfo) {
			const runningToolTitle = isABuiltinToolName(runningToolInfo.toolName)
				? ({
					read_file: 'Reading file',
					ls_dir: 'Inspecting folder',
					get_dir_tree: 'Inspecting folder tree',
					search_pathnames_only: 'Searching by file name',
					search_for_files: 'Searching files',
					search_codebase: 'Searching codebase',
					search_web: 'Searching the web',
					search_in_file: 'Searching in file',
					create_file_or_folder: 'Creating path',
					delete_file_or_folder: 'Deleting path',
					edit_file: 'Editing file',
					rewrite_file: 'Writing file',
					run_command: 'Running terminal command',
					run_persistent_command: 'Running terminal command',
					open_persistent_terminal: 'Opening terminal',
					kill_persistent_terminal: 'Closing terminal',
					read_lint_errors: 'Reading lint errors',
				} as Partial<Record<BuiltinToolName, string>>)[runningToolInfo.toolName] ?? 'Running tool'
				: `Calling ${runningToolInfo.mcpServerName ?? 'MCP tool'}`

			const isTerminalTool = runningToolInfo.toolName === 'run_command' || runningToolInfo.toolName === 'run_persistent_command'
			const terminalLive = runningToolInfo.content?.trim() ?? ''
			const terminalHasOutput = isTerminalTool && terminalLive.length > 0
				&& !terminalLive.startsWith('(starting terminal sandbox')
				&& terminalLive !== '(waiting for terminal output…)'
				&& terminalLive !== '(value not received yet...)'
				&& terminalLive !== 'interrupted...'
			const terminalPreview = terminalHasOutput
				? (terminalLive.split('\n').filter(l => l.trim()).pop()?.trim().slice(0, 120) ?? undefined)
				: undefined

			return {
				phase: 'tool',
				title: runningToolTitle,
				detail: terminalPreview
					? terminalPreview
					: (liveActivityDetail ? String(liveActivityDetail) : (isTerminalTool ? 'Starting sandbox…' : 'Executing in your workspace')),
				contextLine: turnActivitySummary.summaryLine,
			}
		}

		if (isRunning === 'idle') {
			return {
				phase: 'preparing',
				title: idleStatus?.title ?? 'Preparing next model call',
				detail: idleStatus?.detail ?? (turnActivitySummary.summaryLine
					? `${chatModeLabel} mode · ${turnActivitySummary.summaryLine}`
					: `${chatModeLabel} mode · assembling conversation context for ${modelLabel}`),
				contextLine: turnActivitySummary.recentFilesLine,
			}
		}

		if (isRunning === 'LLM') {
			if (displayContentSoFar?.trim()) {
				return {
					phase: 'writing',
					title: 'Writing response',
					detail: `${displayContentSoFar.length.toLocaleString()} characters streamed so far`,
				}
			}

			if (reasoningSoFar?.trim()) {
				return {
					phase: 'reasoning',
					title: 'Reasoning',
					detail: `${reasoningSoFar.length.toLocaleString()} characters of internal reasoning received`,
				}
			}

			return {
				phase: 'waiting',
				title: `Waiting for ${modelLabel}`,
				detail: turnActivitySummary.fileCount > 0
					? `Analyzing ${turnActivitySummary.fileCount} file${turnActivitySummary.fileCount === 1 ? '' : 's'} read this turn before replying`
					: turnActivitySummary.toolCount > 0
						? `Processing ${turnActivitySummary.summaryLine ?? `${turnActivitySummary.toolCount} tool result${turnActivitySummary.toolCount === 1 ? '' : 's'}`}`
						: `${chatModeLabel} mode · sending request to the model`,
				contextLine: turnActivitySummary.recentFilesLine,
			}
		}

		return null
	}, [
		isRunning,
		runningToolInfo,
		liveActivityDetail,
		turnActivitySummary,
		modelLabel,
		chatModeLabel,
		idleStatus,
		displayContentSoFar,
		reasoningSoFar,
	])

	const showBackgroundActivity = !!isRunning
		&& !toolIsGenerating
		&& !(isRunning === 'LLM' && !!displayContentSoFar?.trim())
		&& !(isRunning === 'LLM' && !!reasoningSoFar?.trim() && !displayContentSoFar?.trim())

	const activityPanelProps = backgroundActivity ?? (isRunning ? {
		phase: 'preparing' as const,
		title: idleStatus?.title ?? 'Working',
		detail: idleStatus?.detail,
		contextLine: undefined,
	} : null)

	const streamingStatusText = backgroundActivity
		? [backgroundActivity.title, backgroundActivity.detail].filter(Boolean).join(' · ')
		: isRunning ? 'Working…' : undefined

	// ----- SIDEBAR CHAT state (local) -----

	// state of current message
	const initVal = ''
	const [instructionsAreEmpty, setInstructionsAreEmpty] = useState(!initVal)

	const isDisabled = instructionsAreEmpty || !!isFeatureNameDisabled('Chat', settingsState)

	const sidebarRef = useRef<HTMLDivElement>(null)
	const scrollContainerRef = useRef<HTMLDivElement | null>(null)
	const onSubmit = useCallback(async (_forceSubmit?: string) => {

		if (isDisabled && !_forceSubmit) return
		if (isRunning) return

		const threadId = chatThreadsService.state.currentThreadId

		// send message to LLM
		const userMessage = _forceSubmit || textAreaRef.current?.value || ''

		try {
			await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, threadId })
		} catch (e) {
			console.error('Error while sending message in chat:', e)
		}

		setSelections([]) // clear staging
		textAreaFnsRef.current?.setValue('')
		textAreaRef.current?.focus() // focus input after submit

	}, [chatThreadsService, isDisabled, isRunning, textAreaRef, textAreaFnsRef, setSelections, settingsState])

	const onAbort = async () => {
		const threadId = currentThread.id
		await chatThreadsService.abortRunning(threadId)
	}

	const threadId = currentThread.id
	const agentDelivery = useAgentDelivery(threadId)
	const currCheckpointIdx = chatThreadsState.allThreads[threadId]?.state?.currCheckpointIdx ?? undefined  // if not exist, treat like checkpoint is last message (infinity)



	// resolve mount info
	const isResolved = chatThreadsState.allThreads[threadId]?.state.mountedInfo?.mountedIsResolvedRef.current
	useEffect(() => {
		if (isResolved) return
		chatThreadsState.allThreads[threadId]?.state.mountedInfo?._whenMountedResolver?.({
			textAreaRef: textAreaRef,
			scrollToBottom: () => scrollToBottom(scrollContainerRef),
		})

	}, [chatThreadsState, threadId, textAreaRef, scrollContainerRef, isResolved])




	const previousMessagesHTML = useMemo(() => {
		// const lastMessageIdx = previousMessages.findLastIndex(v => v.role !== 'checkpoint')
		// tool request shows up as Editing... if in progress
		return previousMessages.map((message, i) => {
			return <ChatBubble
				key={i}
				currCheckpointIdx={currCheckpointIdx}
				chatMessage={message}
				messageIdx={i}
				isCommitted={true}
				chatIsRunning={isRunning}
				threadId={threadId}
				_scrollToBottom={() => scrollToBottom(scrollContainerRef)}
			/>
		})
	}, [previousMessages, threadId, currCheckpointIdx, isRunning])

	const streamingChatIdx = previousMessagesHTML.length
	const currStreamingMessageHTML = (isRunning === 'LLM' && (reasoningSoFar || displayContentSoFar)) || displayContentSoFar ?
		<ChatBubble
			key={'curr-streaming-msg'}
			currCheckpointIdx={currCheckpointIdx}
			chatMessage={{
				role: 'assistant',
				displayContent: displayContentSoFar ?? '',
				reasoning: reasoningSoFar ?? '',
				anthropicReasoning: null,
			}}
			messageIdx={streamingChatIdx}
			isCommitted={false}
			chatIsRunning={isRunning}

			threadId={threadId}
			_scrollToBottom={null}
		/> : null


	// the tool currently being generated
	const generatingTool = toolIsGenerating ?
		toolCallSoFar.name === 'edit_file' || toolCallSoFar.name === 'rewrite_file' ? <EditToolSoFar
			key={'curr-streaming-tool'}
			toolCallSoFar={toolCallSoFar}
		/>
			: null
		: null

	const messagesHTML = <ScrollToBottomContainer
		key={'messages' + chatThreadsState.currentThreadId} // force rerender on all children if id changes
		scrollContainerRef={scrollContainerRef}
		className={`
			flex flex-col
			px-3 py-2 space-y-0.5
			w-full h-full
			overflow-x-hidden
			overflow-y-auto
			${previousMessagesHTML.length === 0 && !displayContentSoFar && !reasoningSoFar && !isRunning ? 'hidden' : ''}
		`}
	>
		{/* previous messages */}
		{previousMessagesHTML}
		{currStreamingMessageHTML}

		{/* Generating tool */}
		{generatingTool}

		{/* context window trim notice */}
		{contextWasTrimmed ?
			<div className='px-2 py-1 text-xs text-trove-fg-4 italic'>
				Older context was trimmed to fit the model&apos;s window.
			</div>
			: null}

		{/* live activity — hide while reasoning stream or edit tool generation is visible */}
		{showBackgroundActivity && activityPanelProps ?
			<BackgroundActivityPanel
				phase={activityPanelProps.phase}
				title={activityPanelProps.title}
				detail={activityPanelProps.detail}
				contextLine={activityPanelProps.contextLine}
			/> : null}


		{/* error message */}
		{latestError === undefined ? null :
			<div className='px-2 my-1'>
				<ErrorDisplay
					message={latestError.message}
					fullError={latestError.fullError}
					onDismiss={() => { chatThreadsService.dismissStreamError(currentThread.id) }}
					showDismiss={true}
				/>

				<WarningBox className='text-sm my-2 mx-4' onClick={() => { commandService.executeCommand(TROVE_OPEN_SETTINGS_ACTION_ID) }} text='Open settings' />
			</div>
		}

		{/* delivery summary — shown after agent verifies build/server/preview */}
		{!isRunning && agentDelivery ?
			<div className="px-1 pb-2">
				<AgentDeliverySummaryCard delivery={agentDelivery} threadId={currentThread.id} />
			</div>
			: null}
	</ScrollToBottomContainer>


	const onChangeText = useCallback((newStr: string) => {
		setInstructionsAreEmpty(!newStr)
	}, [setInstructionsAreEmpty])
	const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			onSubmit()
		} else if (e.key === 'Escape' && isRunning) {
			onAbort()
		}
	}, [onSubmit, onAbort, isRunning])

	const inputChatArea = <TroveChatArea
		featureName='Chat'
		onSubmit={() => onSubmit()}
		onAbort={onAbort}
		isStreaming={!!isRunning}
		streamingStatusText={streamingStatusText}
		isDisabled={isDisabled}
		onClickAnywhere={() => { textAreaRef.current?.focus() }}
	>
		<TroveInputBox2
			enableAtToMention
			inlineSelections={selections}
			setInlineSelections={setSelections}
			className={`min-h-[44px] px-0 py-0 text-[13px] leading-[1.45]`}
			placeholder="Ask Trove anything…"
			onChangeText={onChangeText}
			onKeyDown={onKeyDown}
			onFocus={() => { chatThreadsService.setCurrentlyFocusedMessageIdx(undefined) }}
			ref={textAreaRef}
			fnsRef={textAreaFnsRef}
			multiline={true}
		/>

	</TroveChatArea>


	const isLandingPage = previousMessages.length === 0


	const initiallySuggestedPromptsHTML = <div className='flex flex-col gap-2 w-full text-nowrap text-trove-fg-3 select-none'>
		{[
			'Summarize my codebase',
			'How do types work in Rust?',
			'Create a .troverules file for me'
		].map((text, index) => (
			<div
				key={index}
				className='py-1 px-2 rounded text-sm bg-zinc-700/5 hover:bg-zinc-700/10 dark:bg-zinc-300/5 dark:hover:bg-zinc-300/10 cursor-pointer opacity-80 hover:opacity-100'
				onClick={() => onSubmit(text)}
			>
				{text}
			</div>
		))}
	</div>



	const threadPageInput = <div key={'input' + chatThreadsState.currentThreadId} className="shrink-0">
		{inputChatArea}
	</div>

	const landingPageInput = <div>
		<div className='pt-8'>
			{inputChatArea}
		</div>
	</div>

	const landingPageContent = <div
		ref={sidebarRef}
		className='w-full h-full max-h-full flex flex-col overflow-auto px-4'
	>
		<ErrorBoundary>
			{landingPageInput}
		</ErrorBoundary>

		{Object.keys(chatThreadsState.allThreads).length > 1 ? // show if there are threads
			<ErrorBoundary>
				<div className='pt-8 mb-2 text-trove-fg-3 text-root select-none pointer-events-none'>Previous Threads</div>
				<PastThreadsList />
			</ErrorBoundary>
			:
			<ErrorBoundary>
				<div className='pt-8 mb-2 text-trove-fg-3 text-root select-none pointer-events-none'>Suggestions</div>
				{initiallySuggestedPromptsHTML}
			</ErrorBoundary>
		}
	</div>


	// const threadPageContent = <div>
	// 	{/* Thread content */}
	// 	<div className='flex flex-col overflow-hidden'>
	// 		<div className={`overflow-hidden ${previousMessages.length === 0 ? 'h-0 max-h-0 pb-2' : ''}`}>
	// 			<ErrorBoundary>
	// 				{messagesHTML}
	// 			</ErrorBoundary>
	// 		</div>
	// 		<ErrorBoundary>
	// 			{inputForm}
	// 		</ErrorBoundary>
	// 	</div>
	// </div>
	const threadPageContent = <div
		ref={sidebarRef}
		className='w-full h-full flex flex-col overflow-hidden'
	>

		<ErrorBoundary>
			{messagesHTML}
		</ErrorBoundary>
		<ErrorBoundary>
			{threadPageInput}
		</ErrorBoundary>
	</div>


	return (
		<Fragment key={threadId} // force rerender when change thread
		>
			{isLandingPage ?
				landingPageContent
				: threadPageContent}
		</Fragment>
	)
}
