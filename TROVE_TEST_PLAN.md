# Trove — Sidebar-Driven Test Plan
**63 test cases across 9 implementation phases**  
All tests executed from the Trove sidebar chat window (Ctrl+L).

---

## How to Use This Plan

- **Mode** refers to the dropdown at the bottom of the sidebar: Chat | Gather | Agent
- **Auto-approve edits** can be toggled via the toggle that appears on file-edit approval prompts
- **Preconditions** must be satisfied before sending the exact prompt
- **Pass criteria** are observable directly in the sidebar or editor without external tooling

---

## Phase 1 — ContextGathering + @ File Picker

### P1-T01 — Nearby code injected without file read (Happy path)
**Mode:** Chat  
**Precondition:** Open any `.ts` file. Position cursor inside a function body (no edit required — cursor move updates context cache).  
**Prompt:**
```
Describe the function I have my cursor in right now. Do NOT call any tools — use only what you can already see in your context.
```
**Expected:** Agent describes the correct function from injected snippets. No `read_file` tool card appears in the sidebar.  
**Pass criteria:**
- ✓ Accurate function description appears in sidebar
- ✓ Zero `read_file` tool cards visible
- ✓ Response does not say "I don't have access to your file"

---

### P1-T02 — Parent symbol context captured (Happy path)
**Mode:** Chat  
**Precondition:** Open a class file. Click somewhere inside a method (cursor move updates cache; no edit required).  
**Prompt:**
```
What class and method is my cursor currently inside? Answer from context without using any tools.
```
**Expected:** Correct class and method names stated without a tool call.  
**Pass criteria:**
- ✓ Class name is correct
- ✓ Method name is correct
- ✓ No tool card appears

---

### P1-T03 — @ trigger opens file picker (Happy path)
**Mode:** Agent  
**Precondition:** Phase 1 implemented. At least 3 `.ts` files in workspace.  
**Action:** Type the `@` character in the sidebar input and pause.  
**Expected:** A dropdown file picker appears beneath the input listing workspace files. Typing after `@` filters the list.  
**Pass criteria:**
- ✓ Dropdown visible immediately after `@`
- ✓ List updates as more characters are typed
- ✓ Arrow keys or click selects a file

---

### P1-T04 — @ staged file skips read_file (Happy path)
**Mode:** Gather  
**Precondition:** Have a `utils.ts` file in workspace.  
**Prompt:**
```
@utils.ts What functions does this file export? List them all.
```
**Expected:** Agent lists the exports WITHOUT calling `read_file`. File injected via staging.  
**Pass criteria:**
- ✓ Correct exports listed
- ✓ No `read_file` tool card in sidebar
- ✓ utils.ts shown as an inline @ chip in the composer

---

### P1-T05 — Multiple @ mentions all in context (Happy path)
**Mode:** Gather  
**Precondition:** Have `fileA.ts` and `fileB.ts` in workspace.  
**Prompt:**
```
@fileA.ts @fileB.ts What are the main differences between these two files? Summarize without reading any files.
```
**Expected:** Both files available. Comparison answer without tool calls.  
**Pass criteria:**
- ✓ Both files referenced in response
- ✓ No `read_file` calls
- ✓ Both chips visible as inline pills in the composer

---

### P1-T06 — @ non-existent file handled gracefully (Negative)
**Mode:** Gather  
**Precondition:** None.  
**Prompt:**
```
@nonExistentFile.ts Summarize this file.
```
**Expected:** Sidebar shows a clear "File not found" error via the error banner. App does not crash. Message is not sent to the LLM.  
**Pass criteria:**
- ✓ Error message is user-friendly
- ✓ App remains stable
- ✓ Other functionality still works after error

---

### P1-T07 — Snippet limits do not expose full large file (Edge case)
**Mode:** Chat  
**Precondition:** Open a file with 1000+ lines of code.  
**Prompt:**
```
What is inside my current file? Describe everything you can see in your context.
```
**Expected:** Agent describes a partial snippet (nearby code only). Should acknowledge it can only see nearby context.  
**Pass criteria:**
- ✓ Response is not the full 1000-line file content
- ✓ Agent doesn't claim to see the full file
- ✓ Described section matches where cursor is placed

---

## Phase 2 — .troverules Project Rules File

### P2-T01 — Coding style rule applied (Happy path)
**Mode:** Agent  
**Precondition:** Create `.troverules` at workspace root with content:  
`Always add a JSDoc comment to every function you create.`  
**Prompt:**
```
Create a new file called date-helpers.ts with a function called formatDate that takes a Date and returns it formatted as YYYY-MM-DD.
```
**Expected:** File created. `formatDate` function has a JSDoc comment above it.  
**Pass criteria:**
- ✓ `date-helpers.ts` created
- ✓ `/** ... */` JSDoc present on `formatDate`
- ✓ Rule not explicitly mentioned in the prompt

---

### P2-T02 — Language style rule applied (Happy path)
**Mode:** Agent  
**Precondition:** `.troverules`: `All async code must use async/await syntax. Never use .then() chains.`  
**Prompt:**
```
Write a function called fetchUserData that retrieves a user by ID from /api/users/:id and returns the parsed JSON.
```
**Expected:** Code uses `async/await`. No `.then()` in response.  
**Pass criteria:**
- ✓ `async` keyword on function
- ✓ `await` used for fetch call
- ✓ No `.then()` present

---

### P2-T03 — Multiple rules all respected (Happy path)
**Mode:** Agent  
**Precondition:** `.troverules`:
```
1. Add error handling to all API calls.
2. Log errors using console.error, not console.log.
```
**Prompt:**
```
Create a function called createPost that POSTs data to /api/posts and returns the created post.
```
**Expected:** Function has `try/catch`. Catch block uses `console.error()`.  
**Pass criteria:**
- ✓ `try/catch` present
- ✓ `console.error` in catch block
- ✓ No `console.log` used for errors

---

### P2-T04 — Missing .troverules does not crash (Negative)
**Mode:** Agent  
**Precondition:** Ensure no `.troverules` file exists in workspace.  
**Prompt:**
```
Write a simple multiply(a, b) function that returns a * b.
```
**Expected:** Agent works normally. No error about missing rules file.  
**Pass criteria:**
- ✓ Function generated correctly
- ✓ No error message about `.troverules`
- ✓ Sidebar shows normal response

---

### P2-T05 — Malformed .troverules does not crash (Negative)
**Mode:** Agent  
**Precondition:** Create `.troverules` with content: `!!!@@@###$$$%%%`  
**Prompt:**
```
Write a hello world function.
```
**Expected:** Agent works normally. Malformed rules either ignored or parsed gracefully.  
**Pass criteria:**
- ✓ Function generated
- ✓ No crash or error in sidebar
- ✓ App remains stable

---

### P2-T06 — Explicit user instruction overrides rules (Edge case)
**Mode:** Agent  
**Precondition:** `.troverules`: `Always write code in TypeScript with strict types.`  
**Prompt:**
```
Write a hello world function in plain JavaScript with no types.
```
**Expected:** Agent writes plain JavaScript as explicitly requested. User instruction takes priority.  
**Pass criteria:**
- ✓ Output is JavaScript not TypeScript
- ✓ No type annotations present
- ✓ Agent may mention the rule was overridden

---

## Phase 3 — Semantic Search (search_codebase tool)

### P3-T01 — search_codebase tool card appears in sidebar (Happy path)
**Mode:** Gather  
**Precondition:** Phase 3 implemented. Non-trivial codebase open.  
**Prompt:**
```
Find all the places where error handling or try/catch blocks are used in this codebase.
```
**Expected:** A `search_codebase` tool card appears in the sidebar. Results list file paths and line ranges.  
**Pass criteria:**
- ✓ `search_codebase` tool card visible
- ✓ Card shows the query string used
- ✓ Results include file paths and line numbers
- ✓ At least one result is accurate

---

### P3-T02 — Natural language query finds relevant code (Happy path)
**Mode:** Gather  
**Precondition:** None.  
**Prompt:**
```
Using the codebase search tool, find the code responsible for managing conversation thread state.
```
**Expected:** Returns `chatThreadService.ts` or equivalent. Agent reads that file and explains it.  
**Pass criteria:**
- ✓ Correct file found (`chatThreadService.ts`)
- ✓ Relevant section identified
- ✓ Explanation matches actual code

---

### P3-T03 — Semantic match without exact keyword (Happy path)
**Mode:** Gather  
**Precondition:** None.  
**Prompt:**
```
Search the codebase for code related to 'user login' or 'authentication flows' even if those exact words are not in the code.
```
**Expected:** Returns semantically related results — token validation, session management, IPC auth patterns — without literal "login" keyword.  
**Pass criteria:**
- ✓ Results returned without literal keyword match
- ✓ Returned files are actually related to auth/sessions
- ✓ No crash on abstract query

---

### P3-T04 — Empty result handled gracefully (Negative)
**Mode:** Gather  
**Precondition:** None.  
**Prompt:**
```
Search the codebase for 'quantum entanglement simulation algorithms'.
```
**Expected:** `search_codebase` returns empty results. Agent clearly communicates no matching code found.  
**Pass criteria:**
- ✓ Empty result message is clear and friendly
- ✓ No crash
- ✓ Agent does not hallucinate results

---

### P3-T05 — Search feeds into targeted read (Happy path)
**Mode:** Gather  
**Precondition:** None.  
**Prompt:**
```
Find where the IPC channel is registered in this codebase, then show me that exact section of code.
```
**Expected:** `search_codebase` called first, then `read_file` with specific line range. Both tool cards visible.  
**Pass criteria:**
- ✓ `search_codebase` tool card appears first
- ✓ `read_file` tool card follows with specific line range
- ✓ Shown code is the actual registration point

---

### P3-T06 — Search then act: create output file (Happy path)
**Mode:** Agent (auto-approve edits ON)  
**Precondition:** None.  
**Prompt:**
```
Find all TODO comments in this codebase and create a file called TODO_TRACKER.md that lists them organised by file.
```
**Expected:** `search_codebase` called, results processed, then `create_file_or_folder` creates `TODO_TRACKER.md`.  
**Pass criteria:**
- ✓ `search_codebase` tool card appears
- ✓ `TODO_TRACKER.md` created
- ✓ File content matches actual TODOs found

---

## Phase 4 — Codebase-Aware Autocomplete

### P4-T01 — Cross-file symbol completion (Happy path)
**Mode:** Chat (autocomplete is editor-level)  
**Precondition:** Phase 4 implemented. File A exports `function formatCurrency(amount: number): string`. Open a different file B.  
**Action:** In file B, type `import { formatCurrency } from './fileA';` then on the next line type `formatC` and wait for autocomplete.  
**Expected:** Autocomplete suggests `formatCurrency` with its full signature `(amount: number): string`.  
**Pass criteria:**
- ✓ Correct function name suggested
- ✓ Parameter type (`number`) shown
- ✓ Return type (`string`) shown

---

### P4-T02 — Pattern continuation from codebase (Happy path)
**Mode:** Chat  
**Precondition:** Codebase has many classes extending `Disposable`. Open a new `.ts` file.  
**Action:** Type `export class MyService extends ` and wait for autocomplete.  
**Expected:** Autocomplete suggests `Disposable` as a top option, inferred from the codebase pattern.  
**Pass criteria:**
- ✓ `Disposable` appears in suggestions
- ✓ Ranked higher than generic suggestions

---

### P4-T03 — No crash on empty file (Negative)
**Mode:** Chat  
**Precondition:** Open a brand new empty `.ts` file.  
**Action:** Type `const x = ` and wait for autocomplete.  
**Expected:** Autocomplete either suggests generic completions or nothing. Sidebar shows no error.  
**Pass criteria:**
- ✓ No error or crash
- ✓ Sidebar is unaffected
- ✓ Editor remains functional

---

## Phase 5 — Parallel Read Tool Batching

### P5-T01 — Multiple reads appear as a batch cluster (Happy path)
**Mode:** Gather  
**Precondition:** Phase 5 implemented. 3 separate files: `serviceA.ts`, `serviceB.ts`, `serviceC.ts`.  
**Prompt:**
```
Read the contents of serviceA.ts, serviceB.ts, and serviceC.ts and explain what each one is responsible for.
```
**Expected:** All three `read_file` tool cards appear close together in time — not one-by-one with large gaps. All file descriptions are accurate.  
**Pass criteria:**
- ✓ All 3 `read_file` cards appear
- ✓ Cards appear in a tight cluster, not sequentially
- ✓ All file descriptions are accurate

---

### P5-T02 — Parallel results correctly attributed (Edge case)
**Mode:** Gather  
**Precondition:** Have `configService.ts` and `settingsService.ts`.  
**Prompt:**
```
Read the first 20 lines of configService.ts and the last 20 lines of settingsService.ts. Tell me what the beginning of the first and end of the second contain.
```
**Expected:** Despite parallel execution, results correctly attributed to each file.  
**Pass criteria:**
- ✓ `configService.ts` first 20 lines described correctly
- ✓ `settingsService.ts` last 20 lines described correctly
- ✓ No mix-up between files

---

### P5-T03 — Destructive tools still run sequentially (Happy path)
**Mode:** Agent (auto-approve edits ON)  
**Precondition:** None.  
**Prompt:**
```
Create a file called step1.ts with 'export const step = 1'. Then create step2.ts with 'export const step = 2'. Then create step3.ts that imports and re-exports both.
```
**Expected:** Files created ONE AT A TIME in order. `step3.ts` imports correctly reference already-created step1 and step2.  
**Pass criteria:**
- ✓ Files created in sequence (step1 → step2 → step3)
- ✓ `step3.ts` imports are correct
- ✓ No parallel batching of `create_file` calls

---

## Phase 6 — Smart Context Window Trimming

### P6-T01 — Trimming indicator appears after long chat (Happy path)
**Mode:** Agent  
**Precondition:** Phase 6 implemented. Send 35+ message pairs about various unrelated topics.  
**Prompt:** Any new question after the long conversation.  
**Expected:** A visible indicator appears in the sidebar: "Older context was trimmed to fit the model's window" or similar.  
**Pass criteria:**
- ✓ Trimming indicator is visible in sidebar
- ✓ Indicator appears before or during the response
- ✓ Response still arrives normally

---

### P6-T02 — Recent context preserved after trimming (Happy path)
**Mode:** Chat  
**Precondition:** After P6-T01 trimming indicator has appeared.  
**Prompt:**
```
What was my last message before this one?
```
**Expected:** Agent correctly recalls the immediately preceding message.  
**Pass criteria:**
- ✓ Last message recalled accurately
- ✓ No hallucination about recent content
- ✓ Response is confident, not uncertain

---

### P6-T03 — Very old context acknowledged as lost (Happy path)
**Mode:** Chat  
**Precondition:** After trimming indicator has appeared.  
**Prompt:**
```
What was the very first question I asked you in this conversation?
```
**Expected:** Agent says it doesn't have access to the earliest messages. Does NOT hallucinate an answer.  
**Pass criteria:**
- ✓ Agent says oldest context was trimmed
- ✓ Does NOT hallucinate a first question
- ✓ Offers to help in another way if needed

---

### P6-T04 — System message preserved — tools still available (Edge case)
**Mode:** Agent  
**Precondition:** After trimming has occurred.  
**Prompt:**
```
List the files in the current directory.
```
**Expected:** Agent uses `ls_dir` or similar tool normally. System message was not trimmed.  
**Pass criteria:**
- ✓ Tool card appears (`ls_dir` or `get_dir_tree`)
- ✓ Agent does not say "I don't have tool access"
- ✓ Result is a real directory listing

---

## Phase 7 — Structured Plan View

### P7-T01 — Plan checklist appears before tool calls (Happy path)
**Mode:** Agent  
**Precondition:** Phase 7 implemented.  
**Prompt:**
```
Add a loading spinner component to the sidebar that appears while the agent is processing. Create the spinner as a new React component file and add it to Sidebar.tsx.
```
**Expected:** A plan checklist appears BEFORE any tool cards. Items list tasks such as "Read Sidebar.tsx", "Create Spinner component", "Wire into Sidebar.tsx".  
**Pass criteria:**
- ✓ Plan message appears first in the response
- ✓ Plan contains 3+ specific action items
- ✓ First `read_file` card appears AFTER the plan
- ✓ Items are accurate to the actual task

---

### P7-T02 — Plan items tick off as tools complete (Happy path)
**Mode:** Agent  
**Precondition:** Same task as P7-T01. Observe during execution.  
**Prompt:** Same as P7-T01.  
**Expected:** As each tool call completes, the corresponding plan item updates to ✓ or "done" state in real time.  
**Pass criteria:**
- ✓ Items change state from pending to done during execution
- ✓ Updates happen per-tool, not all at once at the end
- ✓ Final plan shows all items completed

---

### P7-T03 — Simple task gets minimal or no plan (Edge case)
**Mode:** Chat  
**Precondition:** None.  
**Prompt:**
```
What is the difference between == and === in JavaScript?
```
**Expected:** Agent answers directly. No planning step for a simple knowledge question.  
**Pass criteria:**
- ✓ No verbose plan generated
- ✓ Response is immediate and direct
- ✓ If a plan appears, it is a single item taking <1 second

---

### P7-T04 — Interrupted plan — completed items stay ticked (Happy path)
**Mode:** Agent (auto-approve edits OFF)  
**Precondition:** None.  
**Prompt:**
```
Rename every exported function in utils.ts to have a 'util_' prefix and update all imports across the codebase.
```
**Action:** When first `edit_file` approval prompt appears, click Reject/Cancel.  
**Expected:** Plan visible before execution. After cancellation, already-completed items (read steps) remain ticked. Future items stay pending.  
**Pass criteria:**
- ✓ Plan visible before execution starts
- ✓ Completed items remain ✓ after cancellation
- ✓ Future items show as pending/skipped
- ✓ Agent stops cleanly with no crash

---

### P7-T05 — Plan content is accurate and specific (Happy path)
**Mode:** Agent  
**Precondition:** None.  
**Prompt:**
```
Create a new ThemeService class that reads a .theme file from the workspace root, parses it as JSON, and emits a theme change event when the file is modified.
```
**Expected:** Plan items are specific — referencing file names or service names — not generic filler like "Step 1: Do things".  
**Pass criteria:**
- ✓ At least 4 plan items
- ✓ Items specifically mention file names or service names
- ✓ Plan matches what the agent actually does

---

## Phase 8 — Multi-File Diff Review Panel

### P8-T01 — Multi-file panel appears after bulk edits (Happy path)
**Mode:** Agent (auto-approve edits ON)  
**Precondition:** Phase 8 implemented. Have a `utils/` folder with 3+ `.ts` files.  
**Prompt:**
```
Add a comment // @reviewed at the very top of every .ts file in the utils folder.
```
**Expected:** After agent completes, sidebar shows "Accept all N changes" and "Reject all" buttons. N matches number of files modified.  
**Pass criteria:**
- ✓ Accept all / Reject all buttons visible
- ✓ N equals the number of edited files
- ✓ Each changed file has a pending diff in the editor

---

### P8-T02 — Accept all applies all changes (Happy path)
**Mode:** Agent  
**Precondition:** After P8-T01 — pending diffs visible.  
**Action:** Click "Accept all N changes" button.  
**Expected:** All pending diffs accepted. Editors show no diff highlighting. `// @reviewed` visible at top of every utils/ file.  
**Pass criteria:**
- ✓ All diff highlights removed from editors
- ✓ All files show the added comment
- ✓ Button disappears after accepting
- ✓ Git status shows N modified files

---

### P8-T03 — Reject all reverts all changes (Happy path)
**Mode:** Agent  
**Precondition:** Repeat P8-T01. Pending diffs visible again.  
**Action:** Click "Reject all" button.  
**Expected:** All pending diffs rejected. Files revert to original state. `// @reviewed` NOT present.  
**Pass criteria:**
- ✓ All diff highlights removed
- ✓ Files match original content
- ✓ Git status shows no modified files

---

### P8-T04 — Single file edit does NOT show multi-file panel (Negative)
**Mode:** Agent (auto-approve edits ON)  
**Precondition:** None.  
**Prompt:**
```
Add a single comment // tested to the top of chatThreadService.ts only.
```
**Expected:** Normal diff view in editor. NO multi-file Accept all / Reject all panel in sidebar.  
**Pass criteria:**
- ✓ No multi-file panel in sidebar
- ✓ Normal inline diff visible in editor
- ✓ Standard Accept / Reject controls in editor work normally

---

### P8-T05 — Manual accept before Reject all (Edge case)
**Mode:** Agent  
**Precondition:** After P8-T01 — 3 files with pending diffs.  
**Action:** Manually accept the diff in file 1 via editor controls, then click "Reject all" in the sidebar.  
**Expected:** File 1 (manually accepted) keeps changes. Files 2 and 3 are reverted.  
**Pass criteria:**
- ✓ File 1 (manually accepted) retains changes
- ✓ Files 2 and 3 are reverted
- ✓ No double-apply or inconsistent state

---

## Phase 9 — Persistent Memory File

### P9-T01 — Remember command saves to memory (Happy path)
**Mode:** Chat  
**Precondition:** Phase 9 implemented.  
**Prompt:**
```
Please remember that this project uses PostgreSQL version 15 as its primary database.
```
**Expected:** Agent confirms memory saved. `~/.trove/memory.md` updated with the fact.  
**Pass criteria:**
- ✓ Confirmation message visible in sidebar
- ✓ `~/.trove/memory.md` exists and contains PostgreSQL fact
- ✓ Memory saved without user opening any files

---

### P9-T02 — Memory recalled in same session (Happy path)
**Mode:** Chat  
**Precondition:** After P9-T01.  
**Prompt:**
```
What database does this project use?
```
**Expected:** Agent answers "PostgreSQL version 15" from memory without reading any project files.  
**Pass criteria:**
- ✓ Correct answer given
- ✓ No `read_file` or `search` calls made
- ✓ Agent attributes answer to what it was told to remember

---

### P9-T03 — Memory persists after IDE restart (Happy path)
**Mode:** Chat  
**Precondition:** After P9-T01. Fully close and reopen the IDE.  
**Prompt:**
```
What do you remember about this project's database?
```
**Expected:** Agent recalls PostgreSQL version 15 even after restart.  
**Pass criteria:**
- ✓ Correct fact recalled after restart
- ✓ New session, no prior conversation history
- ✓ Memory file was read on startup

---

### P9-T04 — Multiple memories accumulate (Happy path)
**Mode:** Chat  
**Precondition:** After P9-T01.  
**Prompt:**
```
Also remember that the API uses Express.js version 4 and runs on port 3000.
```
Then immediately after:
```
Summarize everything you remember about this project's technical stack.
```
**Expected:** Both PostgreSQL and Express.js facts recalled in the summary.  
**Pass criteria:**
- ✓ Both entries confirmed
- ✓ `~/.trove/memory.md` contains both facts
- ✓ Summary correctly references both

---

### P9-T05 — Memory influences agent code generation (Happy path)
**Mode:** Agent  
**Precondition:** After P9-T01 (PostgreSQL remembered).  
**Prompt:**
```
Set up a database connection for this project. Create a db.ts file.
```
**Expected:** Agent generates PostgreSQL connection code using `pg` or `postgres` library, not MySQL or SQLite.  
**Pass criteria:**
- ✓ `db.ts` uses a PostgreSQL client library
- ✓ No MySQL or SQLite in generated code
- ✓ Agent may cite the remembered fact in its explanation

---

### P9-T06 — No memory file on fresh install (Negative)
**Mode:** Chat  
**Precondition:** Fresh IDE install. No `~/.trove/memory.md` exists.  
**Prompt:**
```
What do you remember about this project?
```
**Expected:** Agent says it has no stored memories. Does not crash.  
**Pass criteria:**
- ✓ Friendly "no memories yet" message
- ✓ No file-not-found error shown to user
- ✓ Sidebar shows normal response

---

## Summary Table

| Phase | Tests | Happy | Negative | Edge |
|---|---|---|---|---|
| P1 — ContextGathering + @ picker | 7 | 5 | 1 | 1 |
| P2 — .troverules | 6 | 4 | 2 | 1 (counted happy) |
| P3 — Semantic search | 6 | 5 | 1 | 0 |
| P4 — Codebase autocomplete | 3 | 2 | 1 | 0 |
| P5 — Parallel batching | 3 | 2 | 0 | 1 |
| P6 — Context trimming | 4 | 3 | 0 | 1 |
| P7 — Plan view | 5 | 4 | 0 | 1 |
| P8 — Multi-file diff panel | 5 | 4 | 1 | 1 |
| P9 — Persistent memory | 6 | 5 | 1 | 0 |
| **Total** | **45** | **34** | **7** | **6** |

> Note: The HTML interactive version contains 63 tests (additional sub-cases per test), this markdown covers the primary test cases.
