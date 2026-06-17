/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

import path from 'path';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootDir = path.resolve(__dirname, '..', '..');

function runProcess(command: string, args: ReadonlyArray<string> = []) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
		child.on('exit', err => !err ? resolve() : process.exit(err ?? 1));
		child.on('error', reject);
	});
}

async function exists(subdir: string) {
	try {
		await fs.stat(path.join(rootDir, subdir));
		return true;
	} catch {
		return false;
	}
}

async function ensureNodeModules() {
	if (!(await exists('node_modules'))) {
		await runProcess(npm, ['ci']);
	}
}

async function getElectron() {
	await runProcess(npm, ['run', 'electron']);
}

async function ensureAppIcons() {
	const logoPath = path.join(rootDir, 'src/vs/workbench/browser/parts/editor/media/trove-logo-dark.png');
	const icnsPath = path.join(rootDir, 'resources/darwin/code.icns');
	const generateScript = path.join(rootDir, 'scripts/generate-app-icons.sh');

	let shouldGenerate = !(await exists('resources/darwin/code.icns'));
	if (!shouldGenerate) {
		try {
			const [logoStat, icnsStat] = await Promise.all([
				fs.stat(logoPath),
				fs.stat(icnsPath),
			]);
			shouldGenerate = logoStat.mtimeMs > icnsStat.mtimeMs;
		} catch {
			shouldGenerate = true;
		}
	}

	if (shouldGenerate) {
		await runProcess('bash', [generateScript]);
		return;
	}

	if (process.platform === 'darwin' && await exists('.build/electron/Trove.app/Contents/Resources/Trove.icns')) {
		await fs.copyFile(icnsPath, path.join(rootDir, '.build/electron/Trove.app/Contents/Resources/Trove.icns'));
	}
}

async function ensureCompiled() {
	// The `out/` folder can exist after a partial/failed compile (e.g. interrupted watch).
	// Electron requires the root entry point from package.json.
	if (!(await exists('out/main.js'))) {
		await runProcess(npm, ['run', 'compile']);
	}
}

async function main() {
	await ensureNodeModules();
	await getElectron();
	await ensureAppIcons();
	await ensureCompiled();

	// Can't require this until after dependencies are installed
	const { getBuiltInExtensions } = require('./builtInExtensions');
	await getBuiltInExtensions();
}

if (require.main === module) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
