/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** STaaS organization extension boundary (strangler-fig module). */
export type { StaasBuiltinToolName } from './staasToolNames.js';
export {
	STAAS_BUILTIN_TOOL_NAMES,
	DEFAULT_ORG_EXTENSIONS_ENABLED,
	filterStaasBuiltinToolNames,
	isStaasBuiltinToolName,
} from './staasToolNames.js';
export type {
	StaasBuiltinToolCallParams,
	StaasBuiltinToolResultType,
	StaasImpactLevel,
	StaasConfigDriftEntry,
} from './staasToolTypes.js';
export type {
	ApiContractResult,
	ConfigDriftSummary,
	IStaasRepoIntelligenceMethods,
	MavenImpactSummary,
	NpmImpactSummary,
	ServiceTopologySummary,
	StaasWorkspaceProfileFields,
} from './staasRepoIntelligenceTypes.js';
export type { SecurityVerifyResult, SecurityViolation } from './securityVerifierTool.js';
export { verifySecurityCompliance } from './securityVerifierTool.js';
export type { OrgExtensionIndexerOptions } from './staasIndexerDefaults.js';
export {
	DEFAULT_ORG_EXTENSION_CONFIG_SERVER_DIRS,
	DEFAULT_ORG_EXTENSION_NPM_SCOPES,
	resolveOrgExtensionIndexerOptions,
} from './staasIndexerDefaults.js';
export type { StaasBuiltinToolCallHandlers, StaasToolHandlerDeps } from './staasToolHandlers.js';
export {
	createStaasBuiltinToolCallHandlers,
	getConfigDrift,
	getMavenImpact,
	getNpmImpact,
	queryServiceTopology,
	resolveApiContract,
} from './staasToolHandlers.js';
