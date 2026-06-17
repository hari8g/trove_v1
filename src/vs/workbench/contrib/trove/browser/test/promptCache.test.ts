/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isAnthropicRoutedModel } from '../../common/promptCache.js';

suite('Trove - promptCache', () => {

	test('isAnthropicRoutedModel detects Claude via OpenRouter', () => {
		assert.strictEqual(isAnthropicRoutedModel('openRouter', 'anthropic/claude-3.5-sonnet'), true);
		assert.strictEqual(isAnthropicRoutedModel('openAI', 'gpt-4o'), false);
	});
});
