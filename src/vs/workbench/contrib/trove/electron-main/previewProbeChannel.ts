/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IRequestService } from '../../../../platform/request/common/request.js';

/** Probes localhost dev-server URLs from the main process (renderer fetch is blocked by workbench CSP). */
export class PreviewProbeChannel implements IServerChannel {

	constructor(
		private readonly requestService: IRequestService,
	) { }

	listen(): never {
		throw new Error('Invalid listen');
	}

	call<T>(_ctx: unknown, command: string, args?: unknown, _token?: CancellationToken): Promise<T> {
		if (command === 'probe') {
			const [url, timeoutMs] = args as [string, number | undefined];
			const normalized = url?.trim();
			if (!normalized) {
				return Promise.resolve(false as T);
			}
			return this.requestService.request({
				type: 'GET',
				url: normalized,
				timeout: timeoutMs ?? 4_000,
			}, CancellationToken.None).then(context => {
				const status = context.res.statusCode ?? 0;
				return (status >= 200 && status < 500) as T;
			}).catch(() => false as T);
		}
		return Promise.reject(new Error(`PreviewProbeChannel: command "${command}" not recognized.`));
	}
}
