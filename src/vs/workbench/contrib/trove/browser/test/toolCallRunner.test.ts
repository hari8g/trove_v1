/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createReadOnlyCallCounts, trackReadOnlyCall } from '../agentReadHints.js';
import { createRunToolCall, ToolCallRunnerDeps } from '../toolCallRunner.js';
import { defaultGlobalSettings } from '../../common/troveSettingsTypes.js';
import type { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import type { ThreadStreamState } from '../chatThreadService.js';

suite('Trove - toolCallRunner', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	type ToolUpdate = ChatMessage & { role: 'tool' };

	const createHarness = (overrides?: Partial<{
		callTool: ToolCallRunnerDeps['toolsService']['callTool'];
		stringOfResult: ToolCallRunnerDeps['toolsService']['stringOfResult'];
		mcpService: ToolCallRunnerDeps['mcpService'];
	}>) => {
		const toolUpdates: ToolUpdate[] = [];
		let streamState: ThreadStreamState[string] | undefined;

		const deps: ToolCallRunnerDeps = {
			toolsService: {
				_serviceBrand: undefined,
				validateParams: new Proxy({} as ToolCallRunnerDeps['toolsService']['validateParams'], {
					get: () => (p: unknown) => p,
				}),
				callTool: overrides?.callTool ?? (new Proxy({} as ToolCallRunnerDeps['toolsService']['callTool'], {
					get: () => async () => ({ result: {} }),
				})),
				stringOfResult: overrides?.stringOfResult ?? (new Proxy({} as ToolCallRunnerDeps['toolsService']['stringOfResult'], {
					get: () => () => 'ok',
				})),
			},
			mcpService: overrides?.mcpService ?? ({
				_serviceBrand: undefined,
				getMCPTools: () => [],
				callMCPTool: async () => ({ result: { content: [] } }),
				stringifyResult: () => '',
			} as unknown as ToolCallRunnerDeps['mcpService']),
			settingsService: {
				state: {
					globalSettings: {
						...defaultGlobalSettings,
						autoApproveAll: true,
						autoApprove: {
							...defaultGlobalSettings.autoApprove,
							edits: true,
							terminal: true,
							'MCP tools': true,
						},
					},
				},
			} as unknown as ToolCallRunnerDeps['settingsService'],
			terminalToolService: {
				registerLiveOutputListener: () => ({ dispose: () => { } }),
			} as unknown as ToolCallRunnerDeps['terminalToolService'],
			agentDeliveryService: {
				handleLiveTerminalOutput: () => { },
				handleTerminalToolResult: async () => { },
			} as unknown as ToolCallRunnerDeps['agentDeliveryService'],
			directoryStringService: {
				invalidateCache: () => { },
			} as unknown as ToolCallRunnerDeps['directoryStringService'],
			workspacePreviewService: {
				getActivePreviewUrl: () => null,
				scheduleReloadAfterWebChange: () => { },
			} as unknown as ToolCallRunnerDeps['workspacePreviewService'],
			errWhenStringifying: (error) => `stringify error: ${error instanceof Error ? error.message : String(error)}`,
			addMessageToThread: () => { },
			updateLatestTool: (_threadId, tool) => { toolUpdates.push(tool); },
			setStreamState: (_threadId, state) => { streamState = state; },
			getStreamState: () => streamState,
			addToolEditCheckpoint: () => { },
			markPlanItemDone: () => { },
		};

		return {
			runToolCall: createRunToolCall(deps),
			toolUpdates,
			getStreamState: () => streamState,
		};
	};

	test('dedup-skipped read returns skip content and empty stub result', async () => {
		const { runToolCall, toolUpdates } = createHarness({
			callTool: {
				read_file: async () => {
					throw new Error('should not call read_file when skipped');
				},
			} as unknown as ToolCallRunnerDeps['toolsService']['callTool'],
		});

		const uri = URI.file('/proj/a.ts');
		const readOnlyCallCounts = createReadOnlyCallCounts();
		trackReadOnlyCall(readOnlyCallCounts, 'read_file', { uri: uri.fsPath });

		const result = await runToolCall('t1', 'read_file', 'id1', undefined, {
			preapproved: true,
			unvalidatedToolParams: { uri: uri.fsPath },
			validatedParams: { uri, startLine: null, endLine: null, pageNumber: 1 },
			readOnlyCallCounts,
		});

		assert.strictEqual(result.interrupted, undefined);
		const success = toolUpdates.find(u => u.type === 'success');
		assert.ok(success);
		assert.ok(typeof success!.content === 'string' && success!.content.includes('[read_file skipped'));
		const readResult = success!.result as { totalFileLen: number; emptyReason?: string };
		assert.strictEqual(readResult.totalFileLen, 0);
		assert.strictEqual(readResult.emptyReason, undefined);
	});

	test('write invalidates read record so subsequent read is not skipped', async () => {
		const reads: string[] = [];
		const { runToolCall } = createHarness({
			callTool: {
				read_file: async () => {
					reads.push('read');
					return {
						result: { fileContents: 'x', totalFileLen: 1, totalNumLines: 1, hasNextPage: false, totalPages: 1 },
					};
				},
				edit_file: async () => ({
					result: Promise.resolve({
						lintErrors: null,
						edit: { applied: true, savedToDisk: true, blocksMatched: 1, blocksTotal: 1 },
						lintSettled: true,
					}),
				}),
			} as unknown as ToolCallRunnerDeps['toolsService']['callTool'],
			stringOfResult: {
				read_file: () => 'file contents',
				edit_file: () => 'edited',
			} as unknown as ToolCallRunnerDeps['toolsService']['stringOfResult'],
		});

		const uri = URI.file('/proj/a.ts');
		const readOnlyCallCounts = createReadOnlyCallCounts();

		await runToolCall('t1', 'read_file', 'r1', undefined, {
			preapproved: true,
			unvalidatedToolParams: {},
			validatedParams: { uri, startLine: null, endLine: null, pageNumber: 1 },
			readOnlyCallCounts,
		});
		assert.strictEqual(reads.length, 1);

		await runToolCall('t1', 'edit_file', 'e1', undefined, {
			preapproved: true,
			unvalidatedToolParams: {},
			validatedParams: { uri, searchReplaceBlocks: 'x' },
			readOnlyCallCounts,
			fileEditCounts: new Map(),
		});

		await runToolCall('t1', 'read_file', 'r2', undefined, {
			preapproved: true,
			unvalidatedToolParams: {},
			validatedParams: { uri, startLine: null, endLine: null, pageNumber: 1 },
			readOnlyCallCounts,
		});
		assert.strictEqual(reads.length, 2);
	});

	test('stringifier throws becomes tool_error without breaking', async () => {
		const { runToolCall, toolUpdates } = createHarness({
			callTool: {
				ls_dir: async () => ({ result: { children: [], hasNextPage: false, hasPrevPage: false, itemsRemaining: 0 } }),
			} as unknown as ToolCallRunnerDeps['toolsService']['callTool'],
			stringOfResult: {
				ls_dir: () => { throw new Error('boom-stringify'); },
			} as unknown as ToolCallRunnerDeps['toolsService']['stringOfResult'],
		});

		const result = await runToolCall('t1', 'ls_dir', 'id1', undefined, {
			preapproved: true,
			unvalidatedToolParams: {},
			validatedParams: { uri: URI.file('/proj'), pageNumber: 1 },
		});
		assert.strictEqual(result.status, 'error');
		const err = toolUpdates.find(u => u.type === 'tool_error');
		assert.ok(err?.content.includes('boom-stringify'));
	});

	test('empty stringifier output gets backstop text', async () => {
		const { runToolCall, toolUpdates } = createHarness({
			callTool: {
				ls_dir: async () => ({ result: { children: [], hasNextPage: false, hasPrevPage: false, itemsRemaining: 0 } }),
			} as unknown as ToolCallRunnerDeps['toolsService']['callTool'],
			stringOfResult: {
				ls_dir: () => '   ',
			} as unknown as ToolCallRunnerDeps['toolsService']['stringOfResult'],
		});

		await runToolCall('t1', 'ls_dir', 'id1', undefined, {
			preapproved: true,
			unvalidatedToolParams: {},
			validatedParams: { uri: URI.file('/proj'), pageNumber: 1 },
		});
		const success = toolUpdates.find(u => u.type === 'success');
		assert.ok(success?.content.includes('returned no output'));
	});

	test('edit_file not applied surfaces EDIT NOT APPLIED in content', async () => {
		const { runToolCall, toolUpdates } = createHarness({
			callTool: {
				edit_file: async () => ({
					result: Promise.resolve({
						lintErrors: null,
						edit: { applied: false, savedToDisk: false, failureReason: 'block-not-found', blocksMatched: 0, blocksTotal: 1 },
						lintSettled: true,
					}),
				}),
			} as unknown as ToolCallRunnerDeps['toolsService']['callTool'],
			stringOfResult: {
				edit_file: (_p: unknown, result: { edit: { applied: boolean; failureReason?: string } }) =>
					result.edit.applied ? 'ok' : `EDIT NOT APPLIED. Reason: ${result.edit.failureReason}.`,
			} as unknown as ToolCallRunnerDeps['toolsService']['stringOfResult'],
		});

		await runToolCall('t1', 'edit_file', 'id1', undefined, {
			preapproved: true,
			unvalidatedToolParams: {},
			validatedParams: { uri: URI.file('/proj/a.ts'), searchReplaceBlocks: 'x' },
			fileEditCounts: new Map(),
		});
		const success = toolUpdates.find(u => u.type === 'success');
		assert.ok(success?.content.includes('EDIT NOT APPLIED'));
	});

	test('MCP tool empty result gets backstop text', async () => {
		const { runToolCall, toolUpdates } = createHarness({
			mcpService: {
				getMCPTools: () => [{ name: 'my_mcp', mcpServerName: 'srv' }],
				callMCPTool: async () => ({ result: { content: [{ type: 'text', text: '' }] } }),
				stringifyResult: () => '',
			} as unknown as ToolCallRunnerDeps['mcpService'],
		});

		await runToolCall('t1', 'my_mcp', 'id1', 'srv', {
			preapproved: true,
			unvalidatedToolParams: {},
			validatedParams: {},
		});
		const success = toolUpdates.find(u => u.type === 'success');
		assert.ok(success?.content.includes('returned no output'));
	});

	test('interrupt mid-tool returns interrupted without success', async () => {
		let resolveResult!: (v: { result: string; resolveReason: { type: 'done'; exitCode: number } }) => void;
		const resultPromise = new Promise<{ result: string; resolveReason: { type: 'done'; exitCode: number } }>(res => {
			resolveResult = res;
		});

		const { runToolCall, toolUpdates, getStreamState } = createHarness({
			callTool: {
				run_command: async () => ({
					result: resultPromise,
					interruptTool: () => {
						resolveResult({ result: 'aborted', resolveReason: { type: 'done', exitCode: 130 } });
					},
				}),
			} as unknown as ToolCallRunnerDeps['toolsService']['callTool'],
		});

		const runPromise = runToolCall('t1', 'run_command', 'id1', undefined, {
			preapproved: true,
			unvalidatedToolParams: {},
			validatedParams: { command: 'sleep 10', cwd: null, terminalId: 'term-1' },
		});

		for (let i = 0; i < 40; i++) {
			const stream = getStreamState();
			if (stream?.isRunning === 'tool' && stream.interrupt) {
				const interrupt = await stream.interrupt;
				interrupt();
				break;
			}
			await new Promise(r => setTimeout(r, 5));
		}

		const result = await runPromise;
		assert.strictEqual(result.interrupted, true);
		assert.ok(!toolUpdates.some(u => u.type === 'success'));
	});
});
