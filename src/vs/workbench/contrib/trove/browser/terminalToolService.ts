/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { ITerminalCapabilityImplMap, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalService, ITerminalInstance, ICreateTerminalOptions } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_CHARS, MAX_TERMINAL_COMMAND_TIME, getTerminalInactiveTimeoutSeconds, isLongRunningTerminalCommand, isPackageInstallCommand, SERVER_READY_OUTPUT_PATTERN, stripBackgroundShellSuffix, terminalCommandLooksSuccessful } from '../common/prompt/prompts.js';
import { TerminalResolveReason } from '../common/toolsServiceTypes.js';
import { timeout } from '../../../../base/common/async.js';



export interface ITerminalToolService {
	readonly _serviceBrand: undefined;

	listPersistentTerminalIds(): string[];
	runCommand(command: string, opts:
		| { type: 'persistent', persistentTerminalId: string }
		| { type: 'temporary', cwd: string | null, terminalId: string }
		// | { type: 'apply', terminalId: string }
	): Promise<{ interrupt: () => void; resPromise: Promise<{ result: string, resolveReason: TerminalResolveReason }> }>;

	focusPersistentTerminal(terminalId: string): Promise<void>
	persistentTerminalExists(terminalId: string): boolean

	readTerminal(terminalId: string): Promise<string>

	createPersistentTerminal(opts: { cwd: string | null }): Promise<string>
	killPersistentTerminal(terminalId: string): Promise<void>

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined
	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined
	/** Subscribe to polled terminal scrollback while a command is running (keyed by terminalId). */
	registerLiveOutputListener(terminalId: string, listener: (output: string) => void): IDisposable
	/** Tear down the reused chat sandbox shell (call when an agent turn finishes). */
	disposeSandboxSession(): void
}
export const ITerminalToolService = createDecorator<ITerminalToolService>('TerminalToolService');



// function isCommandComplete(output: string) {
// 	// https://code.visualstudio.com/docs/terminal/shell-integration#_vs-code-custom-sequences-osc-633-st
// 	const completionMatch = output.match(/\]633;D(?:;(\d+))?/)
// 	if (!completionMatch) { return false }
// 	if (completionMatch[1] !== undefined) return { exitCode: parseInt(completionMatch[1]) }
// 	return { exitCode: 0 }
// }

const parseShellIntegrationCommandFinished = (data: string): { exitCode: number } | null => {
	const completionMatch = data.match(/\]633;D(?:;(\d+))?/)
	if (!completionMatch) { return null }
	if (completionMatch[1] !== undefined) return { exitCode: parseInt(completionMatch[1]) }
	return { exitCode: 0 }
}


export const persistentTerminalNameOfId = (id: string) => {
	if (id === '1') return 'Trove Agent'
	return `Trove Agent (${id})`
}
export const idOfPersistentTerminalName = (name: string) => {
	if (name === 'Trove Agent') return '1'

	const match = name.match(/Trove Agent \((\d+)\)/)
	if (!match) return null
	if (Number.isInteger(match[1]) && Number(match[1]) >= 1) return match[1]
	return null
}

export class TerminalToolService extends Disposable implements ITerminalToolService {
	readonly _serviceBrand: undefined;

	private persistentTerminalInstanceOfId: Record<string, ITerminalInstance> = {}
	private temporaryTerminalInstanceOfId: Record<string, ITerminalInstance> = {}
	private liveOutputListenerOfTerminalId: Record<string, (output: string) => void> = {}
	private sandboxMountOfTerminalId: Record<string, IDisposable> = {}
	private sandboxSession: { instance: ITerminalInstance; cwd: string | null; mountDispose: IDisposable } | undefined

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		// runs on ALL terminals for simplicity
		const initializeTerminal = (terminal: ITerminalInstance) => {
			// when exit, remove
			const d = terminal.onExit(() => {
				const terminalId = idOfPersistentTerminalName(terminal.title)
				if (terminalId !== null && (terminalId in this.persistentTerminalInstanceOfId)) delete this.persistentTerminalInstanceOfId[terminalId]
				d.dispose()
			})
		}


		// initialize any terminals that are already open
		for (const terminal of terminalService.instances) {
			const proposedTerminalId = idOfPersistentTerminalName(terminal.title)
			if (proposedTerminalId) this.persistentTerminalInstanceOfId[proposedTerminalId] = terminal

			initializeTerminal(terminal)
		}

		this._register(
			terminalService.onDidCreateInstance(terminal => { initializeTerminal(terminal) })
		)

	}


	listPersistentTerminalIds() {
		return Object.keys(this.persistentTerminalInstanceOfId)
	}

	getValidNewTerminalId(): string {
		// {1 2 3} # size 3, new=4
		// {1 3 4} # size 3, new=2
		// 1 <= newTerminalId <= n + 1
		const n = Object.keys(this.persistentTerminalInstanceOfId).length;
		if (n === 0) return '1'

		for (let i = 1; i <= n + 1; i++) {
			const potentialId = i + '';
			if (!(potentialId in this.persistentTerminalInstanceOfId)) return potentialId;
		}
		throw new Error('This should never be reached by pigeonhole principle');
	}


	private async _createTerminal(props: { cwd: string | null, config: ICreateTerminalOptions['config'], hidden?: boolean }) {
		const { cwd: override_cwd, config, hidden } = props;

		const cwd: URI | string | undefined = (override_cwd ?? undefined) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;

		const options: ICreateTerminalOptions = {
			cwd,
			location: hidden ? undefined : TerminalLocation.Panel,
			config: {
				name: config && 'name' in config ? config.name : 'Trove Sandbox',
				forceShellIntegration: true,
				hideFromUser: hidden ? true : undefined,
				// Copy any other properties from the provided config
				...config,
			},
			// Skip profile check to ensure the terminal is created quickly
			skipContributedProfileCheck: true,
		};

		const terminal = await this.terminalService.createTerminal(options)

		// // when a new terminal is created, there is an initial command that gets run which is empty, wait for it to end before returning
		// const disposables: IDisposable[] = []
		// const waitForMount = new Promise<void>(res => {
		// 	let data = ''
		// 	const d = terminal.onData(newData => {
		// 		data += newData
		// 		if (isCommandComplete(data)) { res() }
		// 	})
		// 	disposables.push(d)
		// })
		// const waitForTimeout = new Promise<void>(res => { setTimeout(() => { res() }, 5000) })

		// await Promise.any([waitForMount, waitForTimeout,])
		// disposables.forEach(d => d.dispose())

		return terminal

	}

	createPersistentTerminal: ITerminalToolService['createPersistentTerminal'] = async ({ cwd }) => {
		const terminalId = this.getValidNewTerminalId();
		const config = { name: persistentTerminalNameOfId(terminalId), title: persistentTerminalNameOfId(terminalId) }
		const terminal = await this._createTerminal({ cwd, config, })
		this.persistentTerminalInstanceOfId[terminalId] = terminal
		return terminalId
	}

	async killPersistentTerminal(terminalId: string) {
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) throw new Error(`Kill Terminal: Terminal with ID ${terminalId} did not exist.`);
		terminal.dispose()
		delete this.persistentTerminalInstanceOfId[terminalId]
		return
	}

	persistentTerminalExists(terminalId: string): boolean {
		return terminalId in this.persistentTerminalInstanceOfId
	}


	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.temporaryTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}

	registerLiveOutputListener(terminalId: string, listener: (output: string) => void): IDisposable {
		this.liveOutputListenerOfTerminalId[terminalId] = listener
		return toDisposable(() => {
			if (this.liveOutputListenerOfTerminalId[terminalId] === listener) {
				delete this.liveOutputListenerOfTerminalId[terminalId]
			}
		})
	}

	private _emitLiveOutput(terminalId: string, output: string): void {
		this.liveOutputListenerOfTerminalId[terminalId]?.(output)
	}

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}


	focusPersistentTerminal: ITerminalToolService['focusPersistentTerminal'] = async (terminalId) => {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		this.terminalService.setActiveInstance(terminal)
		await this.terminalService.focusActiveInstance()
	}




	readTerminal: ITerminalToolService['readTerminal'] = async (terminalId) => {
		// Try persistent first, then temporary
		const terminal = this.getPersistentTerminal(terminalId) ?? this.getTemporaryTerminal(terminalId);
		if (!terminal) {
			throw new Error(`Read Terminal: Terminal with ID ${terminalId} does not exist.`);
		}

		// Ensure the xterm.js instance has been created – otherwise we cannot access the buffer.
		if (!terminal.xterm) {
			throw new Error('Read Terminal: The requested terminal has not yet been rendered and therefore has no scrollback buffer available.');
		}

		// Collect lines from the buffer iterator (oldest to newest)
		const lines: string[] = [];
		for (const line of terminal.xterm.getBufferReverseIterator()) {
			lines.unshift(line);
		}

		let result = removeAnsiEscapeCodes(lines.join('\n'));

		if (result.length > MAX_TERMINAL_CHARS) {
			const half = MAX_TERMINAL_CHARS / 2;
			result = result.slice(0, half) + '\n...\n' + result.slice(result.length - half);
		}

		return result
	};

	private async _waitForCommandDetectionCapability(terminal: ITerminalInstance) {
		const cmdCap = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (cmdCap) return cmdCap

		const disposables: IDisposable[] = []

		const waitTimeout = timeout(10_000)
		const waitForCapability = new Promise<ITerminalCapabilityImplMap[TerminalCapability.CommandDetection]>((res) => {
			disposables.push(
				terminal.capabilities.onDidAddCapability((e) => {
					if (e.id === TerminalCapability.CommandDetection) res(e.capability)
				})
			)
		})

		const capability = await Promise.any([waitTimeout, waitForCapability])
			.finally(() => { disposables.forEach((d) => d.dispose()) })

		return capability ?? undefined
	}

	/** Hidden sandbox terminals must be attached with real dimensions before sendText — otherwise xterm never acks PTY data and commands hang with no output. */
	private async _mountHiddenSandboxHost(terminal: ITerminalInstance, terminalId: string): Promise<void> {
		const el = document.createElement('div')
		el.style.cssText = 'position:fixed;visibility:hidden;left:0;top:0;width:800px;height:400px;overflow:hidden;pointer-events:none;'
		document.body.appendChild(el)
		terminal.attachToElement(el)
		terminal.setVisible(true)
		terminal.layout({ width: 800, height: 400 })
		await Promise.race([
			terminal.focusWhenReady().catch(() => { /* xterm open is enough */ }),
			timeout(8_000),
		])
		this.sandboxMountOfTerminalId[terminalId] = toDisposable(() => {
			try { terminal.detachFromElement() } catch { /* ignore */ }
			el.remove()
			delete this.sandboxMountOfTerminalId[terminalId]
		})
	}

	disposeSandboxSession(): void {
		if (this.sandboxSession) {
			try { this.sandboxSession.mountDispose.dispose() } catch { /* ignore */ }
			try { this.sandboxSession.instance.dispose() } catch { /* ignore */ }
			const inst = this.sandboxSession.instance
			for (const id of Object.keys(this.temporaryTerminalInstanceOfId)) {
				if (this.temporaryTerminalInstanceOfId[id] === inst) {
					delete this.temporaryTerminalInstanceOfId[id]
				}
			}
			this.sandboxSession = undefined
		}
	}

	private _resolveSandboxCwd(cwd: string | null): string | null {
		return cwd ?? this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? null
	}

	private _bestOutputSnapshot(accumulator: string, scrollback: string | undefined, command: string): string {
		const acc = removeAnsiEscapeCodes(accumulator).trim()
		const plain = removeAnsiEscapeCodes(scrollback ?? '').trim()
		if (acc.length >= plain.length && acc.length > 0) return acc
		const cmd = command.trim()
		const idx = plain.lastIndexOf(cmd)
		if (idx >= 0) {
			const after = plain.slice(idx + cmd.length).replace(/^[\s\r\n$#%>]+/, '').trim()
			if (after.length > acc.length) return after
		}
		return acc || plain
	}

	private async _captureFinalOutput(
		terminal: ITerminalInstance,
		terminalId: string,
		accumulator: string,
		command: string,
	): Promise<string> {
		let scrollback: string | undefined
		try { scrollback = await this.readTerminal(terminalId) } catch { /* use accumulator */ }
		return this._bestOutputSnapshot(accumulator, scrollback, command)
	}

	private async _getOrCreateSandboxTerminal(cwd: string | null, terminalId: string): Promise<ITerminalInstance> {
		const resolvedCwd = this._resolveSandboxCwd(cwd)
		if (this.sandboxSession && !this.sandboxSession.instance.isDisposed && this.sandboxSession.cwd === resolvedCwd) {
			this.temporaryTerminalInstanceOfId[terminalId] = this.sandboxSession.instance
			return this.sandboxSession.instance
		}
		this.disposeSandboxSession()
		const terminal = await this._createTerminal({ cwd, config: { name: 'Trove Sandbox' }, hidden: true })
		await terminal.processReady
		await this._mountHiddenSandboxHost(terminal, terminalId)
		const mountDispose = this.sandboxMountOfTerminalId[terminalId]
		this.sandboxSession = { instance: terminal, cwd: resolvedCwd, mountDispose }
		this.temporaryTerminalInstanceOfId[terminalId] = terminal
		return terminal
	}

	runCommand: ITerminalToolService['runCommand'] = async (command, params) => {
		await this.terminalService.whenConnected;

		const { type } = params
		const isPersistent = type === 'persistent'

		let terminal: ITerminalInstance
		const disposables: IDisposable[] = []

		if (isPersistent) { // BG process
			const { persistentTerminalId } = params
			terminal = this.persistentTerminalInstanceOfId[persistentTerminalId];
			if (!terminal) throw new Error(`Unexpected internal error: Terminal with ID ${persistentTerminalId} did not exist.`);
		}
		else {
			const { cwd } = params
			terminal = await this._getOrCreateSandboxTerminal(cwd, params.terminalId)
		}

		const interrupt = () => {
			if (!isPersistent) {
				this.disposeSandboxSession()
			} else {
				terminal.dispose()
				delete this.persistentTerminalInstanceOfId[params.persistentTerminalId]
			}
		}

		const waitForResult = async () => {
			if (!isPersistent) {
				// sandbox already mounted in _getOrCreateSandboxTerminal
			}

			let result: string = ''
			let resolveReason: TerminalResolveReason | undefined
			const inactiveTimeoutSeconds = getTerminalInactiveTimeoutSeconds(command)

			const cmdCap = await this._waitForCommandDetectionCapability(terminal)
			// if (!cmdCap) throw new Error(`There was an error using the terminal: CommandDetection capability did not mount yet. Please try again in a few seconds or report this to the Trove team.`)

			let resolveDone: (() => void) | null = null
			const waitUntilDone = new Promise<void>(resolve => { resolveDone = resolve })

			const commandToRun = isPersistent ? stripBackgroundShellSuffix(command) : command
			const terminalIdForPoll = isPersistent ? params.persistentTerminalId : params.terminalId

			// Accumulate raw output for live UI before xterm scrollback is available
			let liveOutputAccumulator = ''

			const markServerReady = (output?: string) => {
				if (resolveReason) return
				resolveReason = { type: 'server_ready' }
				if (output !== undefined) result = output
			}

			const markDone = (exitCode: number, output?: string): boolean => {
				if (resolveReason) return true
				const snapshot = output?.trim()
					? removeAnsiEscapeCodes(output).trim()
					: this._bestOutputSnapshot(liveOutputAccumulator, undefined, commandToRun)
				if (!terminalCommandLooksSuccessful(commandToRun, snapshot, exitCode)) {
					return false
				}
				resolveReason = { type: 'done', exitCode }
				result = snapshot
				resolveDone?.()
				resolveDone = null
				return true
			}

			const tryCompleteFromSnapshot = async (exitCode: number): Promise<boolean> => {
				if (resolveReason) return true
				const snapshot = await this._captureFinalOutput(terminal, terminalIdForPoll, liveOutputAccumulator, commandToRun)
				return markDone(exitCode, snapshot)
			}

			const dataForLiveListener = terminal.onWillData(data => {
				liveOutputAccumulator += data
				const cleaned = removeAnsiEscapeCodes(liveOutputAccumulator)
				const preview = cleaned.length > MAX_TERMINAL_CHARS
					? cleaned.slice(0, MAX_TERMINAL_CHARS / 2) + '\n...\n' + cleaned.slice(cleaned.length - MAX_TERMINAL_CHARS / 2)
					: cleaned
				if (preview.trim()) {
					this._emitLiveOutput(terminalIdForPoll, preview)
				}
			})
			disposables.push(dataForLiveListener)

			// Stream scrollback to chat UI while the command runs (supplements onData once buffer exists)
			const pollLiveOutput = setInterval(() => {
				if (resolveReason) return
				void this.readTerminal(terminalIdForPoll)
					.then(snapshot => {
						if (snapshot.trim()) {
							this._emitLiveOutput(terminalIdForPoll, snapshot)
						}
					})
					.catch(() => { /* terminal buffer not ready yet — onData accumulator covers this */ })
			}, 400)
			disposables.push(toDisposable(() => clearInterval(pollLiveOutput)))

			// OSC 633 completion fallback — debounced for long commands to avoid false positives
			let oscDataBuffer = ''
			let oscSettleTimer: ReturnType<typeof setTimeout> | undefined
			const tryOscDone = (exitCode: number) => {
				if (resolveReason) return
				const finalize = () => { void tryCompleteFromSnapshot(exitCode) }
				if (isLongRunningTerminalCommand(commandToRun) || isPackageInstallCommand(commandToRun)) {
					if (oscSettleTimer) clearTimeout(oscSettleTimer)
					oscSettleTimer = setTimeout(finalize, 1500)
				} else {
					finalize()
				}
			}
			const oscListener = terminal.onWillData(data => {
				oscDataBuffer += data
				const finished = parseShellIntegrationCommandFinished(oscDataBuffer)
				if (!finished || resolveReason) return
				tryOscDone(finished.exitCode)
			})
			disposables.push(oscListener, toDisposable(() => { if (oscSettleTimer) clearTimeout(oscSettleTimer) }))

			if (cmdCap) {
				const l = cmdCap.onCommandFinished(cmd => {
					void (async () => {
						const cmdOut = cmd.getOutput() ?? ''
						const snapshot = await this._captureFinalOutput(terminal, terminalIdForPoll, cmdOut || liveOutputAccumulator, commandToRun)
						const ok = markDone(cmd.exitCode ?? 0, snapshot)
						if (ok) { l.dispose() }
					})()
				})
				disposables.push(l)
			}

			// Poll scrollback — catches fast npm install when cmdCap/OSC fire too early with empty output
			const pollForCompletion = setInterval(() => {
				if (resolveReason) return
				void tryCompleteFromSnapshot(0)
			}, 1500)
			disposables.push(toDisposable(() => clearInterval(pollForCompletion)))

			// send the command now that listeners are attached
			this._emitLiveOutput(terminalIdForPoll, `$ ${commandToRun}\n`)
			await terminal.sendText(commandToRun, true)

			const waitUntilServerReady = isPersistent ? new Promise<void>(resolve => {
				let dataBuffer = ''
				const l = terminal.onData(data => {
					dataBuffer += data
					if (SERVER_READY_OUTPUT_PATTERN.test(dataBuffer)) {
						void (async () => {
							const terminalId = params.persistentTerminalId
							const snapshot = await this.readTerminal(terminalId)
							markServerReady(snapshot)
							l.dispose()
							resolve()
						})()
					}
				})
				disposables.push(l)
			}) : null

			const waitUntilInterrupt = isPersistent ?
				// return a snapshot after bootstrap window; process keeps running
				new Promise<void>((res) => {
					setTimeout(() => {
						if (resolveReason) return
						resolveReason = { type: 'timeout', inactiveTimeoutSeconds: MAX_TERMINAL_BG_COMMAND_TIME, reason: 'snapshot' };
						res()
					}, MAX_TERMINAL_BG_COMMAND_TIME * 1000)
				})
				// inactivity-based timeout (resets on every chunk of terminal output)
				: new Promise<void>(res => {
					let globalTimeoutId: ReturnType<typeof setTimeout>;
					const resetTimer = () => {
						clearTimeout(globalTimeoutId);
						globalTimeoutId = setTimeout(() => {
							if (resolveReason) return
							void tryCompleteFromSnapshot(0).then(succeeded => {
								if (succeeded || resolveReason) {
									res()
									return
								}
								resolveReason = { type: 'timeout', inactiveTimeoutSeconds, reason: 'inactivity' };
								res();
							})
						}, inactiveTimeoutSeconds * 1000);
					};

					const dTimeout = terminal.onWillData(() => { resetTimer(); });
					disposables.push(dTimeout, toDisposable(() => clearTimeout(globalTimeoutId)));
					resetTimer();
				})

			// hard cap so commands cannot run forever
			const waitUntilAbsoluteMax = !isPersistent ? new Promise<void>(res => {
				setTimeout(() => {
					if (resolveReason) return
					resolveReason = { type: 'timeout', inactiveTimeoutSeconds: MAX_TERMINAL_COMMAND_TIME, reason: 'absolute' };
					res()
				}, MAX_TERMINAL_COMMAND_TIME * 1000)
			}) : null

			// wait for result
			await Promise.any([
				waitUntilDone,
				waitUntilInterrupt,
				...(waitUntilServerReady ? [waitUntilServerReady] : []),
				...(waitUntilAbsoluteMax ? [waitUntilAbsoluteMax] : []),
			])
				.finally(() => disposables.forEach(d => d.dispose()))



			// read result if timed out or server snapshot, since we didn't get full output via cmdCap
			if (resolveReason?.type === 'timeout' || resolveReason?.type === 'server_ready') {
				const terminalId = isPersistent ? params.persistentTerminalId : params.terminalId
				result = await this._captureFinalOutput(terminal, terminalId, liveOutputAccumulator, commandToRun)
			} else if (resolveReason?.type === 'done') {
				result = await this._captureFinalOutput(terminal, terminalIdForPoll, liveOutputAccumulator, commandToRun)
			}

			// Keep sandbox session alive between run_command calls — do not dispose here

			if (!resolveReason) throw new Error('Unexpected internal error: Promise.any should have resolved with a reason.')

			if (!isPersistent) result = `$ ${command}\n${result}`
			// Preserve ANSI for chat UI coloring; LLM stringOfResult strips codes separately
			// trim
			if (result.length > MAX_TERMINAL_CHARS) {
				const half = MAX_TERMINAL_CHARS / 2
				result = result.slice(0, half)
					+ '\n...\n'
					+ result.slice(result.length - half, Infinity)
			}

			return { result, resolveReason }

		}
		const resPromise = waitForResult()

		return {
			interrupt,
			resPromise,
		}
	}


}

registerSingleton(ITerminalToolService, TerminalToolService, InstantiationType.Delayed);
