/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { ToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { BuiltinToolName, ToolName } from '../../../../common/toolsServiceTypes.js';
import { useAccessor } from '../util/services.js';
import {
	BottomChildren,
	CodeChildren,
	getTitle,
	RunningToolActivityRow,
	ToolHeaderParams,
	ToolHeaderWrapper,
	toolNameToDesc,
} from './ToolResultWrapperUi.js';

export type WrapperProps<T extends ToolName> = {
	toolMessage: Exclude<ToolMessage<T>, { type: 'invalid_params' }>;
	messageIdx: number;
	threadId: string;
};

export type ResultWrapper<T extends ToolName> = (props: WrapperProps<T>) => React.ReactNode;

export const toolErrorBottomChildren = (result: string) => (
	<BottomChildren title='Error'>
		<CodeChildren>
			{result}
		</CodeChildren>
	</BottomChildren>
);

type StandardToolCustomize<T extends BuiltinToolName> = (ctx: {
	accessor: ReturnType<typeof useAccessor>;
	toolMessage: Exclude<ToolMessage<T>, { type: 'invalid_params' }>;
	componentParams: ToolHeaderParams;
}) => void;

/** Collapses the repeated header + running + error boilerplate shared by many builtin tool rows. */
export const createStandardToolResultWrapper = <T extends BuiltinToolName>(opts?: {
	hideToolRequest?: boolean;
	customize?: StandardToolCustomize<T>;
}): ResultWrapper<T> => {
	const hideToolRequest = opts?.hideToolRequest ?? true;
	return ({ toolMessage }) => {
		const accessor = useAccessor();
		if (hideToolRequest && toolMessage.type === 'tool_request') return null;
		if (toolMessage.type === 'running_now') return <RunningToolActivityRow toolMessage={toolMessage} />;

		const title = getTitle(toolMessage);
		const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
		const componentParams: ToolHeaderParams = {
			title,
			desc1,
			desc1Info,
			isError: false,
			icon: null,
			isRejected: toolMessage.type === 'rejected',
		};

		opts?.customize?.({ accessor, toolMessage, componentParams });

		if (toolMessage.type === 'tool_error') {
			componentParams.bottomChildren = toolErrorBottomChildren(toolMessage.result);
		}

		return <ToolHeaderWrapper {...componentParams} />;
	};
};
