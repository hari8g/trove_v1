/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type StaasImpactLevel = 'critical' | 'high' | 'medium' | 'low';

export type StaasBuiltinToolCallParams = {
	'query_service_topology': { query: string };
	'resolve_api_contract': { httpMethod: string; pathPattern: string };
	'get_maven_impact': { artifactId: string };
	'get_npm_impact': { packageName: string };
	'get_config_drift': { serviceName: string };
	'verify_security_compliance': { code: string; fileExtension: string };
};

export type StaasBuiltinToolResultType = {
	'query_service_topology': { summary: string };
	'resolve_api_contract': { contract: string };
	'get_maven_impact': { consumers: string[]; impactLevel: StaasImpactLevel };
	'get_npm_impact': { consumers: string[]; impactLevel: StaasImpactLevel };
	'get_config_drift': { drifts: StaasConfigDriftEntry[]; summary: string };
	'verify_security_compliance': {
		violations: { rule: string; severity: string; message: string }[];
		passed: boolean;
		summary: string;
	};
};

export type StaasConfigDriftEntry = {
	key: string;
	envValues: Record<string, string>;
};
