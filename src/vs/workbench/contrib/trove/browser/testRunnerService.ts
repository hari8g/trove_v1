/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import type { TerminalResolveReason } from '../common/toolsServiceTypes.js';
import type { ITerminalToolService } from './terminalToolService.js';

export type TestFailure = {
	test: string;
	file?: string;
	line?: number;
	message: string;
};

export type TestRunResult = {
	framework: string;
	passed: number;
	failed: number;
	skipped: number;
	failures: TestFailure[];
	exitCode: number;
	rawTail: string;
	command: string;
};

const RAW_TAIL_LINES = 40;

export const rawTailOf = (output: string, maxLines = RAW_TAIL_LINES): string => {
	const lines = output.replace(/\r\n/g, '\n').split('\n');
	return lines.slice(-maxLines).join('\n').trimEnd();
};

const parseIntSafe = (s: string | undefined): number => {
	const n = Number.parseInt(s ?? '', 10);
	return Number.isFinite(n) ? n : 0;
};

/** Append a file/pattern filter to a test command in a framework-agnostic way. */
export const appendFilePattern = (command: string, filePattern: string | null | undefined): string => {
	const pattern = filePattern?.trim();
	if (!pattern) {
		return command;
	}
	if (/\bnpm\s+(test|run)\b|\byarn\b|\bpnpm\b/.test(command)) {
		return command.includes(' -- ') ? `${command} ${pattern}` : `${command} -- ${pattern}`;
	}
	return `${command} ${pattern}`;
};

type Matcher = (output: string, exitCode: number) => TestRunResult | null;

const jestLikeMatcher = (framework: 'jest' | 'vitest'): Matcher => (output, exitCode) => {
	// Tests:       1 failed, 2 passed, 1 skipped, 4 total
	const summary = output.match(
		/Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(?:(\d+)\s+todo,?\s*)?(?:\d+\s+total)?/i,
	);
	// Vitest: Tests  2 failed | 3 passed | 1 skipped (6)
	const vitestSummary = output.match(
		/Tests\s+(\d+)\s+failed\s*\|?\s*(\d+)\s+passed(?:\s*\|?\s*(\d+)\s+skipped)?/i,
	);
	const m = summary ?? (framework === 'vitest' ? vitestSummary : null);
	const hasJestMarkers = /\bTest Suites:/.test(output) || /FAIL\s+\S+\.(?:test|spec)\./.test(output);
	const hasVitestMarkers = /\bTest Files\b/.test(output) || /[✓×✗]\s+\S+\.(?:test|spec)\./.test(output);

	if (framework === 'jest') {
		if (!m && !hasJestMarkers) {
			return null;
		}
	} else {
		if (!m && !hasVitestMarkers) {
			return null;
		}
		// Avoid treating Maven "Tests run:" as Vitest
		if (!m && /Tests run:/i.test(output)) {
			return null;
		}
	}

	const failed = parseIntSafe(m?.[1]);
	const passed = parseIntSafe(m?.[2]);
	const skipped = parseIntSafe(m?.[3]);

	const failures: TestFailure[] = [];
	const failBlockRe = /(?:✕|×|✗)\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/gm;
	let failMatch: RegExpExecArray | null;
	while ((failMatch = failBlockRe.exec(output)) !== null && failures.length < 20) {
		failures.push({ test: failMatch[1].trim(), message: failMatch[1].trim() });
	}

	const jestFailRe = /FAIL\s+(\S+\.(?:test|spec)\.[jt]sx?)\s*\n([\s\S]*?)(?=\n(?:FAIL|PASS|Test Suites:|Tests:)|$)/g;
	let jestFail: RegExpExecArray | null;
	while ((jestFail = jestFailRe.exec(output)) !== null && failures.length < 20) {
		const file = jestFail[1];
		const block = jestFail[2];
		const bullets = [...block.matchAll(/●\s+(.+)/g)];
		if (bullets.length === 0) {
			failures.push({ test: file, file, message: block.trim().slice(0, 400) || 'failed' });
		} else {
			for (const b of bullets) {
				const test = b[1].trim();
				const after = block.slice((b.index ?? 0) + b[0].length);
				const loc = after.match(/at\s+\S+\s+\(([^):]+):(\d+)/) ?? after.match(/\(([^):]+):(\d+):\d+\)/);
				const errLine = after.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('●') && !l.startsWith('at '));
				failures.push({
					test,
					file: loc?.[1] ?? file,
					line: loc ? parseIntSafe(loc[2]) : undefined,
					message: errLine ?? test,
				});
			}
		}
	}

	if (!m && failures.length === 0 && !hasJestMarkers && !hasVitestMarkers) {
		return null;
	}
	if (m && failed === 0 && passed === 0 && skipped === 0 && failures.length === 0 && !hasJestMarkers && !hasVitestMarkers) {
		return null;
	}

	return {
		framework,
		passed,
		failed: failed || failures.length,
		skipped,
		failures,
		exitCode,
		rawTail: rawTailOf(output),
		command: '',
	};
};

const mochaMatcher: Matcher = (output, exitCode) => {
	const passing = output.match(/(\d+)\s+passing/);
	const failing = output.match(/(\d+)\s+failing/);
	const pending = output.match(/(\d+)\s+pending/);
	if (!passing && !failing) {
		return null;
	}
	const failures: TestFailure[] = [];
	const failRe = /(\d+)\)\s+([\s\S]*?):\s*\n\s*([\s\S]*?)(?=\n\s*\d+\)|\n\s*$)/g;
	let m: RegExpExecArray | null;
	while ((m = failRe.exec(output)) !== null && failures.length < 20) {
		const test = m[2].replace(/\s+/g, ' ').trim();
		const message = m[3].trim().split('\n')[0]?.trim() ?? test;
		const loc = m[3].match(/\(([^):]+):(\d+):\d+\)/);
		failures.push({
			test,
			file: loc?.[1],
			line: loc ? parseIntSafe(loc[2]) : undefined,
			message,
		});
	}
	return {
		framework: 'mocha',
		passed: parseIntSafe(passing?.[1]),
		failed: parseIntSafe(failing?.[1]) || failures.length,
		skipped: parseIntSafe(pending?.[1]),
		failures,
		exitCode,
		rawTail: rawTailOf(output),
		command: '',
	};
};

const pytestMatcher: Matcher = (output, exitCode) => {
	// Prefer the short summary line: ===== 1 failed, 1 passed in 0.05s =====
	const summary = output.match(
		/=+\s+(\d+)\s+failed,\s+(\d+)\s+passed(?:,\s+(\d+)\s+skipped)?/i,
	) ?? output.match(
		/=+\s+(\d+)\s+passed(?:,\s+(\d+)\s+skipped)?(?:,\s+(\d+)\s+failed)?/i,
	);
	const hasFailedLines = /^FAILED\s+/m.test(output);
	if (!summary && !hasFailedLines) {
		return null;
	}
	const failures: TestFailure[] = [];
	const failRe = /^FAILED\s+(\S+?)(?:\s+-\s+(.*))?$/gm;
	let m: RegExpExecArray | null;
	while ((m = failRe.exec(output)) !== null && failures.length < 20) {
		const full = m[1];
		const message = (m[2] ?? full).trim();
		const parts = full.split('::');
		const file = parts[0];
		const test = parts.slice(1).join('::') || full;
		const loc = output.match(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`));
		failures.push({
			test,
			file,
			line: loc ? parseIntSafe(loc[1]) : undefined,
			message,
		});
	}
	const failed = summary ? parseIntSafe(summary[1]) : failures.length;
	const passed = summary ? parseIntSafe(summary[2]) : 0;
	const skipped = summary ? parseIntSafe(summary[3]) : 0;
	return {
		framework: 'pytest',
		passed,
		failed: failed || failures.length,
		skipped,
		failures,
		exitCode,
		rawTail: rawTailOf(output),
		command: '',
	};
};

const mavenSurefireMatcher: Matcher = (output, exitCode) => {
	const summary = output.match(
		/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/i,
	);
	if (!summary) {
		return null;
	}
	const run = parseIntSafe(summary[1]);
	const failuresCount = parseIntSafe(summary[2]);
	const errors = parseIntSafe(summary[3]);
	const skipped = parseIntSafe(summary[4]);
	const failed = failuresCount + errors;
	const failures: TestFailure[] = [];
	const failRe = /(?:<<< FAILURE!|<<< ERROR!)!\s*\n?([^\n]+)?/g;
	let m: RegExpExecArray | null;
	while ((m = failRe.exec(output)) !== null && failures.length < 20) {
		const test = (m[1] ?? 'unknown').trim();
		failures.push({ test, message: test });
	}
	// org.example.FooTest.testBar:42 expected...
	const locRe = /(\S+Test(?:\.\S+)?):(\d+)\s+(.+)/g;
	while ((m = locRe.exec(output)) !== null && failures.length < 20) {
		failures.push({ test: m[1], file: m[1].replace(/\./g, '/') + '.java', line: parseIntSafe(m[2]), message: m[3].trim() });
	}
	return {
		framework: 'maven-surefire',
		passed: Math.max(0, run - failed - skipped),
		failed,
		skipped,
		failures,
		exitCode,
		rawTail: rawTailOf(output),
		command: '',
	};
};

const goTestMatcher: Matcher = (output, exitCode) => {
	if (!/--- (FAIL|PASS):/.test(output) && !/^FAIL\t/m.test(output) && !/^ok\s+/m.test(output)) {
		return null;
	}
	const failures: TestFailure[] = [];
	const failRe = /--- FAIL: (\S+) \([^)]+\)\n((?:.+\n)*?)(?=--- |FAIL\t|ok\s+|$)/g;
	let m: RegExpExecArray | null;
	while ((m = failRe.exec(output)) !== null && failures.length < 20) {
		const test = m[1];
		const body = m[2];
		const loc = body.match(/(\S+_test\.go):(\d+):\s*(.*)/);
		failures.push({
			test,
			file: loc?.[1],
			line: loc ? parseIntSafe(loc[2]) : undefined,
			message: loc?.[3]?.trim() || body.trim().split('\n')[0]?.trim() || test,
		});
	}
	const passed = [...output.matchAll(/--- PASS: /g)].length;
	const failed = [...output.matchAll(/--- FAIL: /g)].length || failures.length;
	const skipped = [...output.matchAll(/--- SKIP: /g)].length;
	if (passed === 0 && failed === 0 && skipped === 0 && !/^FAIL\t/m.test(output)) {
		return null;
	}
	return {
		framework: 'go',
		passed,
		failed,
		skipped,
		failures,
		exitCode,
		rawTail: rawTailOf(output),
		command: '',
	};
};

const MATCHERS: Matcher[] = [
	pytestMatcher,
	mavenSurefireMatcher,
	mochaMatcher,
	goTestMatcher,
	jestLikeMatcher('jest'),
	jestLikeMatcher('vitest'),
];

export const parseTestOutput = (output: string, exitCode: number, command = ''): TestRunResult => {
	const cleaned = output.replace(/\u001b\[[0-9;]*m/g, '');
	for (const matcher of MATCHERS) {
		const parsed = matcher(cleaned, exitCode);
		if (parsed) {
			return { ...parsed, command: command || parsed.command };
		}
	}
	return {
		framework: 'unknown',
		passed: 0,
		failed: exitCode === 0 ? 0 : 1,
		skipped: 0,
		failures: exitCode === 0 ? [] : [{ test: '(unparsed)', message: 'Could not parse test framework output — see raw tail.' }],
		exitCode,
		rawTail: rawTailOf(cleaned),
		command,
	};
};

export const formatTestRunResult = (result: TestRunResult): string => {
	const { framework, passed, failed, skipped, failures, exitCode, command, rawTail } = result;
	const lines: string[] = [
		`Tests (${framework}): ${passed} passed, ${failed} failed, ${skipped} skipped (exit ${exitCode})`,
	];
	if (command) {
		lines.push(`Command: ${command}`);
	}
	const show = failures.slice(0, 5);
	for (const f of show) {
		const loc = f.file ? `${f.file}${f.line != null ? `:${f.line}` : ''}` : undefined;
		lines.push(`FAIL ${loc ? `${loc} — ` : ''}${f.test}`);
		if (f.message && f.message !== f.test) {
			lines.push(`  ${f.message.slice(0, 300)}`);
		}
	}
	if (failures.length > 5) {
		lines.push(`…and ${failures.length - 5} more failure(s)`);
	}
	if (framework === 'unknown' && rawTail) {
		lines.push('--- raw output (tail) ---');
		lines.push(rawTail);
	}
	return lines.join('\n');
};

export type RunTestsDeps = {
	terminalToolService: ITerminalToolService;
	getWorkspaceRoot: () => string | null;
	getDefaultTestCommand: () => string | null;
};

export const runTests = async (
	params: { testCommand: string | null; filePattern: string | null; terminalId?: string },
	deps: RunTestsDeps,
): Promise<{ result: Promise<TestRunResult>; interruptTool: () => void }> => {
	const baseCommand = params.testCommand?.trim() || deps.getDefaultTestCommand()?.trim() || 'npm test';
	const command = appendFilePattern(baseCommand, params.filePattern);
	const cwd = deps.getWorkspaceRoot();
	const terminalId = params.terminalId ?? generateUuid();
	const { resPromise, interrupt } = await deps.terminalToolService.runCommand(command, {
		type: 'temporary',
		cwd,
		terminalId,
	});
	const result = resPromise.then(({ result: output, resolveReason }) => {
		const exitCode = resolveReason.type === 'done' ? resolveReason.exitCode : 1;
		return parseTestOutput(output, exitCode, command);
	});
	return { result, interruptTool: interrupt };
};

export type { TerminalResolveReason };
