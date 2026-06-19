/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { AgentDeliverySummary } from './agentDeliveryTypes.js';

export const buildDeliveryNextStepsMessage = (delivery: AgentDeliverySummary): string => {
	const lines: string[] = ['**What to do next**', ''];

	if (delivery.previewUrl) {
		lines.push(
			`- **Preview the app** — use **Open** on the delivery card above (or the workspace browser). ` +
			`Trove serves \`${delivery.previewUrl}\` from the **Trove Agent** background terminal — you do not need to run \`npm start\` in your own terminal.`,
		);
	}

	const pending = delivery.pendingDiffCount ?? 0;
	if (pending > 0) {
		lines.push(`- **Review edits** — approve or reject the ${pending} pending change${pending === 1 ? '' : 's'} in the delivery card.`);
	} else if (delivery.filesChanged?.length) {
		lines.push('- **Review edits** — open the changed files in the editor and confirm they look right.');
	}

	if (delivery.buildLabel && delivery.status !== 'verified') {
		lines.push(`- **Build** — \`${delivery.buildLabel}\` completed in the agent sandbox.`);
	}

	lines.push('- **Iterate** — tell me what to fix, add tests, or refine styling based on what you see in the preview.');

	return lines.join('\n');
};
