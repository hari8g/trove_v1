import * as assert from 'assert';
import { indexMavenDependencies } from '../mavenDependencyIndexer.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

suite('MavenDependencyIndexer', () => {
	let tempDir: string;

	setup(() => {
		tempDir = join(tmpdir(), `trove-maven-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	teardown(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	test('parses dependencies from pom.xml', async () => {
		writeFileSync(join(tempDir, 'pom.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>ms-data-model</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`);
		const result = await indexMavenDependencies(tempDir);
		assert.strictEqual(result.pomCount, 1);
		assert.ok(result.deps.some(d => d.artifactId === 'ms-data-model'));
	});
});
