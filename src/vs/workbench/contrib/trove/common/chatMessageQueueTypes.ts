/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { StagingSelectionItem } from './chatThreadServiceTypes.js';

/** A user message waiting to run after the current agent workflow finishes. */
export type QueuedUserMessage = {
	id: string;
	userMessage: string;
	displayMessage?: string;
	selections: StagingSelectionItem[];
	queuedAt: string;
};
