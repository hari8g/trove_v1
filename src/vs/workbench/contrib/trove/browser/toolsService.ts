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
import { IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_COMMAND_TIME, getTerminalInactiveTimeoutSeconds, isPackageInstallCommand, packageInstallLooksSuccessful } from '../common/prompt/prompts.js'
import { ITroveSettingsService } from '../common/troveSettingsService.js'
import { createBuiltinToolValidators, ValidateBuiltinParams } from '../common/toolParamValidators.js'
import { createBuiltinToolResultStringifiers, stringifyLintErrors } from '../common/toolResultStringifiers.js'
import { isStaasBuiltinToolName } from '../extensions/staas/staasToolNames.js'
import { createStaasBuiltinToolCallHandlers } from '../extensions/staas/staasToolHandlers.js'
import { createCoreBuiltinToolCallHandlers } from './coreToolHandlers.js'
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js'
import { IWebSearchService } from '../common/webSearchTypes.js'
import { buildVerificationReminder } from '../common/prompt/prompts.js'
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js'


// tool use for AI
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }

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

		this.validateParams = createBuiltinToolValidators();

		const assertOrgExtensionToolAvailable = (toolName: string) => {
			if (isStaasBuiltinToolName(toolName) && !this.troveSettingsService.state.globalSettings.orgExtensions) {
				throw new Error(`Tool "${toolName}" is not available. Enable organization extensions in Trove Settings.`);
			}
		};

		const staasCallTool = createStaasBuiltinToolCallHandlers({
			repoIntelligenceService: this.repoIntelligenceService,
			getWorkspaceRoot: () => workspaceContextService.getWorkspace().folders[0]?.uri.fsPath,
			assertOrgExtensionToolAvailable,
		});

		const coreCallTool = createCoreBuiltinToolCallHandlers({
			fileService,
			workspaceContextService,
			searchService,
			queryBuilder,
			troveModelService,
			editCodeService,
			terminalToolService: this.terminalToolService,
			commandBarService: this.commandBarService,
			directoryStrService: this.directoryStrService,
			troveSettingsService: this.troveSettingsService,
			repoIntelligenceService: this.repoIntelligenceService,
			webSearchService: this.webSearchService,
			getLintErrors: (uri) => this._getLintErrors(uri),
		});

		this.callTool = {
			...coreCallTool,
			...staasCallTool,
		};

		const stringifyLintErrorsTruncated = (lintErrors: LintErrorItem[]) => {
			return stringifyLintErrors(lintErrors).substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = createBuiltinToolResultStringifiers({
			stringifyDirectoryTree: stringifyDirectoryTree1Deep,
			getModelLineContent: (uri, line) => {
				const { model } = troveModelService.getModel(uri)
				if (!model) return null
				return model.getValueInRange({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
			},
			formatEditSuccess: (uri, lintErrors) => {
				const lintErrsString = (
					this.troveSettingsService.state.globalSettings.includeToolLintErrors ?
						(lintErrors ? ` Lint errors found after change:\n${stringifyLintErrorsTruncated(lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')
				return `Change successfully made to ${uri.fsPath}.${lintErrsString}${buildVerificationReminder(this.repoIntelligenceService.getProfileSync())}`
			},
			formatCreateSuccess: (uri, isFolder) => {
				if (isFolder) {
					return `URI ${uri.fsPath} successfully created.`
				}
				return `URI ${uri.fsPath} successfully created.${buildVerificationReminder(this.repoIntelligenceService.getProfileSync())}`
			},
			formatRunCommandResult: (params, result) => {
				const { resolveReason, result: result_, autoPersistentTerminalId } = result
				const plain = removeAnsiEscapeCodes(result_)
				const autoNote = autoPersistentTerminalId
					? `\n[Auto-routed to persistent terminal ${autoPersistentTerminalId} — do NOT use trailing & on run_command. Process keeps running; use run_command curl to verify endpoints.]`
					: ''
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
			formatRunPersistentCommandResult: (params, result) => {
				const { resolveReason, result: result_ } = result
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
		});
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
