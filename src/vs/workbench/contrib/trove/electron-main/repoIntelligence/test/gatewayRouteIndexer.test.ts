import * as assert from 'assert';
import { indexGatewayRoutes } from '../gatewayRouteIndexer.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

suite('GatewayRouteIndexer', () => {
	let tempDir: string;

	setup(() => {
		tempDir = join(tmpdir(), `trove-gateway-test-${Date.now()}`);
		mkdirSync(join(tempDir, 'src', 'main', 'resources'), { recursive: true });
	});

	teardown(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	test('parses Spring Cloud Gateway routes', () => {
		writeFileSync(join(tempDir, 'src', 'main', 'resources', 'application.yml'), `
spring:
  cloud:
    gateway:
      routes:
      - id: order-route
        uri: lb://staas-order-management
        predicates:
        - Path=/order/**
`);
		const routes = indexGatewayRoutes(tempDir);
		assert.ok(routes.length >= 1);
		assert.strictEqual(routes[0].targetService, 'staas-order-management');
		assert.ok(routes[0].pathPredicate.includes('/order'));
	});
});
