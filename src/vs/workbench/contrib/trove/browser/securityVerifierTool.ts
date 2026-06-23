/*---------------------------------------------------------------------------
 * SecurityVerifierTool — static analysis rules for STaaS multi-tenancy
 * isolation, JWT validation, OWASP compliance, and secret leak detection.
 *---------------------------------------------------------------------------*/

export type SecurityViolation = {
	rule: string;
	severity: 'critical' | 'high' | 'medium';
	message: string;
};

export type SecurityVerifyResult = {
	violations: SecurityViolation[];
	passed: boolean;
	summary: string;
};

type SecurityRule = {
	id: string;
	severity: SecurityViolation['severity'];
	appliesTo: string[];
	check: (code: string) => boolean;
	message: string;
};

const SECURITY_RULES: SecurityRule[] = [
	{
		id: 'TENANT_ISOLATION_01',
		severity: 'critical',
		appliesTo: ['.java'],
		check: (code) => {
			const hasQuery = /@Query|findAll\s*\(\s*\)|\.findAll\s*\(|nativeQuery\s*=\s*true/.test(code);
			const hasTenantFilter = /tenantId|tenant_id|getTenantId|tenantContext|TenantContext/.test(code);
			return hasQuery && !hasTenantFilter;
		},
		message: 'TENANT_ISOLATION_01: DB query found without tenantId filter. All repository queries in multi-tenant STaaS services MUST filter by tenantId to prevent cross-tenant data exposure.',
	},
	{
		id: 'JWT_VALIDATION_01',
		severity: 'high',
		appliesTo: ['.java'],
		check: (code) => {
			const hasController = /@RestController|@Controller/.test(code);
			const hasMapping = /@GetMapping|@PostMapping|@PutMapping|@DeleteMapping|@PatchMapping|@RequestMapping/.test(code);
			const hasSecurity = /@PreAuthorize|@Secured|SecurityConfig|\.permitAll\(\)|\.authenticated\(\)|hasRole|hasAuthority/.test(code);
			return hasController && hasMapping && !hasSecurity;
		},
		message: 'JWT_VALIDATION_01: @RestController has endpoint mappings without @PreAuthorize or security configuration. All STaaS endpoints must declare explicit access control.',
	},
	{
		id: 'JWKS_RESOLUTION_01',
		severity: 'high',
		appliesTo: ['.yml', '.yaml'],
		check: (code) => /jwks-uri:\s*https?:\/\/(?!localhost|127\.0\.0\.1|\$\{)/.test(code),
		message: 'JWKS_RESOLUTION_01: Hardcoded JWKS URI in YAML config. Use the jwks-multitenancy-service for dynamic per-tenant JWKS resolution. Hardcoded URIs break multi-tenancy.',
	},
	{
		id: 'SECRET_LEAK_01',
		severity: 'critical',
		appliesTo: ['.yml', '.yaml'],
		check: (code) => /(?:client-secret|password|secret-key|api-key):\s*(?!\$\{)[A-Za-z0-9+\/=!@#%^&*]{12,}/.test(code),
		message: 'SECRET_LEAK_01: Potential plaintext secret in YAML. Use K8s Secret references (${SECRET_NAME}) or Spring Cloud Config encrypted properties. Never commit credentials.',
	},
	{
		id: 'FEIGN_AUTH_01',
		severity: 'high',
		appliesTo: ['.java'],
		check: (code) => {
			const hasFeignClient = /@FeignClient/.test(code);
			const hasAuthPropagation = /RequestInterceptor|Authorization|BearerTokenRequestInterceptor|OAuth2FeignRequestInterceptor|feign\.oauth2/.test(code);
			return hasFeignClient && !hasAuthPropagation;
		},
		message: 'FEIGN_AUTH_01: @FeignClient detected without Authorization header propagation. Add a RequestInterceptor bean that forwards the JWT Bearer token for service-to-service calls.',
	},
	{
		id: 'OWASP_VERSION_01',
		severity: 'medium',
		appliesTo: ['.xml'],
		check: (code) => {
			const hasDepsBlock = /<dependencies>[\s\S]*?<\/dependencies>/.test(code);
			const hasLiteralVersion = /<version>[0-9]+\.[0-9]+[^<]*<\/version>/.test(code);
			const hasManagedDeps = /<dependencyManagement>/.test(code);
			return hasDepsBlock && hasLiteralVersion && !hasManagedDeps;
		},
		message: 'OWASP_VERSION_01: Dependency with hardcoded version in pom.xml. Prefer version management via the parent BOM (owasp-main) to ensure coordinated vulnerability patching.',
	},
	{
		id: 'CORS_POLICY_01',
		severity: 'medium',
		appliesTo: ['.java'],
		check: (code) => /@CrossOrigin\s*\(\s*origins\s*=\s*"\*"/.test(code),
		message: 'CORS_POLICY_01: Wildcard @CrossOrigin origins detected. STaaS APIs should restrict CORS to known frontend domains (mobilitymarketplace.io, boschindia-mobilitysolutions.com).',
	},
];

export function verifySecurityCompliance(code: string, fileExtension: string): SecurityVerifyResult {
	const ext = fileExtension.startsWith('.') ? fileExtension : `.${fileExtension}`;
	const applicable = SECURITY_RULES.filter(r => r.appliesTo.includes(ext));
	const violations: SecurityViolation[] = [];

	for (const rule of applicable) {
		try {
			if (rule.check(code)) {
				violations.push({ rule: rule.id, severity: rule.severity, message: rule.message });
			}
		} catch {
			// Regex errors should never fail the verification — skip the rule
		}
	}

	const criticals = violations.filter(v => v.severity === 'critical').length;
	const highs = violations.filter(v => v.severity === 'high').length;
	const mediums = violations.filter(v => v.severity === 'medium').length;
	const passed = criticals === 0 && highs === 0;

	let summary: string;
	if (passed && mediums === 0) {
		summary = 'Security verification PASSED — no violations detected.';
	} else if (passed) {
		summary = `Security verification PASSED with ${mediums} medium advisory note(s). Review before merging.`;
	} else {
		summary = `Security verification FAILED: ${criticals} critical, ${highs} high, ${mediums} medium violation(s). Fix before writing to disk.`;
	}

	return { violations, passed, summary };
}
