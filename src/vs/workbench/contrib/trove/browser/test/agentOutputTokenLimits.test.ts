/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AGENT_ANTHROPIC_OUTPUT_TOKENS,
	getAnthropicBetaHeaders,
	getEffectiveMaxOutputTokens,
	isLikelyOutputTruncated,
} from '../../common/agentOutputTokenLimits.js';

suite('Trove - agentOutputTokenLimits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('getEffectiveMaxOutputTokens bumps anthropic agent output', () => {
		assert.strictEqual(getEffectiveMaxOutputTokens('anthropic', 'agent', 8192), AGENT_ANTHROPIC_OUTPUT_TOKENS);
		assert.strictEqual(getEffectiveMaxOutputTokens('anthropic', 'gather', 8192), 8192);
	});

	test('getAnthropicBetaHeaders includes extended output for agent', () => {
		const beta = getAnthropicBetaHeaders({ enablePromptCache: true, chatMode: 'agent' });
		assert.ok(beta?.includes('output-128k-2025-02-19'));
		assert.ok(beta?.includes('prompt-caching-2024-07-31'));
	});

	test('isLikelyOutputTruncated detects output at cap', () => {
		assert.strictEqual(isLikelyOutputTruncated(8192, 8192), true);
		assert.strictEqual(isLikelyOutputTruncated(4000, 8192), false);
	});
});
