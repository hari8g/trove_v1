import * as assert from 'assert';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { indexConfigEnvironments } from '../configEnvIndexer.js';

suite('Trove - configEnvIndexer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let tempDir: string;

	setup(() => {
		tempDir = join(tmpdir(), `trove-config-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	teardown(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	test('indexes local application-{env}.yml files', () => {
		const serviceDir = join(tempDir, 'staas-auth-service', 'src', 'main', 'resources');
		mkdirSync(serviceDir, { recursive: true });
		writeFileSync(join(serviceDir, 'application-dev.yml'), [
			'server:',
			'  port: 8080',
			'feature:',
			'  enabled: true',
		].join('\n'));
		writeFileSync(join(serviceDir, 'application-prod.yml'), [
			'server:',
			'  port: 8443',
			'feature:',
			'  enabled: false',
		].join('\n'));

		const result = indexConfigEnvironments(tempDir);
		assert.ok(result.fileCount >= 2);
		assert.ok(result.properties.some(p => p.key === 'server.port' && p.env === 'dev' && p.value === '8080'));
		assert.ok(result.properties.some(p => p.key === 'server.port' && p.env === 'prod' && p.value === '8443'));
		assert.ok(result.envDrift.some(d => d.key === 'server.port'));
	});

	test('detects env drift for the same service key', () => {
		const serviceDir = join(tempDir, 'staas-billing-service', 'config');
		mkdirSync(serviceDir, { recursive: true });
		writeFileSync(join(serviceDir, 'application-qa.yml'), 'timeout: 30\n');
		writeFileSync(join(serviceDir, 'application-uat.yml'), 'timeout: 60\n');

		const result = indexConfigEnvironments(tempDir);
		const drift = result.envDrift.find(d => d.key === 'timeout');
		assert.ok(drift);
		assert.strictEqual(drift!.envValues.qa, '30');
		assert.strictEqual(drift!.envValues.uat, '60');
	});

	test('parses cloud-style service-env filenames', () => {
		const cloudDir = join(tempDir, 'config-server');
		mkdirSync(cloudDir, { recursive: true });
		writeFileSync(join(cloudDir, 'staas-gateway-prod.yml'), 'gateway:\n  url: https://prod.example\n');

		const result = indexConfigEnvironments(tempDir);
		assert.ok(result.properties.some(p => p.env === 'prod' && p.key === 'gateway.url'));
	});
});
