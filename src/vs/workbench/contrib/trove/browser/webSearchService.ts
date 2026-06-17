/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { ITroveSettingsService } from '../common/troveSettingsService.js';
import { IWebSearchService, WebSearchResult } from '../common/webSearchTypes.js';

type TavilySearchResponse = {
	results?: {
		title?: string;
		url?: string;
		content?: string;
	}[];
};

class WebSearchService extends Disposable implements IWebSearchService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ITroveSettingsService private readonly troveSettingsService: ITroveSettingsService,
	) {
		super();
	}

	async search(query: string, maxResults: number): Promise<WebSearchResult[]> {
		const { enableWebSearch, webSearchApiKey } = this.troveSettingsService.state.globalSettings;
		if (!enableWebSearch) {
			throw new Error('Web search is disabled in Trove settings (Feature Options → Agent & token economy).');
		}

		const apiKey = webSearchApiKey?.trim();
		if (!apiKey) {
			throw new Error('No Tavily API key configured. Add one in Trove Settings → Feature Options → Agent & token economy → Web search API key.');
		}

		const context = await this.requestService.request({
			type: 'POST',
			url: 'https://api.tavily.com/search',
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({
				api_key: apiKey,
				query,
				max_results: maxResults,
				search_depth: 'basic',
				include_answer: false,
			}),
		}, CancellationToken.None);

		const body = await asJson<TavilySearchResponse>(context);
		if (!body?.results) {
			return [];
		}

		return body.results.map(r => ({
			title: r.title ?? '',
			url: r.url ?? '',
			snippet: r.content ?? '',
		}));
	}
}

registerSingleton(IWebSearchService, WebSearchService, InstantiationType.Delayed);
