/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IChatThreadService } from './chatThreadService.js';
import { ITroveSettingsService } from '../common/troveSettingsService.js';
import { IRiafAgentService } from '../common/riaf/riafTypes.js';
import { IRepoIntelligenceService } from '../common/repoIntelligenceTypes.js';
import { RiafAgentRunController } from './riafAgentRunController.js';

class RiafAgentService extends RiafAgentRunController {
	constructor(
		@IChatThreadService chatThreadService: IChatThreadService,
		@ITroveSettingsService settingsService: ITroveSettingsService,
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
		@IFileService fileService: IFileService,
		@IRepoIntelligenceService repoIntelligenceService: IRepoIntelligenceService,
	) {
		super(chatThreadService, settingsService, workspaceService, fileService, repoIntelligenceService);
	}
}

registerSingleton(IRiafAgentService, RiafAgentService, InstantiationType.Delayed);
