/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { BuiltinToolName } from '../../common/toolsServiceTypes.js';

/** Built-in tools that require organization-specific (STaaS) extensions. */
export const STAAS_BUILTIN_TOOL_NAMES = [
	'query_service_topology',
	'resolve_api_contract',
	'get_maven_impact',
	'get_npm_impact',
	'get_config_drift',
	'verify_security_compliance',
] as const satisfies readonly BuiltinToolName[];

export type StaasBuiltinToolName = typeof STAAS_BUILTIN_TOOL_NAMES[number];

/** Default for `globalSettings.orgExtensions` (Step 3.6: restore pre-flag STaaS tool availability). */
export const DEFAULT_ORG_EXTENSIONS_ENABLED = true;

const staasToolNameSet = new Set<string>(STAAS_BUILTIN_TOOL_NAMES);

export const isStaasBuiltinToolName = (toolName: string): toolName is StaasBuiltinToolName =>
	staasToolNameSet.has(toolName);

export const filterStaasBuiltinToolNames = <T extends BuiltinToolName>(
	toolNames: readonly T[],
	orgExtensionsEnabled: boolean,
): T[] => {
	if (orgExtensionsEnabled) {
		return [...toolNames];
	}
	return toolNames.filter(name => !isStaasBuiltinToolName(name));
};
