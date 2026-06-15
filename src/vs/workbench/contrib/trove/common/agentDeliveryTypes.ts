/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type AgentDeliveryStatus =
	| 'build_succeeded'
	| 'server_running'
	| 'verified';

export type AgentDeliverySummary = {
	status: AgentDeliveryStatus;
	buildCommand?: string;
	serverCommand?: string;
	previewUrl?: string;
	buildLabel?: string;
	serverLabel?: string;
	previewOpenedInEditor: boolean;
	updatedAt: string;
};
