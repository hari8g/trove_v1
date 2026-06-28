/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IRepoIntelligenceService } from '../../common/repoIntelligenceTypes.js';
import { BuiltinToolCallParams, BuiltinToolResultType } from '../../common/toolsServiceTypes.js';
import { StaasBuiltinToolName } from './staasToolNames.js';
import { verifySecurityCompliance } from './securityVerifierTool.js';

export type StaasToolHandlerDeps = {
	repoIntelligenceService: IRepoIntelligenceService;
	getWorkspaceRoot: () => string | undefined;
	assertOrgExtensionToolAvailable: (toolName: StaasBuiltinToolName) => void;
};

type StaasToolCallResult<T extends StaasBuiltinToolName> = {
	result: BuiltinToolResultType[T];
};

export type StaasBuiltinToolCallHandlers = {
	[T in StaasBuiltinToolName]: (
		params: BuiltinToolCallParams[T],
	) => Promise<StaasToolCallResult<T>>;
};

export const queryServiceTopology = (
	deps: Pick<StaasToolHandlerDeps, 'repoIntelligenceService'>,
	{ query }: BuiltinToolCallParams['query_service_topology'],
): StaasToolCallResult<'query_service_topology'> => {
	const profile = deps.repoIntelligenceService.getProfileSync();
	const topo = profile?.serviceTopologySummary;
	if (!topo) {
		return { result: { summary: 'No Spring Boot services detected in this workspace. Ensure pom.xml files with spring-boot dependency exist.' } };
	}
	const queryLower = query.toLowerCase();
	let summary = `Service Topology — ${topo.serviceCount} services, ${topo.totalEndpoints} endpoints\n\n`;

	if (queryLower.includes('gateway') || queryLower.includes('route')) {
		summary += `Gateway Routes:\n${topo.gatewayRoutes.map(r => `  ${r.pathPattern} → ${r.targetService}`).join('\n')}`;
	} else if (queryLower.includes('feign') || queryLower.includes('call') || queryLower.includes('depend')) {
		summary += `Feign Dependencies:\n${topo.feignEdges.map(e => `  ${e.caller} calls: ${e.targets.join(', ')}`).join('\n')}`;
	} else {
		summary += `Services: ${topo.serviceNames.join(', ')}\n\n`;
		summary += `Gateway Routes:\n${topo.gatewayRoutes.slice(0, 10).map(r => `  ${r.pathPattern} → ${r.targetService}`).join('\n')}`;
	}
	return { result: { summary } };
};

export const resolveApiContract = async (
	deps: Pick<StaasToolHandlerDeps, 'repoIntelligenceService' | 'getWorkspaceRoot'>,
	{ httpMethod, pathPattern }: BuiltinToolCallParams['resolve_api_contract'],
): Promise<StaasToolCallResult<'resolve_api_contract'>> => {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		return { result: { contract: 'No workspace open.' } };
	}

	const contract = await deps.repoIntelligenceService.resolveApiContract(workspaceRoot, httpMethod, pathPattern);
	if (!contract) {
		return { result: { contract: `No endpoint found for ${httpMethod} ${pathPattern}. Check that the workspace has been indexed.` } };
	}

	const lines = [
		`API Contract: ${contract.httpMethod} ${contract.pathPattern}`,
		`Backend service: ${contract.backendService}`,
		`Controller: ${contract.controllerClass}.${contract.handlerMethod}()`,
		`File: ${contract.filePath}`,
	];
	if (contract.requestDto) {
		lines.push(`@RequestBody: ${contract.requestDto}`);
	}
	if (contract.responseDto) {
		lines.push(`Response type: ${contract.responseDto}`);
	}

	return { result: { contract: lines.join('\n') } };
};

export const getMavenImpact = async (
	deps: Pick<StaasToolHandlerDeps, 'repoIntelligenceService' | 'getWorkspaceRoot'>,
	{ artifactId }: BuiltinToolCallParams['get_maven_impact'],
): Promise<StaasToolCallResult<'get_maven_impact'>> => {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		return { result: { consumers: [], impactLevel: 'low' } };
	}

	const consumers = await deps.repoIntelligenceService.getMavenImpact(workspaceRoot, artifactId);
	const count = consumers.length;
	const impactLevel = count >= 10 ? 'critical' : count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low';

	return { result: { consumers, impactLevel } };
};

export const getNpmImpact = async (
	deps: Pick<StaasToolHandlerDeps, 'repoIntelligenceService' | 'getWorkspaceRoot'>,
	{ packageName }: BuiltinToolCallParams['get_npm_impact'],
): Promise<StaasToolCallResult<'get_npm_impact'>> => {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		return { result: { consumers: [], impactLevel: 'low' } };
	}

	const consumers = await deps.repoIntelligenceService.getNpmConsumers(workspaceRoot, packageName);
	const count = consumers.length;
	const impactLevel =
		count >= 5 ? 'critical' :
			count >= 3 ? 'high' :
				count >= 1 ? 'medium' : 'low';

	return { result: { consumers, impactLevel } };
};

export const getConfigDrift = async (
	deps: Pick<StaasToolHandlerDeps, 'repoIntelligenceService' | 'getWorkspaceRoot'>,
	{ serviceName }: BuiltinToolCallParams['get_config_drift'],
): Promise<StaasToolCallResult<'get_config_drift'>> => {
	const workspaceRoot = deps.getWorkspaceRoot();
	if (!workspaceRoot) {
		return { result: { drifts: [], summary: 'No workspace open.' } };
	}

	const drifts = await deps.repoIntelligenceService.getConfigDrift(workspaceRoot, serviceName);
	if (drifts.length === 0) {
		return { result: { drifts: [], summary: `No config drift detected for ${serviceName} across environments.` } };
	}

	const lines = [`Config drift for ${serviceName} (${drifts.length} properties):\n`];
	for (const d of drifts.slice(0, 20)) {
		const envPairs = Object.entries(d.envValues).map(([e, v]) => `${e}=${v}`).join(', ');
		lines.push(`  ${d.key}: ${envPairs}`);
	}
	if (drifts.length > 20) {
		lines.push(`  …(${drifts.length - 20} more properties)`);
	}

	return { result: { drifts, summary: lines.join('\n') } };
};

export const verifySecurityComplianceTool = (
	{ code, fileExtension }: BuiltinToolCallParams['verify_security_compliance'],
): StaasToolCallResult<'verify_security_compliance'> => ({
	result: verifySecurityCompliance(code, fileExtension),
});

export const createStaasBuiltinToolCallHandlers = (deps: StaasToolHandlerDeps): StaasBuiltinToolCallHandlers => ({
	query_service_topology: async (params) => {
		deps.assertOrgExtensionToolAvailable('query_service_topology');
		return queryServiceTopology(deps, params);
	},
	resolve_api_contract: async (params) => {
		deps.assertOrgExtensionToolAvailable('resolve_api_contract');
		return resolveApiContract(deps, params);
	},
	get_maven_impact: async (params) => {
		deps.assertOrgExtensionToolAvailable('get_maven_impact');
		return getMavenImpact(deps, params);
	},
	get_npm_impact: async (params) => {
		deps.assertOrgExtensionToolAvailable('get_npm_impact');
		return getNpmImpact(deps, params);
	},
	get_config_drift: async (params) => {
		deps.assertOrgExtensionToolAvailable('get_config_drift');
		return getConfigDrift(deps, params);
	},
	verify_security_compliance: async (params) => {
		deps.assertOrgExtensionToolAvailable('verify_security_compliance');
		return verifySecurityComplianceTool(params);
	},
});
