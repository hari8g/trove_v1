/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type WebSearchResult = {
	title: string;
	url: string;
	snippet: string;
};

export interface IWebSearchService {
	readonly _serviceBrand: undefined;
	search(query: string, maxResults: number): Promise<WebSearchResult[]>;
}

export const IWebSearchService = createDecorator<IWebSearchService>('troveWebSearchService');
