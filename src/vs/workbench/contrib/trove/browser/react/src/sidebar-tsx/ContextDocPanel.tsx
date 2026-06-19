/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { URI } from '../../../../../../../base/common/uri.js';
import type { RiafRunState } from '../../../../common/riaf/riafTypes.js';
import { useAccessor } from '../util/services.js';

export function ContextDocPanel() {
	const accessor = useAccessor();
	const riafService = accessor.get('IRiafAgentService');
	const threadService = accessor.get('IChatThreadService');
	const commandService = accessor.get('ICommandService');

	const [state, setState] = useState<RiafRunState>(riafService.state);

	useEffect(() => {
		const sub = riafService.onDidChangeState(setState);
		return () => sub.dispose();
	}, [riafService]);

	useEffect(() => {
		if (state.status === 'running') {
			threadService.switchToThread(state.threadId);
		}
	}, [state, threadService]);

	const handleStart = useCallback(() => {
		void riafService.startRun();
	}, [riafService]);

	const handleAbort = useCallback(() => {
		void riafService.abort();
	}, [riafService]);

	const handleOpen = useCallback(() => {
		if (state.status !== 'done') {
			return;
		}
		void commandService.executeCommand('vscode.open', URI.file(state.outputPath));
	}, [state, commandService]);

	const outputFileName = state.status === 'done'
		? state.outputPath.replace(/\\/g, '/').split('/').pop() ?? riafService.expectedOutputFileName
		: riafService.expectedOutputFileName;

	return (
		<div style={{
			padding: '10px 12px',
			borderBottom: '1px solid var(--vscode-editorGroup-border)',
		}}>
			<div style={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				marginBottom: 6,
			}}>
				<span style={{
					fontSize: 11,
					fontWeight: 600,
					textTransform: 'uppercase',
					letterSpacing: '0.06em',
					color: 'var(--vscode-descriptionForeground)',
				}}>
					Context Document
				</span>

				{state.status === 'idle' && (
					<button onClick={handleStart} style={btnStyle('primary')}>
						Analyse Repo
					</button>
				)}
				{state.status === 'running' && (
					<button onClick={handleAbort} style={btnStyle('danger')}>
						Stop
					</button>
				)}
				{(state.status === 'done' || state.status === 'error') && (
					<button onClick={handleStart} style={btnStyle('secondary')}>
						Re-analyse
					</button>
				)}
			</div>

			{state.status === 'running' && (
				<div style={{
					fontSize: 11,
					color: 'var(--vscode-descriptionForeground)',
					display: 'flex',
					alignItems: 'center',
					gap: 6,
				}}>
					<span style={{ animation: 'spin 1s linear infinite' }}>⟳</span>
					Agent is analysing the repository…
				</div>
			)}

			{state.status === 'done' && (
				<div>
					<div style={{ fontSize: 11, color: 'var(--vscode-terminal-ansiGreen)', marginBottom: 4 }}>
						✓ {outputFileName} written
					</div>
					<button onClick={handleOpen} style={{
						...btnStyle('link'),
						width: '100%',
						textAlign: 'left',
					}}>
						Open {outputFileName} →
					</button>
					<div style={{
						fontSize: 10,
						color: 'var(--vscode-descriptionForeground)',
						marginTop: 4,
						opacity: 0.7,
					}}>
						Tag in chat: @{outputFileName}
					</div>
				</div>
			)}

			{state.status === 'error' && (
				<div style={{ fontSize: 11, color: 'var(--vscode-errorForeground)', marginTop: 4 }}>
					✗ {state.message}
				</div>
			)}
		</div>
	);
}

function btnStyle(variant: 'primary' | 'secondary' | 'danger' | 'link'): React.CSSProperties {
	const base: React.CSSProperties = {
		fontSize: 11,
		padding: '2px 8px',
		cursor: 'pointer',
		border: 'none',
		borderRadius: 3,
	};
	if (variant === 'primary') {
		return {
			...base,
			background: 'var(--vscode-button-background)',
			color: 'var(--vscode-button-foreground)',
		};
	}
	if (variant === 'secondary') {
		return {
			...base,
			background: 'var(--vscode-button-secondaryBackground)',
			color: 'var(--vscode-button-secondaryForeground)',
		};
	}
	if (variant === 'danger') {
		return {
			...base,
			background: 'transparent',
			color: 'var(--vscode-errorForeground)',
			border: '1px solid var(--vscode-errorForeground)',
		};
	}
	return {
		...base,
		background: 'transparent',
		color: 'var(--vscode-textLink-foreground)',
		border: '1px solid var(--vscode-textLink-foreground)',
	};
}
