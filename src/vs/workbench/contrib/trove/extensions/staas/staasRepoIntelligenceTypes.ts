/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { StaasConfigDriftEntry } from './staasToolTypes.js';

export type ServiceTopologySummary = {
	serviceCount: number;
	serviceNames: string[];
	gatewayRoutes: { pathPattern: string; targetService: string }[];
	feignEdges: { caller: string; targets: string[] }[];
	totalEndpoints: number;
};

export type MavenImpactSummary = {
	sharedLibs: { artifactId: string; consumerCount: number }[];
	pomCount: number;
};

export type NpmImpactSummary = {
	sharedPackages: { packageName: string; consumerCount: number }[];
	packageJsonCount: number;
};

export type ConfigDriftSummary = {
	driftCount: number;
	fileCount: number;
	topDriftedServices: string[];
};

export type ApiContractResult = {
	pathPattern: string;
	httpMethod: string;
	backendService: string;
	controllerClass: string;
	handlerMethod: string;
	requestDto?: string;
	responseDto?: string;
	filePath: string;
};

/** Optional profile fields populated by org-extension indexers. */
export type StaasWorkspaceProfileFields = {
	serviceTopologySummary?: ServiceTopologySummary | null;
	mavenImpactSummary?: MavenImpactSummary | null;
	npmImpactSummary?: NpmImpactSummary | null;
	configDriftSummary?: ConfigDriftSummary | null;
};

export interface IStaasRepoIntelligenceMethods {
	getServiceTopology(workspaceRoot: string): Promise<ServiceTopologySummary | null>;
	getMavenImpact(workspaceRoot: string, artifactId: string): Promise<string[]>;
	resolveApiContract(workspaceRoot: string, httpMethod: string, pathPattern: string): Promise<ApiContractResult | null>;
	getNpmConsumers(workspaceRoot: string, packageName: string): Promise<string[]>;
	getConfigDrift(workspaceRoot: string, serviceName: string): Promise<StaasConfigDriftEntry[]>;
}
