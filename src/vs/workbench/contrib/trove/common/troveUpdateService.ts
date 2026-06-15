/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { TroveCheckUpdateResponse } from './troveUpdateServiceTypes.js';



export interface ITroveUpdateService {
	readonly _serviceBrand: undefined;
	check: (explicit: boolean) => Promise<TroveCheckUpdateResponse>;
}


export const ITroveUpdateService = createDecorator<ITroveUpdateService>('TroveUpdateService');


// implemented by calling channel
export class TroveUpdateService implements ITroveUpdateService {

	readonly _serviceBrand: undefined;
	private readonly troveUpdateService: ITroveUpdateService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService, // (only usable on client side)
	) {
		// creates an IPC proxy to use metricsMainService.ts
		this.troveUpdateService = ProxyChannel.toService<ITroveUpdateService>(mainProcessService.getChannel('trove-channel-update'));
	}


	// anything transmitted over a channel must be async even if it looks like it doesn't have to be
	check: ITroveUpdateService['check'] = async (explicit) => {
		const res = await this.troveUpdateService.check(explicit)
		return res
	}
}

registerSingleton(ITroveUpdateService, TroveUpdateService, InstantiationType.Eager);


