/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	createStaasBuiltinToolCallHandlers,
	getConfigDrift,
	getMavenImpact,
	getNpmImpact,
	queryServiceTopology,
	resolveApiContract,
} from './staasToolHandlers.js';
import { ServiceTopologySummary } from '../../common/repoIntelligenceTypes.js';

suite('Trove - staasToolHandlers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const sampleTopology: ServiceTopologySummary = {
		serviceCount: 2,
		totalEndpoints: 5,
		serviceNames: ['order-service', 'catalog-service'],
		gatewayRoutes: [
			{ pathPattern: '/order/**', targetService: 'order-service' },
			{ pathPattern: '/catalog/**', targetService: 'catalog-service' },
		],
		feignEdges: [{ caller: 'order-service', targets: ['catalog-service'] }],
	};

	test('queryServiceTopology summarizes gateway routes when query mentions gateway', () => {
		const result = queryServiceTopology({
			repoIntelligenceService: {
				getProfileSync: () => ({ serviceTopologySummary: sampleTopology } as any),
			} as any,
		}, { query: 'show gateway routes' });

		assert.ok(result.result.summary.includes('Gateway Routes:'));
		assert.ok(result.result.summary.includes('/order/**'));
	});

	test('queryServiceTopology returns empty-workspace message when topology missing', () => {
		const result = queryServiceTopology({
			repoIntelligenceService: { getProfileSync: () => null } as any,
		}, { query: 'services' });

		assert.ok(result.result.summary.includes('No Spring Boot services detected'));
	});

	test('resolveApiContract formats contract details', async () => {
		const result = await resolveApiContract({
			getWorkspaceRoot: () => '/workspace',
			repoIntelligenceService: {
				resolveApiContract: async () => ({
					httpMethod: 'GET',
					pathPattern: '/order/{id}',
					backendService: 'order-service',
					controllerClass: 'OrderController',
					handlerMethod: 'getOrder',
					filePath: 'OrderController.java',
					requestDto: null,
					responseDto: 'OrderResponse',
				}),
			} as any,
		}, { httpMethod: 'GET', pathPattern: '/order/{id}' });

		assert.ok(result.result.contract.includes('OrderController.getOrder()'));
		assert.ok(result.result.contract.includes('Response type: OrderResponse'));
	});

	test('getMavenImpact maps consumer count to impact level', async () => {
		const result = await getMavenImpact({
			getWorkspaceRoot: () => '/workspace',
			repoIntelligenceService: {
				getMavenImpact: async () => Array.from({ length: 10 }, (_, i) => `consumer-${i}`),
			} as any,
		}, { artifactId: 'shared-lib' });

		assert.strictEqual(result.result.impactLevel, 'critical');
		assert.strictEqual(result.result.consumers.length, 10);
	});

	test('getNpmImpact returns low impact when no consumers', async () => {
		const result = await getNpmImpact({
			getWorkspaceRoot: () => '/workspace',
			repoIntelligenceService: {
				getNpmConsumers: async () => [],
			} as any,
		}, { packageName: '@scope/pkg' });

		assert.strictEqual(result.result.impactLevel, 'low');
	});

	test('getConfigDrift summarizes differing properties', async () => {
		const result = await getConfigDrift({
			getWorkspaceRoot: () => '/workspace',
			repoIntelligenceService: {
				getConfigDrift: async () => [{
					key: 'spring.datasource.url',
					envValues: { dev: 'jdbc:dev', prod: 'jdbc:prod' },
				}],
			} as any,
		}, { serviceName: 'billing-service' });

		assert.ok(result.result.summary.includes('spring.datasource.url'));
		assert.strictEqual(result.result.drifts.length, 1);
	});

	test('createStaasBuiltinToolCallHandlers rejects when org extensions disabled', async () => {
		const handlers = createStaasBuiltinToolCallHandlers({
			getWorkspaceRoot: () => '/workspace',
			repoIntelligenceService: { getProfileSync: () => null } as any,
			assertOrgExtensionToolAvailable: () => {
				throw new Error('org extensions disabled');
			},
		});

		await assert.rejects(
			() => handlers.query_service_topology({ query: 'services' }),
			/org extensions disabled/,
		);
	});
});
