"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-check
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootDir = path_1.default.resolve(__dirname, '..', '..');
function runProcess(command, args = []) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, { cwd: rootDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
        child.on('exit', err => !err ? resolve() : process.exit(err ?? 1));
        child.on('error', reject);
    });
}
async function exists(subdir) {
    try {
        await fs_1.promises.stat(path_1.default.join(rootDir, subdir));
        return true;
    }
    catch {
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
    const logoPath = path_1.default.join(rootDir, 'src/vs/workbench/browser/parts/editor/media/trove-logo-dark.png');
    const icnsPath = path_1.default.join(rootDir, 'resources/darwin/code.icns');
    const generateScript = path_1.default.join(rootDir, 'scripts/generate-app-icons.sh');
    let shouldGenerate = !(await exists('resources/darwin/code.icns'));
    if (!shouldGenerate) {
        try {
            const [logoStat, icnsStat] = await Promise.all([
                fs_1.promises.stat(logoPath),
                fs_1.promises.stat(icnsPath),
            ]);
            shouldGenerate = logoStat.mtimeMs > icnsStat.mtimeMs;
        }
        catch {
            shouldGenerate = true;
        }
    }
    if (shouldGenerate) {
        await runProcess('bash', [generateScript]);
        return;
    }
    if (process.platform === 'darwin' && await exists('.build/electron/Trove.app/Contents/Resources/Trove.icns')) {
        await fs_1.promises.copyFile(icnsPath, path_1.default.join(rootDir, '.build/electron/Trove.app/Contents/Resources/Trove.icns'));
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
//# sourceMappingURL=preLaunch.js.map