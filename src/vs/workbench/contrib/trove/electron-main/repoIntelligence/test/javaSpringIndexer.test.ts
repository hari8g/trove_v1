import * as assert from 'assert';
import { indexJavaSpringService } from '../javaSpringIndexer.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

suite('JavaSpringIndexer', () => {
	let tempDir: string;

	setup(() => {
		tempDir = join(tmpdir(), `trove-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	teardown(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	test('detects @RestController endpoints', () => {
		const src = join(tempDir, 'src', 'main', 'java', 'com', 'example');
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, 'OrderController.java'), `
@RestController
@RequestMapping("/order")
public class OrderController {
  @GetMapping("/{id}")
  public OrderResponse getOrder(@PathVariable Long id) { return null; }

  @PostMapping
  public OrderResponse createOrder(@RequestBody OrderRequest req) { return null; }
}
`);
		const result = indexJavaSpringService(tempDir, tempDir);
		assert.ok(result.endpoints.length >= 2, 'Should detect at least 2 endpoints');
		const getEp = result.endpoints.find(e => e.httpMethod === 'GET');
		assert.ok(getEp, 'Should have a GET endpoint');
		assert.ok(getEp!.pathPattern.includes('/order'), 'Path should include /order');
	});

	test('detects @FeignClient declarations', () => {
		const src = join(tempDir, 'src', 'main', 'java');
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, 'OrderServiceClient.java'), `
@FeignClient(name = "staas-order-management")
public interface OrderServiceClient {
  @GetMapping("/order/{id}")
  OrderResponse getOrder(@PathVariable Long id);
}
`);
		const result = indexJavaSpringService(tempDir, tempDir);
		assert.ok(result.feignClients.length >= 1, 'Should detect FeignClient');
		assert.strictEqual(result.feignClients[0].targetService, 'staas-order-management');
	});
});
