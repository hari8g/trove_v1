import * as assert from 'assert';
import { indexTerraformResources } from '../terraformIndexer.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

suite('TerraformIndexer', () => {
	let tempDir: string;

	setup(() => {
		tempDir = join(tmpdir(), `trove-tf-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	teardown(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	test('indexes azurerm resources', () => {
		writeFileSync(join(tempDir, 'main.tf'), `
resource "azurerm_kubernetes_cluster" "aks_prod" {
  name = "staas-prod-aks"
  location = "East US"
}

resource "azurerm_redis_cache" "cache" {
  name = "staas-redis"
}
`);
		const result = indexTerraformResources(tempDir);
		assert.strictEqual(result.resources.length, 2);
		assert.ok(result.providers.includes('azurerm'));
		assert.strictEqual(result.fileCount, 1);
	});

	test('detects provider declarations', () => {
		writeFileSync(join(tempDir, 'providers.tf'), `
provider "azurerm" {
  features {}
}
provider "azuread" {}
`);
		const result = indexTerraformResources(tempDir);
		assert.ok(result.providers.includes('azurerm'));
		assert.ok(result.providers.includes('azuread'));
	});
});
