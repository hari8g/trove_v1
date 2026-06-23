import * as assert from 'assert';
import { verifySecurityCompliance } from '../securityVerifierTool.js';

suite('SecurityVerifierTool', () => {

	test('flags missing tenant filter in Java @Query', () => {
		const code = `
@Repository
public interface OrderRepo extends JpaRepository<Order, Long> {
  @Query("SELECT o FROM Order o WHERE o.status = :status")
  List<Order> findByStatus(@Param("status") String status);
}`;
		const result = verifySecurityCompliance(code, '.java');
		const rule = result.violations.find(v => v.rule === 'TENANT_ISOLATION_01');
		assert.ok(rule, 'Should flag TENANT_ISOLATION_01');
		assert.strictEqual(rule!.severity, 'critical');
	});

	test('passes when tenantId filter is present', () => {
		const code = `
@Query("SELECT o FROM Order o WHERE o.tenantId = :tenantId AND o.status = :status")
List<Order> findByStatus(@Param("tenantId") String tenantId, @Param("status") String status);`;
		const result = verifySecurityCompliance(code, '.java');
		const rule = result.violations.find(v => v.rule === 'TENANT_ISOLATION_01');
		assert.ok(!rule, 'Should NOT flag when tenantId is present');
	});

	test('flags unsecured @RestController', () => {
		const code = `
@RestController
@RequestMapping("/order")
public class OrderController {
  @GetMapping("/{id}")
  public OrderResponse getOrder(@PathVariable Long id) { return null; }
}`;
		const result = verifySecurityCompliance(code, '.java');
		const rule = result.violations.find(v => v.rule === 'JWT_VALIDATION_01');
		assert.ok(rule, 'Should flag JWT_VALIDATION_01');
	});

	test('flags plaintext secret in YAML', () => {
		const code = `
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-secret: myS3cr3tK3y123456
`;
		const result = verifySecurityCompliance(code, '.yml');
		const rule = result.violations.find(v => v.rule === 'SECRET_LEAK_01');
		assert.ok(rule, 'Should flag SECRET_LEAK_01');
		assert.strictEqual(rule!.severity, 'critical');
	});

	test('passes Spring expression placeholder secrets', () => {
		const code = `
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-secret: \${KEYCLOAK_CLIENT_SECRET}
`;
		const result = verifySecurityCompliance(code, '.yml');
		const rule = result.violations.find(v => v.rule === 'SECRET_LEAK_01');
		assert.ok(!rule, 'Should NOT flag ${...} placeholder secrets');
	});
});
