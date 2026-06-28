{\rtf1\ansi\ansicpg1252\cocoartf2867
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fnil\fcharset0 Menlo-Regular;\f1\fnil\fcharset0 Menlo-Italic;}
{\colortbl;\red255\green255\blue255;\red221\green221\blue221;\red19\green19\blue19;\red205\green204\blue213;
\red119\green179\blue197;\red218\green124\blue212;\red245\green188\blue80;\red114\green201\blue195;}
{\*\expandedcolortbl;;\cssrgb\c89412\c89412\c89412;\cssrgb\c9412\c9412\c9412;\cssrgb\c83922\c83922\c86667;
\cssrgb\c53333\c75294\c81569;\cssrgb\c89020\c58039\c86275;\cssrgb\c97255\c78039\c38431;\cssrgb\c50980\c82353\c80784;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\deftab720
\pard\pardeftab720\partightenfactor0

\f0\fs24 \cf2 \cb3 \expnd0\expndtw0\kerning0
\outl0\strokewidth0 \strokec2 #\cf4 \strokec4  \cf5 \strokec5 Trove AI Layer \'97 Implementation Plan\cf2 \cb1 \strokec2 \
\
\cb3 > Turns \cf6 \strokec6 `GAP_TRACKING.md`\cf2 \strokec2 's findings and \cf6 \strokec6 `REFACTOR_PLAN.md`\cf2 \strokec2 's phases into an executable, ordered sequence of steps. Every step states the exact change, what to verify before and after, and how to back out if something regresses. The repo already has a CI gate for this \'97 \cf6 \strokec6 `.github/workflows/trove-tests.yml`\cf2 \strokec2  runs \cf6 \strokec6 `npm run test-trove`\cf2 \strokec2  (mocha, glob \cf6 \strokec6 `vs/workbench/contrib/trove/**/*.test.js`\cf2 \strokec2 ) on every push/PR touching \cf6 \strokec6 `src/vs/workbench/contrib/trove/**`\cf2 \strokec2 . Every step below is designed to go through that gate.\cb1 \
\
\cb3 ---\cb1 \
\
\cb3 ##\cf4 \strokec4  \cf5 \strokec5 0. Safety protocol (applies to every step below)\cf2 \cb1 \strokec2 \
\
\cb3 This is what "without breaking what's working" means in practice for this codebase, given that the riskiest files (the three god-objects, the entire React UI) currently have zero tests:\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf4 \cb3 \strokec4 1.\cf2 \strokec2  \cf7 \strokec7 **One logical change per branch/PR.**\cf2 \strokec2  Never combine a bug fix with a refactor, and never combine two unrelated fixes in one PR \'97 if \cf6 \strokec6 `test-trove`\cf2 \strokec2  goes red or a manual smoke test fails, you need to know instantly which change caused it.\cb1 \
\cf4 \cb3 \strokec4 2.\cf2 \strokec2  \cf7 \strokec7 **Test before you touch, not after.**\cf2 \strokec2  For any file with zero coverage that you're about to modify (the three god-objects, \cf6 \strokec6 `modelCapabilities.ts`\cf2 \strokec2 , the 9 untested indexers, anything in \cf6 \strokec6 `browser/react/`\cf2 \strokec2 ), write a 
\f1\i \cf8 \strokec8 *characterization test*
\f0\i0 \cf2 \strokec2  first \'97 a test that asserts today's actual behavior, even if that behavior is the bug you're about to fix. Commit that test on its own, confirm it passes against the unmodified code, then make your change. This converts "I think this still works" into "the test still passes."\cb1 \
\cf4 \cb3 \strokec4 3.\cf2 \strokec2  \cf7 \strokec7 **Run the full gate locally before pushing:**\cf2 \strokec2  \cf6 \strokec6 `npm run compile && npm run test-trove`\cf2 \strokec2 . For anything touching \cf6 \strokec6 `electron-main/repoIntelligence/`\cf2 \strokec2 , also run the existing suite there directly via the same \cf6 \strokec6 `test-trove`\cf2 \strokec2  glob (it already covers that folder's \cf6 \strokec6 `test/`\cf2 \strokec2  directory) so a change in a shared helper doesn't silently break an indexer's existing test.\cb1 \
\cf4 \cb3 \strokec4 4.\cf2 \strokec2  \cf7 \strokec7 **Manual smoke checklist for anything touching the agent loop or UI**\cf2 \strokec2  (since \cf6 \strokec6 `browser/react/`\cf2 \strokec2  and the three god-objects have no automated coverage yet \'97 this is the manual substitute until Phase 1 below lands real tests): open a workspace, send one agent-chat message that triggers at least one tool call (e.g. a file read + edit), accept the resulting diff, run \cf6 \strokec6 `Ctrl+K`\cf2 \strokec2  quick edit once, and open Settings once. This exercises \cf6 \strokec6 `chatThreadService.ts`\cf2 \strokec2 , \cf6 \strokec6 `toolsService.ts`\cf2 \strokec2 , \cf6 \strokec6 `editCodeService.ts`\cf2 \strokec2 , and the React settings tree in one pass \'97 the four areas every later step touches.\cb1 \
\cf4 \cb3 \strokec4 5.\cf2 \strokec2  \cf7 \strokec7 **Behavior-changing fixes ship behind a flag, not a hard cutover.**\cf2 \strokec2  Specifically the STaaS-extraction work (Phase 2) and any god-object split that changes an external entry point's signature: gate the new path behind a setting or an internal flag defaulted to the old behavior, flip it after a release cycle of confirmation, then delete the old path in a separate follow-up PR. This gives you a one-line rollback instead of a revert-and-redeploy.\cb1 \
\cf4 \cb3 \strokec4 6.\cf2 \strokec2  \cf7 \strokec7 **Rollback is "git revert the PR," which only works if PRs stay small.**\cf2 \strokec2  This is the actual reason for rule 1 \'97 a 40-file PR can't be cleanly reverted if 3 of those files also got touched by something else afterward.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \cb3 ---\cb1 \
\
\cb3 ##\cf4 \strokec4  \cf5 \strokec5 Step 1 \'97 Phase 0 bug fixes (do first; each is its own PR)\cf2 \cb1 \strokec2 \
\
\cb3 Each of these is isolated, has no design risk, and should land before anything else so later phases aren't built on top of known-bad logic. \cf7 \strokec7 **For each, write the characterization/regression test in the same PR as the fix**\cf2 \strokec2  (these files have no existing tests to lean on, so the new test doubles as both the safety net and the permanent regression guard).\cb1 \
\
\cb3 | # | Fix | Test to add alongside it | Verify |\cb1 \
\cb3 |---|---|---|---|\cb1 \
\cb3 | 1.1 | \cf6 \strokec6 `common/modelCapabilities.ts`\cf2 \strokec2  ~409: change \cf6 \strokec6 `lower.includes('grok2') \\|\\| lower.includes('grok2')`\cf2 \strokec2  to the intended second condition (confirm against xAI's actual model-name patterns, likely \cf6 \strokec6 `grok-2`\cf2 \strokec2  with a hyphen, before assuming the second clause was meant to be different \'97 read the surrounding fallback chain first since this could also just be dead duplication to delete). | \cf6 \strokec6 `modelCapabilities.test.ts`\cf2 \strokec2  (new file) \'97 assert grok-2 and grok-3 model strings both resolve to their correct distinct fallback. | \cf6 \strokec6 `npm run test-trove`\cf2 \strokec2  |\cb1 \
\cb3 | 1.2 | Same file ~419-421: reorder or add an explicit condition so the maverick branch is reachable before the broader llama branch. | Same new test file \'97 assert \cf6 \strokec6 `llama4-maverick`\cf2 \strokec2  resolves to its own profile, not scout's. | \cf6 \strokec6 `npm run test-trove`\cf2 \strokec2  |\cb1 \
\cb3 | 1.3 | Same file ~876-880: change the xAI fallback's sequential \cf6 \strokec6 `if`\cf2 \strokec2 s to an \cf6 \strokec6 `else if`\cf2 \strokec2  chain (mirroring the already-correct pattern in \cf6 \strokec6 `anthropicModelOptions`\cf2 \strokec2  ~467-637). | Same new test file \'97 assert grok-2 doesn't get overwritten to grok-3. | \cf6 \strokec6 `npm run test-trove`\cf2 \strokec2  |\cb1 \
\cb3 | 1.4 | Same file ~1448: correct the OpenRouter \cf6 \strokec6 `anthropic/claude-sonnet-4`\cf2 \strokec2  cost entry so it doesn't match Opus's \cf6 \strokec6 `$15/$75`\cf2 \strokec2 ; cross-check against the native Anthropic pricing table in the same file for the correct number. | Add a pricing-table consistency assertion (Sonnet < Opus cost) so this class of copy-paste error can't silently recur. | \cf6 \strokec6 `npm run test-trove`\cf2 \strokec2  |\cb1 \
\cb3 | 1.5 | \cf6 \strokec6 `common/troveSettingsService.ts`\cf2 \strokec2  ~358 / \cf6 \strokec6 `common/troveSettingsTypes.ts`\cf2 \strokec2  ~495: pick one value for \cf6 \strokec6 `llmStreamStallTimeoutMs`\cf2 \strokec2  (recommend \cf6 \strokec6 `120_000`\cf2 \strokec2 , the one in \cf6 \strokec6 `defaultGlobalSettings`\cf2 \strokec2 , since that's the canonical default) and update the migration-path literal to match. | \cf6 \strokec6 `troveSettingsService.test.ts`\cf2 \strokec2  \'97 assert a fresh migration produces the same default as \cf6 \strokec6 `defaultGlobalSettings`\cf2 \strokec2 . | \cf6 \strokec6 `npm run test-trove`\cf2 \strokec2  |\cb1 \
\cb3 | 1.6 | \cf6 \strokec6 `electron-main/repoIntelligence/universalImportExtractor.ts:146-149`\cf2 \strokec2 : fix \cf6 \strokec6 `resolveRelativePath`\cf2 \strokec2 's loop to actually \cf6 \strokec6 `continue`\cf2 \strokec2 /try the next extension instead of returning on the first. | \cf6 \strokec6 `universalImportExtractor.test.ts`\cf2 \strokec2  (new file) \'97 assert a \cf6 \strokec6 `.tsx`\cf2 \strokec2  import resolves correctly, not as \cf6 \strokec6 `.ts`\cf2 \strokec2 . | \cf6 \strokec6 `npm run test-trove`\cf2 \strokec2  |\cb1 \
\cb3 | 1.7 | \cf6 \strokec6 `common/sendLLMMessageService.ts:186-196`\cf2 \strokec2 : add the missing \cf6 \strokec6 `delete this.llmMessageHooks.onAbort[requestId]`\cf2 \strokec2  to \cf6 \strokec6 `_clearChannelHooks`\cf2 \strokec2 . | \cf6 \strokec6 `sendLLMMessageService.test.ts`\cf2 \strokec2  (new file) \'97 fire a complete request, assert \cf6 \strokec6 `onAbort`\cf2 \strokec2  map no longer holds the requestId afterward. | \cf6 \strokec6 `npm run test-trove`\cf2 \strokec2  + manual: send several chat messages in a row, confirm no behavior change. |\cb1 \
\cb3 | 1.8 | \cf6 \strokec6 `browser/react/.../ChatActivityUI.tsx`\cf2 \strokec2  (\cf6 \strokec6 `LiveReasoningBlock`\cf2 \strokec2 ) and \cf6 \strokec6 `Settings.tsx`\cf2 \strokec2  (\cf6 \strokec6 `SimpleModelSettingsDialog`\cf2 \strokec2 ): move the early \cf6 \strokec6 `return null`\cf2 \strokec2  below all hook calls. Also add \cf6 \strokec6 `eslint-plugin-react-hooks`\cf2 \strokec2 's \cf6 \strokec6 `rules-of-hooks`\cf2 \strokec2  to the lint config if it isn't already enabled (check \cf6 \strokec6 `eslint.config.js`\cf2 \strokec2  first \'97 the repo has its own \cf6 \strokec6 `.eslint-plugin-local`\cf2 \strokec2 , so confirm there's no conflicting custom rule before adding). | No automated test (no React test infra yet \'97 see Step 3). Manual: open a chat thread with a live-reasoning model and watch it stream without console errors; open Settings \uc0\u8594  click a model row to open \cf6 \strokec6 `SimpleModelSettingsDialog`\cf2 \strokec2 . | Manual smoke test from \'a70.4, plus explicit reasoning-stream + settings-dialog check. |\cb1 \
\cb3 | 1.9 | \cf6 \strokec6 `browser/react/.../Settings.tsx`\cf2 \strokec2  29-37: add \cf6 \strokec6 `'mcp'`\cf2 \strokec2  to the \cf6 \strokec6 `Tab`\cf2 \strokec2  union type. Before fixing, run \cf6 \strokec6 `npx tsc --noEmit`\cf2 \strokec2  scoped to this file (or the project's existing type-check script) to confirm whether this is currently a silent error or already caught \'97 this tells you whether there's a broader type-check gap to flag separately. | N/A (type-only fix). | \cf6 \strokec6 `tsc`\cf2 \strokec2  clean + manual: open Settings, click the MCP tab, confirm it renders. |\cb1 \
\cb3 | 1.10 | Delete dead files: \cf6 \strokec6 `browser/aiRegexService.ts`\cf2 \strokec2 , \cf6 \strokec6 `browser/_dummyContrib.ts`\cf2 \strokec2 , \cf6 \strokec6 `browser/react/.../util/useScrollbarStyles.tsx`\cf2 \strokec2 . Before deleting each, \cf6 \strokec6 `grep -rn`\cf2 \strokec2  the exported symbol name across the full \cf6 \strokec6 `trove/`\cf2 \strokec2  tree (not just the file's own folder) to confirm zero live imports \'97 the agents that found these already did this check, but re-verify at fix time in case something changed. | N/A. | \cf6 \strokec6 `npm run compile`\cf2 \strokec2  (a stale import would fail compilation, which is the real safety net for deletions). |\cb1 \
\cb3 | 1.11 | Remove the orphaned "want to use" subsystem in \cf6 \strokec6 `TroveOnboarding.tsx`\cf2 \strokec2  (~461-558) and the commented-out blocks in \cf6 \strokec6 `extractCodeFromResult.ts`\cf2 \strokec2 , \cf6 \strokec6 `languageHelpers.ts`\cf2 \strokec2 , \cf6 \strokec6 `mcpServiceTypes.ts`\cf2 \strokec2 . | N/A. | \cf6 \strokec6 `npm run compile && npm run test-trove`\cf2 \strokec2 , manual: run through onboarding once end-to-end. |\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf7 \cb3 \strokec7 **Gate before moving to Step 2:**\cf2 \strokec2  all of 1.1\'961.11 merged individually, \cf6 \strokec6 `test-trove`\cf2 \strokec2  green on \cf6 \strokec6 `main`\cf2 \strokec2 , one full manual smoke pass completed.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \cb3 ---\cb1 \
\
\cb3 ##\cf4 \strokec4  \cf5 \strokec5 Step 2 \'97 Phase 1: add tests for the chokepoints (no behavior changes in this step)\cf2 \cb1 \strokec2 \
\
\cb3 This step is pure test-writing \'97 zero production code changes \'97 specifically so it can't introduce regressions itself, while directly de-risking Steps 3 and 4.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf4 \cb3 \strokec4 1.\cf2 \strokec2  \cf7 \strokec7 **\cf6 \strokec6 `toolsService.ts`\cf7 \strokec7 **\cf2 \strokec2  \'97 write tests for \cf6 \strokec6 `validateParams`\cf2 \strokec2 /\cf6 \strokec6 `callTool`\cf2 \strokec2 /\cf6 \strokec6 `stringOfResult`\cf2 \strokec2  against every 
\f1\i \cf8 \strokec8 *generic*
\f0\i0 \cf2 \strokec2  builtin tool first (read/search/edit/terminal/web-search), independent of the STaaS-specific tools (those get isolated tests in Step 4 right before extraction). Target: every generic tool has at least one happy-path + one malformed-input test.\cb1 \
\cf4 \cb3 \strokec4 2.\cf2 \strokec2  \cf7 \strokec7 **\cf6 \strokec6 `chatThreadService.ts`\cf7 \strokec7 **\cf2 \strokec2  \'97 don't attempt full-class coverage. Target exactly two seams: the tool-call dispatch path (mock a tool call, assert the right \cf6 \strokec6 `toolsService`\cf2 \strokec2  method gets invoked with validated params) and \cf6 \strokec6 `discoverAdditionalReadTools`\cf2 \strokec2 's parallel-read batching (including its silent-catch path from \cf6 \strokec6 `GAP_TRACKING.md`\cf2 \strokec2  \'a72 \'97 assert it degrades gracefully, then fix the silent swallow to at least log, confirming the test still passes).\cb1 \
\cf4 \cb3 \strokec4 3.\cf2 \strokec2  \cf7 \strokec7 **\cf6 \strokec6 `editCodeService.ts`\cf7 \strokec7 **\cf2 \strokec2  \'97 target the SEARCH/REPLACE block application function and checkpoint create/restore. Use small fixed diff fixtures (a handful of representative before/after file pairs) rather than trying to generate exhaustive cases.\cb1 \
\cf4 \cb3 \strokec4 4.\cf2 \strokec2  \cf7 \strokec7 **\cf6 \strokec6 `modelCapabilities.ts`\cf7 \strokec7 **\cf2 \strokec2  \'97 the test file added in Step 1.1\'961.4 already exists; expand it to cover every provider's fallback chain, not just the ones with confirmed bugs, so future additions to this file are caught by the same harness.\cb1 \
\cf4 \cb3 \strokec4 5.\cf2 \strokec2  \cf7 \strokec7 **Repo-intelligence indexers**\cf2 \strokec2  \'97 add test files for \cf6 \strokec6 `npmImpactIndexer.ts`\cf2 \strokec2  and \cf6 \strokec6 `configEnvIndexer.ts`\cf2 \strokec2  first (they carry the hardcoded STaaS defaults that Step 4 is about to touch \'97 get them under test 
\f1\i \cf8 \strokec8 *before*
\f0\i0 \cf2 \strokec2  that refactor, not during it), then \cf6 \strokec6 `universalImportExtractor.ts`\cf2 \strokec2  (lock in the Step 1.6 fix), then the remaining 6 untested indexers as time allows.\cb1 \
\cf4 \cb3 \strokec4 6.\cf2 \strokec2  \cf7 \strokec7 **React UI**\cf2 \strokec2  \'97 before writing component tests, confirm there's a test runner configured for \cf6 \strokec6 `.tsx`\cf2 \strokec2  at all (check for \cf6 \strokec6 `@testing-library/react`\cf2 \strokec2 /\cf6 \strokec6 `vitest`\cf2 \strokec2 /\cf6 \strokec6 `jest`\cf2 \strokec2  config anywhere in the repo's devDependencies and \cf6 \strokec6 `test-browser`\cf2 \strokec2 /\cf6 \strokec6 `test-node`\cf2 \strokec2  scripts) \'97 if none exists, that's a one-time infra setup task (add the runner + one trivial smoke test) that should be its own PR before any real component test is attempted. Once that's in place, write the first real test against \cf6 \strokec6 `util/inputs.tsx`\cf2 \strokec2 's \cf6 \strokec6 `@`\cf2 \strokec2 -mention engine (\cf6 \strokec6 `getOptionsAtPath`\cf2 \strokec2 ), since it's the most complex untested logic in that tree.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf7 \cb3 \strokec7 **Gate before moving to Step 3:**\cf2 \strokec2  Steps 2.1\'962.4 merged (these directly protect the god-objects), \cf6 \strokec6 `test-trove`\cf2 \strokec2  green, no production code changed in this step (verify via \cf6 \strokec6 `git diff --stat main..HEAD`\cf2 \strokec2  showing only \cf6 \strokec6 `*.test.ts`\cf2 \strokec2  files for 2.1-2.5).\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \cb3 ---\cb1 \
\
\cb3 ##\cf4 \strokec4  \cf5 \strokec5 Step 3 \'97 Phase 2: extract STaaS-specific logic (behind a flag)\cf2 \cb1 \strokec2 \
\
\cb3 This is the highest-leverage fix but also the one most likely to break something if done as a single cutover, because the STaaS tool family is currently wired directly into \cf6 \strokec6 `toolsService.ts`\cf2 \strokec2 's dispatch tables and \cf6 \strokec6 `common/`\cf2 \strokec2 's shared type contracts. Do it as a strangler-fig migration, not a rewrite:\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf4 \cb3 \strokec4 1.\cf2 \strokec2  \cf7 \strokec7 **Add the boundary without moving anything yet.**\cf2 \strokec2  Create the extension module (e.g. \cf6 \strokec6 `src/vs/workbench/contrib/trove/extensions/staas/`\cf2 \strokec2 ) with empty/placeholder exports. Add a settings flag (e.g. \cf6 \strokec6 `trove.experimental.orgExtensions`\cf2 \strokec2 ) defaulted to \cf6 \strokec6 `false`\cf2 \strokec2 . This PR changes nothing observable \'97 verify with the manual smoke checklist.\cb1 \
\cf4 \cb3 \strokec4 2.\cf2 \strokec2  \cf7 \strokec7 **Move \cf6 \strokec6 `securityVerifierTool.ts`\cf7 \strokec7  first**\cf2 \strokec2  (smallest, most self-contained, and the one with the actual exposure risk \'97 the literal customer domain list). Move it into the new module, gate its registration in \cf6 \strokec6 `toolsService.ts`\cf2 \strokec2  behind the flag, and fix the live UI-copy leak in \cf6 \strokec6 `repoIntelligenceStatusContribution.ts`\cf2 \strokec2  ("STaaS indexers" \uc0\u8594  generic wording) in the same PR since it's a one-line string change with no logic risk. Verify: with the flag off (default), confirm \cf6 \strokec6 `verify_security_compliance`\cf2 \strokec2  is absent from the tool list exposed to the LLM (this is the regression check \'97 generic users should see zero STaaS surface). With the flag on, confirm it still works exactly as before (this is the non-regression check for existing STaaS users).\cb1 \
\cf4 \cb3 \strokec4 3.\cf2 \strokec2  \cf7 \strokec7 **Move the remaining STaaS tool family**\cf2 \strokec2  (\cf6 \strokec6 `query_service_topology`\cf2 \strokec2 , \cf6 \strokec6 `resolve_api_contract`\cf2 \strokec2 , \cf6 \strokec6 `get_maven_impact`\cf2 \strokec2 , \cf6 \strokec6 `get_npm_impact`\cf2 \strokec2 , \cf6 \strokec6 `get_config_drift`\cf2 \strokec2 ) one tool at a time, each as its own PR, each verified the same way (flag off \uc0\u8594  tool absent and no error; flag on \u8594  identical behavior to pre-move). Use the Step 2.1 generic-tool tests as the regression baseline proving the 
\f1\i \cf8 \strokec8 *surrounding*
\f0\i0 \cf2 \strokec2  dispatcher logic in \cf6 \strokec6 `toolsService.ts`\cf2 \strokec2  wasn't disturbed by removing entries around it.\cb1 \
\cf4 \cb3 \strokec4 4.\cf2 \strokec2  \cf7 \strokec7 **Narrow the shared type contracts last, after the logic has already moved.**\cf2 \strokec2  Once all STaaS tools live in the extension module, split \cf6 \strokec6 `common/toolsServiceTypes.ts`\cf2 \strokec2 's STaaS-specific param/result types and \cf6 \strokec6 `common/repoIntelligenceTypes.ts`\cf2 \strokec2 's STaaS-specific fields/methods out into extension-owned type files that the core interface composes with via intersection types, rather than declaring directly. This is a type-only change (no runtime behavior difference) \'97 verify purely via \cf6 \strokec6 `tsc`\cf2 \strokec2  and \cf6 \strokec6 `test-trove`\cf2 \strokec2 .\cb1 \
\cf4 \cb3 \strokec4 5.\cf2 \strokec2  \cf7 \strokec7 **Make \cf6 \strokec6 `npmImpactIndexer.ts`\cf7 \strokec7 's and \cf6 \strokec6 `configEnvIndexer.ts`\cf7 \strokec7 's hardcoded defaults configurable**\cf2 \strokec2 , defaulting to today's literal STaaS values so behavior is unchanged for existing users, with the Step 2.5 tests as the regression guard. Add a workspace setting to override them.\cb1 \
\cf4 \cb3 \strokec4 6.\cf2 \strokec2  \cf7 \strokec7 **Flip the default flag to \cf6 \strokec6 `true`\cf7 \strokec7  and remove the old unconditional registration path**\cf2 \strokec2  only after the above has run in production (or against the STaaS team's own workspace, if there's a staging environment) for at least one full release cycle with no reported regressions. Delete the flag and the dead old-path code in a final cleanup PR.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf7 \cb3 \strokec7 **Gate before moving to Step 4:**\cf2 \strokec2  flag flipped and confirmed stable, all 5 STaaS tools migrated, \cf6 \strokec6 `repoIntelligenceTypes.ts`\cf2 \strokec2 /\cf6 \strokec6 `toolsServiceTypes.ts`\cf2 \strokec2  no longer contain STaaS-specific members directly.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \cb3 ---\cb1 \
\
\cb3 ##\cf4 \strokec4  \cf5 \strokec5 Step 4 \'97 Phase 3: split the god objects (only after Steps 2 and 3 land)\cf2 \cb1 \strokec2 \
\
\cb3 Order matters here specifically because Step 3 shrinks \cf6 \strokec6 `toolsService.ts`\cf2 \strokec2  by removing the STaaS tool family \'97 splitting it before that would mean re-splitting again afterward.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf4 \cb3 \strokec4 1.\cf2 \strokec2  \cf7 \strokec7 **\cf6 \strokec6 `toolsService.ts`\cf7 \strokec7 **\cf2 \strokec2  (now smaller post-Step 3) \'97 extract the validation, dispatch, and stringification concerns into three focused modules behind the same public interface, using the Step 2.1 tests as the contract that must keep passing unchanged throughout. Land as 2-3 incremental PRs (e.g. extract \cf6 \strokec6 `validateParams`\cf2 \strokec2  first, confirm green, then \cf6 \strokec6 `callTool`\cf2 \strokec2 , then \cf6 \strokec6 `stringOfResult`\cf2 \strokec2 ), not one big move.\cb1 \
\cf4 \cb3 \strokec4 2.\cf2 \strokec2  \cf7 \strokec7 **\cf6 \strokec6 `chatThreadService.ts`\cf7 \strokec7 **\cf2 \strokec2  \'97 extract one responsibility at a time, in this order: parallel-read batching (smallest, already has a Step 2.2 test), then plan tracking, then tool-call dispatch (largest, most central \'97 do last, with the Step 2.2 dispatch test as the safety net), leaving thread/stream state as the remaining core class. Each extraction is its own PR; after each one, run the full manual smoke checklist in addition to \cf6 \strokec6 `test-trove`\cf2 \strokec2 , since this file is the literal center of the agent loop.\cb1 \
\cf4 \cb3 \strokec4 3.\cf2 \strokec2  \cf7 \strokec7 **\cf6 \strokec6 `editCodeService.ts`\cf7 \strokec7 **\cf2 \strokec2  \'97 extract diff computation first (purest function, easiest to test in isolation), then accept/reject-widget orchestration, leaving streaming-apply and checkpoint logic as the core. Use the Step 2.3 fixtures as the regression baseline.\cb1 \
\cf4 \cb3 \strokec4 4.\cf2 \strokec2  \cf7 \strokec7 **React UI splits**\cf2 \strokec2  \'97 only attempt after Step 2.6's test infra exists. \cf6 \strokec6 `SidebarChat.tsx`\cf2 \strokec2 's \cf6 \strokec6 `builtinToolNameToComponent`\cf2 \strokec2  map (extract into one parameterized factory) is the lowest-risk starting point since it's mechanical (13 near-identical wrappers collapsing into one), then \cf6 \strokec6 `Settings.tsx`\cf2 \strokec2 's always-mounted tabs (switch to conditional rendering \'97 verify each tab still renders correctly when first opened, since this changes mount timing for tab-specific subscriptions like \cf6 \strokec6 `RulesTabContent`\cf2 \strokec2 's \cf6 \strokec6 `repoIntel.ensureInitialized()`\cf2 \strokec2 ), then \cf6 \strokec6 `util/inputs.tsx`\cf2 \strokec2 's autocomplete engine extraction last (most complex, do once its dedicated test from Step 2.6 exists).\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf7 \cb3 \strokec7 **Gate before moving to Step 5:**\cf2 \strokec2  each split merged independently with its own green \cf6 \strokec6 `test-trove`\cf2 \strokec2  run and a manual smoke pass; no PR in this step should touch more than one of the four files above.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \cb3 ---\cb1 \
\
\cb3 ##\cf4 \strokec4  \cf5 \strokec5 Step 5 \'97 Phase 4: consolidate duplicated utilities (low risk, can run anytime after Step 1)\cf2 \cb1 \strokec2 \
\
\cb3 Unlike Steps 3-4, these don't depend on each other or on prior steps \'97 they can be parallelized across different engineers, each as an independent PR, anytime after Step 1's bug fixes land (doing them after Step 1 just avoids consolidating a utility that still contains a known bug).\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf4 \cb3 \strokec4 1.\cf2 \strokec2  Directory-walking: write the shared \cf6 \strokec6 `walkDirectory(root, \{ skipDirs, maxDepth, filter \})`\cf2 \strokec2  utility with its own test, then migrate the 9 call sites \cf7 \strokec7 **one indexer at a time**\cf2 \strokec2 , each its own PR, each verified by running that specific indexer's existing test (or the one added in Step 2.5) before and after \'97 this directly fixes the depth-limit inconsistency from \cf6 \strokec6 `GAP_TRACKING.md`\cf2 \strokec2  \'a74 one indexer at a time rather than as one risky mass find-and-replace.\cb1 \
\cf4 \cb3 \strokec4 2.\cf2 \strokec2  DB transactions: add \cf6 \strokec6 `withTransaction(db, fn)`\cf2 \strokec2  with a test against a throwing callback (assert rollback leaves no partial rows), then wrap each of the 13 bulk-replace methods one at a time, verifying with that method's existing data against a real SQLite file before/after each migration.\cb1 \
\cf4 \cb3 \strokec4 3.\cf2 \strokec2  Localhost-URL extraction, context-window trimming, streaming-tail preview, agent-hint scaffolding, \cf6 \strokec6 `extensionTransferService.ts`\cf2 \strokec2 's path triplication: each is a self-contained extract-and-replace; for each, write a test pinning current output for both call sites' typical inputs 
\f1\i \cf8 \strokec8 *before*
\f0\i0 \cf2 \strokec2  unifying, so the unification can't silently change either site's behavior.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \cb3 ---\cb1 \
\
\cb3 ##\cf4 \strokec4  \cf5 \strokec5 Step 6 \'97 Phase 5: resource/async hardening (electron-main, independent track)\cf2 \cb1 \strokec2 \
\
\cb3 Can run in parallel with Steps 3-5 since it's scoped to I/O internals, not public interfaces.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf4 \cb3 \strokec4 1.\cf2 \strokec2  Convert sync \cf6 \strokec6 `fs`\cf2 \strokec2  calls to async in \cf6 \strokec6 `codeChunker.ts`\cf2 \strokec2  and \cf6 \strokec6 `workspaceScanner.ts`\cf2 \strokec2  first (most-called paths), one function at a time, verifying with the existing \cf6 \strokec6 `codeChunker.test.ts`\cf2 \strokec2  plus a manual full-repo re-index on a real large workspace (time it before/after \'97 this is a perf-sensitive change, not just a correctness one).\cb1 \
\cf4 \cb3 \strokec4 2.\cf2 \strokec2  Bound \cf6 \strokec6 `searchChunksHybrid`\cf2 \strokec2 's embedding scan \'97 add the LIMIT/pre-filter, verify search result quality is unchanged on a known query set (manually curate 5-10 representative queries against a test workspace and confirm top results don't change) before merging.\cb1 \
\cf4 \cb3 \strokec4 3.\cf2 \strokec2  Cap \cf6 \strokec6 `fileWatcher.ts`\cf2 \strokec2 's watcher count and add \cf6 \strokec6 `appendToUserMemory`\cf2 \strokec2 's size rotation \'97 both additive/defensive changes, low regression risk, verify with a workspace that has a deep directory tree.\cb1 \
\cf4 \cb3 \strokec4 4.\cf2 \strokec2  Convert \cf6 \strokec6 `universalGraphAnalyzer.ts`\cf2 \strokec2 's recursive Tarjan SCC to iterative \'97 this one specifically needs a test with a large synthetic graph (deeper than the recursion limit) added 
\f1\i \cf8 \strokec8 *before*
\f0\i0 \cf2 \strokec2  the conversion, so you can confirm the recursive version actually fails on it and the iterative version doesn't, rather than just trusting the conversion is correct.\cb1 \
\cf4 \cb3 \strokec4 5.\cf2 \strokec2  Implement the \cf6 \strokec6 `maxDepth`\cf2 \strokec2  field in \cf6 \strokec6 `computeMetrics`\cf2 \strokec2  \'97 additive, no existing behavior to break.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \cb3 ---\cb1 \
\
\cb3 ##\cf4 \strokec4  \cf5 \strokec5 Step 7 \'97 Phase 6: common/ process-boundary cleanup (lowest urgency, do last)\cf2 \cb1 \strokec2 \
\
\cb3 No active bug or exposure risk here, so this is the right place to absorb schedule slack rather than something to rush.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf4 \cb3 \strokec4 1.\cf2 \strokec2  Fix the \cf6 \strokec6 `troveSettingsTypes.ts`\cf2 \strokec2  \uc0\u8596  \cf6 \strokec6 `troveSettingsService.ts`\cf2 \strokec2  circular import by moving \cf6 \strokec6 `TroveSettingsState`\cf2 \strokec2 's definition into the types file and having the service import from it (reverse of today). Verify with \cf6 \strokec6 `tsc`\cf2 \strokec2  plus the full settings-related test suite.\cb1 \
\cf4 \cb3 \strokec4 2.\cf2 \strokec2  Add lightweight runtime shape validation to \cf6 \strokec6 `troveSettingsService.ts`\cf2 \strokec2 's \cf6 \strokec6 `_readState()`\cf2 \strokec2  \'97 this is also the structural fix that would have caught Step 1.5's default-drift bug automatically; add a test that loads a deliberately-malformed stored blob and confirms it's rejected/patched rather than silently passed through.\cb1 \
\cf4 \cb3 \strokec4 3.\cf2 \strokec2  Relocate \cf6 \strokec6 `mcpService.ts`\cf2 \strokec2 's and \cf6 \strokec6 `metricsService.ts`\cf2 \strokec2 's browser-layer responsibilities into \cf6 \strokec6 `browser/`\cf2 \strokec2  \'97 mechanical move, verify via \cf6 \strokec6 `tsc`\cf2 \strokec2  (import paths) plus manual: open MCP settings and trigger the \cf6 \strokec6 `troveDebugInfo`\cf2 \strokec2  command once each.\cb1 \
\
\pard\pardeftab720\partightenfactor0
\cf2 \cb3 ---\cb1 \
\
\cb3 ##\cf4 \strokec4  \cf5 \strokec5 Sequencing summary\cf2 \cb1 \strokec2 \
\
\cb3 ```\cb1 \
\cb3 Step 1  Bug fixes (isolated PRs)              \uc0\u9472 \u9488 \cb1 \
\cb3 Step 5  Duplicate consolidation (parallel)     \uc0\u9472 \u9508   can start once Step 1 lands\cb1 \
\cb3 Step 6  Resource hardening (parallel)          \uc0\u9472 \u9496   independent track throughout\cb1 \
\cb3 Step 2  Tests for chokepoints (no prod change) \uc0\u9472 \u9472 \u8594  unblocks Step 4\cb1 \
\cb3 Step 3  STaaS extraction (flagged rollout)     \uc0\u9472 \u9472 \u8594  unblocks Step 4 (shrinks toolsService first)\cb1 \
\cb3 Step 4  God-object splits (after 2 and 3)\cb1 \
\cb3 Step 7  common/ boundary cleanup (do last, lowest urgency)\cb1 \
\cb3 ```\cb1 \
\
\cb3 Every step ends with \cf6 \strokec6 `npm run compile && npm run test-trove`\cf2 \strokec2  green on the PR branch before merge, and the \'a70.4 manual smoke checklist for anything touching \cf6 \strokec6 `chatThreadService.ts`\cf2 \strokec2 , \cf6 \strokec6 `editCodeService.ts`\cf2 \strokec2 , \cf6 \strokec6 `toolsService.ts`\cf2 \strokec2 , or \cf6 \strokec6 `browser/react/`\cf2 \strokec2 .\cb1 \
\
}