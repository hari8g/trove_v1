/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { filesToStagingSelections, SUPPORTED_ATTACHMENT_ACCEPT } from '../util/attachmentUtils.js';
import { useAccessor } from '../util/services.js';

type ChatAttachmentButtonProps = {
	disabled?: boolean;
};

export const ChatAttachmentButton = ({ disabled }: ChatAttachmentButtonProps) => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const inputRef = useRef<HTMLInputElement>(null);
	const [isProcessing, setIsProcessing] = useState(false);

	const onPickFiles = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		e.target.value = '';
		if (files.length === 0) return;

		setIsProcessing(true);
		try {
			const newSelections = await filesToStagingSelections(files);
			for (const selection of newSelections) {
				chatThreadService.addNewStagingSelection(selection);
			}
		} catch (err) {
			console.error('Failed to attach file:', err);
		} finally {
			setIsProcessing(false);
		}
	}, [chatThreadService]);

	const onButtonClick = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		e.preventDefault();
		inputRef.current?.click();
	}, []);

	return (
		<>
			<input
				ref={inputRef}
				type="file"
				accept={SUPPORTED_ATTACHMENT_ACCEPT}
				multiple
				tabIndex={-1}
				className="absolute w-0 h-0 opacity-0 overflow-hidden"
				style={{ position: 'absolute', left: -9999 }}
				onChange={onPickFiles}
			/>
			<button
				type="button"
				disabled={disabled || isProcessing}
				className={`rounded flex-shrink-0 flex-grow-0 flex items-center justify-center w-[26px] h-[26px]
					${disabled || isProcessing ? 'opacity-40 cursor-default' : 'cursor-pointer opacity-70 hover:opacity-100'}
				`}
				data-tooltip-id="trove-tooltip"
				data-tooltip-content="Attach images or PDFs"
				data-tooltip-place="top"
				aria-label="Attach images or PDFs"
				onClick={onButtonClick}
			>
				<Paperclip size={15} className={isProcessing ? 'animate-pulse' : ''} />
			</button>
		</>
	);
};
