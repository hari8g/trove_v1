/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	appendFilePattern,
	formatTestRunResult,
	parseTestOutput,
} from '../testRunnerService.js';

suite('Trove - testOutputParsers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('appendFilePattern adds -- for npm scripts', () => {
		assert.strictEqual(appendFilePattern('npm test', 'foo.test.ts'), 'npm test -- foo.test.ts');
		assert.strictEqual(appendFilePattern('npx vitest run', 'a.spec.ts'), 'npx vitest run a.spec.ts');
		assert.strictEqual(appendFilePattern('npm test', null), 'npm test');
	});

	test('parses Jest failures with file and line', () => {
		const output = `
FAIL src/math.test.js
  ● Math › add

    expect(received).toBe(expected)

    Expected: 3
    Received: 4

      10 |   it('add', () => {
    > 11 |     expect(add(1, 2)).toBe(4);
         |                       ^
      12 |   });

      at Object.<anonymous> (src/math.test.js:11:23)

FAIL src/str.test.js
  ● Str › trim
    Expected true

      at Object.<anonymous> (src/str.test.js:5:10)

FAIL src/arr.test.js
  ● Arr › map
    boom

      at Object.<anonymous> (src/arr.test.js:8:5)

Test Suites: 3 failed, 3 total
Tests:       3 failed, 2 passed, 5 total
`;
		const parsed = parseTestOutput(output, 1, 'npm test');
		assert.strictEqual(parsed.framework, 'jest');
		assert.strictEqual(parsed.failed, 3);
		assert.strictEqual(parsed.passed, 2);
		assert.ok(parsed.failures.length >= 3);
		assert.ok(parsed.failures.some(f => f.file?.includes('math.test') && f.line === 11));
		const formatted = formatTestRunResult(parsed);
		assert.ok(formatted.includes('3 failed'));
		assert.ok(formatted.split('\n').filter(l => l.startsWith('FAIL ')).length <= 5);
	});

	test('parses Vitest summary', () => {
		const output = `
 ✓ src/a.test.ts (2)
 × src/b.test.ts (1)
   × b fails

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 2 passed (3)
`;
		const parsed = parseTestOutput(output, 1);
		assert.ok(parsed.framework === 'vitest' || parsed.framework === 'jest');
		assert.ok(parsed.failed >= 1);
		assert.ok(parsed.passed >= 1);
	});

	test('parses Mocha failing', () => {
		const output = `
  Math
    ✔ adds

  1) Math
       subtracts:
     AssertionError: expected 1 to equal 0
      at Context.<anonymous> (test/math.js:12:14)

  1 passing (20ms)
  1 failing
`;
		const parsed = parseTestOutput(output, 1);
		assert.strictEqual(parsed.framework, 'mocha');
		assert.strictEqual(parsed.passed, 1);
		assert.strictEqual(parsed.failed, 1);
		assert.ok(parsed.failures[0]?.file?.includes('math.js'));
		assert.strictEqual(parsed.failures[0]?.line, 12);
	});

	test('parses pytest FAILED lines', () => {
		const output = `
tests/test_math.py::test_add FAILED                           [50%]
tests/test_math.py::test_sub PASSED                           [100%]

=================================== FAILURES ===================================
_______________________________ test_add ________________________________
tests/test_math.py:10: in test_add
    assert add(1, 2) == 4
E   assert 3 == 4

=========================== short test summary info ============================
FAILED tests/test_math.py::test_add - assert 3 == 4
========================= 1 failed, 1 passed in 0.05s ==========================
`;
		const parsed = parseTestOutput(output, 1);
		assert.strictEqual(parsed.framework, 'pytest');
		assert.strictEqual(parsed.failed, 1);
		assert.strictEqual(parsed.passed, 1);
		assert.strictEqual(parsed.failures[0]?.file, 'tests/test_math.py');
		assert.strictEqual(parsed.failures[0]?.test, 'test_add');
	});

	test('parses Maven Surefire summary', () => {
		const output = `
[INFO] Tests run: 5, Failures: 2, Errors: 0, Skipped: 1
[ERROR] com.example.FooTest.testBar:42 expected:<1> but was:<2>
`;
		const parsed = parseTestOutput(output, 1);
		assert.strictEqual(parsed.framework, 'maven-surefire');
		assert.strictEqual(parsed.failed, 2);
		assert.strictEqual(parsed.skipped, 1);
		assert.strictEqual(parsed.passed, 2);
	});

	test('parses Go test failures', () => {
		const output = `
--- FAIL: TestAdd (0.00s)
    math_test.go:12: got 3 want 4
--- PASS: TestSub (0.00s)
FAIL
FAIL	example.com/math	0.001s
`;
		const parsed = parseTestOutput(output, 1);
		assert.strictEqual(parsed.framework, 'go');
		assert.strictEqual(parsed.failed, 1);
		assert.strictEqual(parsed.passed, 1);
		assert.strictEqual(parsed.failures[0]?.file, 'math_test.go');
		assert.strictEqual(parsed.failures[0]?.line, 12);
	});

	test('unknown fallback includes raw tail', () => {
		const output = 'line1\n'.repeat(50) + 'weird runner output';
		const parsed = parseTestOutput(output, 1, 'custom-test');
		assert.strictEqual(parsed.framework, 'unknown');
		assert.ok(parsed.rawTail.includes('weird runner output'));
		assert.ok(parsed.rawTail.split('\n').length <= 40);
		const formatted = formatTestRunResult(parsed);
		assert.ok(formatted.includes('raw output'));
	});
});
