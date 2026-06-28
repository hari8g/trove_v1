/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { defaultGlobalSettings } from '../../common/troveSettingsTypes.js';
import { RIAF_USER_DISPLAY_MESSAGE } from '../../common/riaf/riafTypes.js';
import {
	buildRiafSettingsPatches,
	buildRiafSettingsRestorePatches,
	RIAF_MAX_AGENT_ITERATIONS,
	RIAF_MAX_READONLY_CALLS,
	RiafAgentRunController,
	snapshotRiafSettings,
} from '../riafAgentRunController.js';

type FinishEvent = { threadId: string; pendingDiffCount: number; filesChanged: string[] };

function createTestHarness(ds: Pick<DisposableStore, 'add'>, opts?: { workspaceRoot?: string | null; fileExists?: boolean }) {
	const finishEmitter = ds.add(new Emitter<FinishEvent>());
	const threadState = { currentThreadId: 'thread-initial' };
	let openThreadForAgentRunCalls = 0;
	let openNewThreadCalls = 0;
	let streamResolve: (() => void) | null = null;
	let abortCalls = 0;

	let globalSettings = {
		...defaultGlobalSettings,
		chatMode: 'normal' as const,
		autoApprove: { edits: false as boolean | undefined },
		maxReadOnlyCalls: 12,
		maxAgentIterations: 25,
	};
	const setCalls: Array<{ name: string; value: unknown }> = [];

	let lastUserMessageOpts: { userMessage: string; displayMessage?: string; threadId: string; _internalPrompt?: boolean } | null = null;

	const chatThread = {
		state: threadState,
		onDidFinishAgentRun: finishEmitter.event,
		openNewThread: () => {
			openNewThreadCalls += 1;
			threadState.currentThreadId = `thread-${openNewThreadCalls}`;
		},
		openThreadForAgentRun: () => {
			openThreadForAgentRunCalls += 1;
			threadState.currentThreadId = `thread-${openThreadForAgentRunCalls}`;
			return threadState.currentThreadId;
		},
		addUserMessageAndStreamResponse: async (opts: { userMessage: string; displayMessage?: string; threadId: string; _internalPrompt?: boolean }) => {
			lastUserMessageOpts = opts;
			await new Promise<void>(resolve => {
				streamResolve = resolve;
			});
		},
		abortRunning: async () => {
			abortCalls += 1;
		},
	};

	const settings = {
		get state() {
			return { globalSettings };
		},
		setGlobalSetting: async (name: string, value: unknown) => {
			setCalls.push({ name, value });
			globalSettings = { ...globalSettings, [name]: value } as typeof globalSettings;
		},
	};

	const workspaceRoot = opts?.workspaceRoot === null ? null : (opts?.workspaceRoot ?? '/workspace');
	const workspaceUri = workspaceRoot ? URI.file(workspaceRoot) : undefined;
	const workspace = {
		getWorkspace: () => ({
			folders: workspaceUri
				? [{ uri: workspaceUri, name: workspaceRoot!.split('/').pop() ?? 'workspace' }]
				: [],
		}),
	};

	let fileExists = opts?.fileExists ?? false;
	const files = {
		exists: async () => fileExists,
		setExists: (value: boolean) => {
			fileExists = value;
		},
	};

	const service = ds.add(new RiafAgentRunController(chatThread, settings, workspace, files));

	return {
		service,
		finishEmitter,
		threadState,
		setCalls,
		files,
		get openNewThreadCalls() { return openNewThreadCalls; },
		get openThreadForAgentRunCalls() { return openThreadForAgentRunCalls; },
		get abortCalls() { return abortCalls; },
		get lastUserMessageOpts() { return lastUserMessageOpts; },
		resolveStream: () => {
			streamResolve?.();
			streamResolve = null;
		},
		get globalSettings() { return globalSettings; },
	};
}

const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function withHarness<T>(
	opts: { workspaceRoot?: string | null; fileExists?: boolean } | undefined,
	fn: (harness: ReturnType<typeof createTestHarness>) => Promise<T>,
): Promise<T> {
	const ds = new DisposableStore();
	try {
		return await fn(createTestHarness(ds, opts));
	} finally {
		ds.dispose();
	}
}

suite('Trove - riafRunSettings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('snapshotRiafSettings captures current global settings', () => {
		const snap = snapshotRiafSettings({
			...defaultGlobalSettings,
			chatMode: 'gather',
			autoApprove: { edits: false },
			maxReadOnlyCalls: 9,
			maxAgentIterations: 11,
		});
		assert.strictEqual(snap.chatMode, 'gather');
		assert.strictEqual(snap.autoApproveEdits, false);
		assert.strictEqual(snap.maxReadOnlyCalls, 9);
		assert.strictEqual(snap.maxAgentIterations, 11);
	});

	test('buildRiafSettingsPatches applies agent overrides', () => {
		const { snapshot, overrides } = buildRiafSettingsPatches({
			...defaultGlobalSettings,
			chatMode: 'normal',
			autoApprove: { edits: false },
		});
		assert.strictEqual(snapshot.chatMode, 'normal');
		assert.deepStrictEqual(overrides, [
			{ name: 'chatMode', value: 'agent' },
			{ name: 'autoApprove', value: { edits: true } },
			{ name: 'maxReadOnlyCalls', value: RIAF_MAX_READONLY_CALLS },
			{ name: 'maxAgentIterations', value: RIAF_MAX_AGENT_ITERATIONS },
		]);
	});

	test('buildRiafSettingsRestorePatches restores snapshot values', () => {
		const snapshot = snapshotRiafSettings({
			...defaultGlobalSettings,
			chatMode: 'gather',
			autoApprove: { edits: false, terminal: true },
			maxReadOnlyCalls: 9,
			maxAgentIterations: 11,
		});
		const patches = buildRiafSettingsRestorePatches({
			...defaultGlobalSettings,
			autoApprove: { edits: true, terminal: true },
		}, snapshot);
		assert.deepStrictEqual(patches, [
			{ name: 'chatMode', value: 'gather' },
			{ name: 'autoApprove', value: { edits: false, terminal: true } },
			{ name: 'maxReadOnlyCalls', value: 9 },
			{ name: 'maxAgentIterations', value: 11 },
		]);
	});
});

suite('Trove - riafAgentRunController', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('startRun errors when no workspace folder is open', async () => {
		await withHarness({ workspaceRoot: null }, async ({ service }) => {
			await service.startRun();
			assert.strictEqual(service.state.status, 'error');
			if (service.state.status === 'error') {
				assert.ok(service.state.message.includes('No workspace folder open'));
			}
		});
	});

	test('startRun is a no-op while already running', async () => {
		await withHarness(undefined, async (harness) => {
			const first = harness.service.startRun();
			await flushAsync();
			assert.strictEqual(harness.service.state.status, 'running');
			const callsBefore = harness.openThreadForAgentRunCalls;
			await harness.service.startRun();
			assert.strictEqual(harness.openThreadForAgentRunCalls, callsBefore);
			harness.resolveStream();
			await first;
		});
	});

	test('startRun sends short display message with full prompt to agent', async () => {
		await withHarness(undefined, async (harness) => {
			const run = harness.service.startRun();
			await flushAsync();

			assert.ok(harness.lastUserMessageOpts);
			assert.strictEqual(harness.lastUserMessageOpts!.displayMessage, RIAF_USER_DISPLAY_MESSAGE);
			assert.strictEqual(harness.lastUserMessageOpts!._internalPrompt, true);
			assert.ok(harness.lastUserMessageOpts!.userMessage.includes('repository analysis'));
			assert.notStrictEqual(harness.lastUserMessageOpts!.userMessage, RIAF_USER_DISPLAY_MESSAGE);

			harness.resolveStream();
			await run;
		});
	});

	test('startRun applies and restores RIAF settings overrides', async () => {
		await withHarness(undefined, async (harness) => {
			const run = harness.service.startRun();
			await flushAsync();

			assert.ok(harness.setCalls.some(c => c.name === 'chatMode' && c.value === 'agent'));
			assert.ok(harness.setCalls.some(c => c.name === 'maxReadOnlyCalls' && c.value === RIAF_MAX_READONLY_CALLS));
			assert.ok(harness.setCalls.some(c => c.name === 'maxAgentIterations' && c.value === RIAF_MAX_AGENT_ITERATIONS));
			assert.ok(harness.setCalls.some(c => c.name === 'autoApprove' && (c.value as { edits?: boolean }).edits === true));

			harness.files.setExists(true);
			harness.finishEmitter.fire({
				threadId: harness.threadState.currentThreadId,
				pendingDiffCount: 0,
				filesChanged: [],
			});
			await flushAsync();
			harness.resolveStream();
			await run;

			assert.strictEqual(harness.globalSettings.chatMode, 'normal');
			assert.strictEqual(harness.globalSettings.maxReadOnlyCalls, 12);
			assert.strictEqual(harness.globalSettings.maxAgentIterations, 25);
			assert.strictEqual(harness.globalSettings.autoApprove.edits, false);
		});
	});

	test('onDidFinishAgentRun marks done when output file exists', async () => {
		await withHarness({ fileExists: true }, async (harness) => {
			const run = harness.service.startRun();
			await flushAsync();
			const threadId = harness.threadState.currentThreadId;

			harness.finishEmitter.fire({ threadId, pendingDiffCount: 0, filesChanged: [] });
			await flushAsync();
			harness.resolveStream();
			await run;

			assert.strictEqual(harness.service.state.status, 'done');
			if (harness.service.state.status === 'done') {
				assert.ok(harness.service.state.outputPath.endsWith('workspace_context.md'));
			}
		});
	});

	test('onDidFinishAgentRun marks error when output file is missing', async () => {
		await withHarness({ fileExists: false }, async (harness) => {
			const run = harness.service.startRun();
			await flushAsync();
			const threadId = harness.threadState.currentThreadId;

			harness.finishEmitter.fire({ threadId, pendingDiffCount: 0, filesChanged: [] });
			await flushAsync();
			harness.resolveStream();
			await run;

			assert.strictEqual(harness.service.state.status, 'error');
			if (harness.service.state.status === 'error') {
				assert.ok(harness.service.state.message.includes('workspace_context.md was not written'));
			}
		});
	});

	test('abort restores settings and returns to idle', async () => {
		await withHarness(undefined, async (harness) => {
			const run = harness.service.startRun();
			await flushAsync();

			await harness.service.abort();
			harness.resolveStream();
			await run;

			assert.strictEqual(harness.service.state.status, 'idle');
			assert.strictEqual(harness.abortCalls, 1);
			assert.strictEqual(harness.globalSettings.chatMode, 'normal');
			assert.strictEqual(harness.globalSettings.maxReadOnlyCalls, 12);
		});
	});

	test('abort ignores onDidFinishAgentRun completion handler', async () => {
		await withHarness({ fileExists: true }, async (harness) => {
			const run = harness.service.startRun();
			await flushAsync();
			const threadId = harness.threadState.currentThreadId;

			await harness.service.abort();
			harness.finishEmitter.fire({ threadId, pendingDiffCount: 0, filesChanged: [] });
			await flushAsync();
			harness.resolveStream();
			await run;

			assert.strictEqual(harness.service.state.status, 'idle');
		});
	});
});
