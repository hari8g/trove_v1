# Trove v1 — Token Optimisation & Knowledge Graph
## Implementation Plan from Live Codebase Analysis

**Repo:** `hari8g/trove_v1` · **Cloned & read:** 2026-06-19  
**Files analysed:** `sendLLMMessage.impl.ts` (1096L) · `convertToLLMMessageService.ts` (839L) · `prompts.ts` (1334L) · `repoIntelligenceDb.ts` (329L) · `codeChunker.ts` (179L) · `fileReadDedup.ts` (121L) + 15 supporting files

---

## Part A — Token Optimisation

### A.0 What Is Already Working (Do Not Touch)

| File | What it does |
|------|-------------|
| `toolResultCompaction.ts` | Keeps 2 recent tool results full, compacts stale ones ✅ |
| `wireMessageTrim.ts` | Drops oldest tool bodies first at wire level ✅ |
| `contextWindowTrim.ts` | Drops oldest messages to fit context window ✅ |
| `llmPricing.ts` | Full pricing table with cacheRead/cacheWrite ✅ |
| `usageMeteringService.ts` | Tracks totalCacheReadTokens ✅ |
| `fileReadDedup.ts` | Tracks read ranges per file ✅ (but skip logic is wrong — see A.5) |
| `agentOutputTokenLimits.ts` | 32k output for agent mode, combined beta headers ✅ |

---

### A.1 Bug: Volatile Content in Cached System Block

**The core problem.** `convertToLLMMessageService.ts` line 613 assembles the full system message:

```typescript
const systemMessage = chat_systemMessage({
    workspaceFolders,
    openedURIs,      // ← changes every file switch
    directoryStr,    // ← changes when files are created/deleted
    activeURI,       // ← changes every file switch
    persistentTerminalIDs,
    chatMode, mcpTools, includeXMLToolDefinitions,
    repoProfile,     // ← stable (changes only on rescan)
    workspaceRules,  // ← stable (changes only when .troverules edited)
    userMemory,      // ← stable (rarely changes)
    repoProfileMode,
})
```

Then `sendLLMMessage.impl.ts` line 560–561 wraps the **entire string** in one cache block:

```typescript
system: separateSystemMessage
    ? (enablePromptCache
        ? [{ type: 'text', text: separateSystemMessage, cache_control: { type: 'ephemeral' } }]
        : separateSystemMessage)
    : undefined,
```

Every time the user switches a file, `openedURIs` or `activeURI` changes → the entire
system message changes → Anthropic computes a cache miss → you pay full input price for
4,000+ tokens on every turn.

#### Fix A.1a — Split `chat_systemMessage` in `prompts.ts`

**File:** `src/vs/workbench/contrib/trove/common/prompt/prompts.ts`

Locate the `chat_systemMessage` function (line 618) and refactor it to expose two
separate exports while keeping the original as a compatibility wrapper:

```typescript
// ADD — stable portion (content that changes at most once per session)
export const chat_systemMessage_stable = (opts: {
    workspaceFolders: string[];
    chatMode: ChatMode;
    mcpTools: InternalToolInfo[] | undefined;
    includeXMLToolDefinitions: boolean;
    repoProfile?: WorkspaceProfile | null;
    workspaceRules?: string | null;
    userMemory?: string | null;
    repoProfileMode?: ChatMode;
}): string => {
    // Move everything from chat_systemMessage EXCEPT:
    //   openedURIs, directoryStr, activeURI, persistentTerminalIDs
    // Keep: OS info, mode rules, tool definitions, repo profile,
    //       workspace rules block, user memory block
    // ...
};

// ADD — volatile portion (content that changes turn-to-turn)
export const chat_systemMessage_volatile = (opts: {
    openedURIs: string[];
    directoryStr: string;
    activeURI: string | undefined;
    persistentTerminalIDs: string[];
}): string => {
    const parts: string[] = [];
    if (opts.activeURI) {
        parts.push(`Active file: ${opts.activeURI}`);
    }
    if (opts.openedURIs.length > 0) {
        parts.push(`Open files:\n${opts.openedURIs.join('\n') || 'NO OPENED FILES'}`);
    }
    if (opts.persistentTerminalIDs.length > 0) {
        parts.push(`Active terminals: ${opts.persistentTerminalIDs.join(', ')}`);
    }
    if (opts.directoryStr) {
        parts.push(opts.directoryStr);
    }
    return parts.filter(Boolean).join('\n\n');
};

// KEEP — existing function, now delegates (backward-compatible)
export const chat_systemMessage = (opts: { /* existing params */ }): string => {
    return [
        chat_systemMessage_stable(opts),
        chat_systemMessage_volatile(opts),
    ].filter(Boolean).join('\n\n');
};
```

#### Fix A.1b — Thread two blocks through the pipeline

**File:** `src/vs/workbench/contrib/trove/common/sendLLMMessageTypes.ts`

```typescript
// ADD to SendLLMMessageParams:
volatileSystemMessage?: string;   // workspace state (openedURIs, activeURI, dirTree)
                                   // NOT cached — changes every turn
```

**File:** `src/vs/workbench/contrib/trove/browser/convertToLLMMessageService.ts`

In `buildRunContext` and `prepareLLMChatMessages`, pass two strings instead of one:

```typescript
// CHANGE buildRunContext return type from Promise<string> to:
buildRunContext: (opts: { chatMode: ChatMode, modelSelection: ModelSelection | null })
    => Promise<{ stableBlock: string; volatileBlock: string }>

// CHANGE the assembly at line ~613:
const stableBlock   = chat_systemMessage_stable({ workspaceFolders, chatMode, mcpTools,
                          includeXMLToolDefinitions, repoProfile, workspaceRules,
                          userMemory, repoProfileMode });
const volatileBlock = chat_systemMessage_volatile({ openedURIs, directoryStr,
                          activeURI, persistentTerminalIDs });
return { stableBlock, volatileBlock };
```

**File:** `src/vs/workbench/contrib/trove/browser/chatThreadService.ts`

```typescript
// CHANGE the sendLLMMessage call to pass both:
const { stableBlock, volatileBlock } = await this._convertToLLMMessagesService
    .buildRunContext({ chatMode, modelSelection });

await sendLLMMessage({
    // ...existing params...
    separateSystemMessage: stableBlock,
    volatileSystemMessage: volatileBlock,   // NEW
    // ...
});
```

#### Fix A.1c — Cache only the stable block in Anthropic

**File:** `src/vs/workbench/contrib/trove/electron-main/llmMessage/sendLLMMessage.impl.ts`

Replace lines 558–563 (the system assembly):

```typescript
// REPLACE:
system: separateSystemMessage
    ? (enablePromptCache
        ? [{ type: 'text', text: separateSystemMessage, cache_control: { type: 'ephemeral' } }]
        : separateSystemMessage)
    : undefined,

// WITH:
system: buildAnthropicSystemBlocks(separateSystemMessage, volatileSystemMessage, enablePromptCache),
```

Add the helper function above `sendAnthropicChat`:

```typescript
const buildAnthropicSystemBlocks = (
    stableMsg: string | undefined,
    volatileMsg: string | undefined,
    enablePromptCache: boolean,
): Anthropic.TextBlockParam[] | undefined => {
    if (!stableMsg && !volatileMsg) return undefined;

    const blocks: Anthropic.TextBlockParam[] = [];

    if (stableMsg) {
        blocks.push({
            type: 'text',
            text: stableMsg,
            // Cache stable block for 1 hour. Pays for itself after 2 reads.
            // TTL must be explicit — default regressed to 5 min (March 2026).
            ...(enablePromptCache
                ? { cache_control: { type: 'ephemeral' as const, ttl: '1h' } }
                : {}),
        });
    }

    if (volatileMsg) {
        // Volatile block carries NO cache_control — it changes every turn
        blocks.push({ type: 'text', text: volatileMsg });
    }

    return blocks;
};
```

**Also add `ttl: '1h'` to the tools cache breakpoint at line 513:**

```typescript
// CHANGE line 513 from:
cache_control: { type: 'ephemeral' },
// TO:
cache_control: { type: 'ephemeral', ttl: '1h' },
```

---

### A.2 Bug: Outdated Beta Header for Caching

**File:** `src/vs/workbench/contrib/trove/common/agentOutputTokenLimits.ts`

The `prompt-caching-2024-07-31` header is in `getAnthropicBetaHeaders`. Anthropic prompt
caching became GA in late 2024 — the beta header is now ignored by the API but adds
noise and risk. Remove it:

```typescript
// CHANGE getAnthropicBetaHeaders:
export const getAnthropicBetaHeaders = (opts: {
    enablePromptCache: boolean;
    chatMode: ChatMode | null | undefined;
}): string | undefined => {
    const betas: string[] = [];
    // REMOVE: if (opts.enablePromptCache) { betas.push('prompt-caching-2024-07-31'); }
    if (opts.chatMode === 'agent') {
        betas.push(ANTHROPIC_EXTENDED_OUTPUT_BETA);
    }
    return betas.length ? betas.join(',') : undefined;
};
```

---

### A.3 Missing: Conversation History Cache Breakpoint

The third Anthropic cache breakpoint (after tools and system) should sit on the
last stable message in the conversation history. This captures the growing conversation
prefix — often 40–60% of total input tokens on long agent runs.

**File:** `src/vs/workbench/contrib/trove/electron-main/llmMessage/sendLLMMessage.impl.ts`

Add inside `sendAnthropicChat`, after the messages are prepared but before the
`anthropic.messages.stream()` call:

```typescript
/**
 * Place a cache breakpoint on the last content block of the second-to-last
 * user message (the last "stable" turn before the current one).
 * Caches the entire conversation prefix in one write.
 */
const addConversationCacheBreakpoint = (
    messages: AnthropicLLMChatMessage[],
    enablePromptCache: boolean,
): AnthropicLLMChatMessage[] => {
    if (!enablePromptCache || messages.length < 3) return messages;

    // Find the second-to-last user message
    let userCount = 0;
    let targetIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            userCount++;
            if (userCount === 2) { targetIdx = i; break; }
        }
    }
    if (targetIdx < 0) return messages;

    // Place cache_control on the last content block of that message
    const result = [...messages];
    const target = result[targetIdx];
    const rawContent = target.content;

    let contentBlocks: Anthropic.MessageParam['content'];
    if (typeof rawContent === 'string') {
        contentBlocks = [{ type: 'text', text: rawContent,
                           cache_control: { type: 'ephemeral', ttl: '1h' } }];
    } else if (Array.isArray(rawContent) && rawContent.length > 0) {
        const blocks = [...rawContent] as Anthropic.TextBlockParam[];
        blocks[blocks.length - 1] = {
            ...blocks[blocks.length - 1],
            cache_control: { type: 'ephemeral', ttl: '1h' },
        };
        contentBlocks = blocks;
    } else {
        return messages;
    }

    result[targetIdx] = { ...target, content: contentBlocks };
    return result;
};

// USE IT — right before the stream call:
const cachedMessages = addConversationCacheBreakpoint(
    messages as AnthropicLLMChatMessage[],
    enablePromptCache,
);

const stream = anthropic.messages.stream({
    system: buildAnthropicSystemBlocks(separateSystemMessage, volatileSystemMessage, enablePromptCache),
    messages: cachedMessages,   // ← use cachedMessages, not messages
    // ... rest unchanged
});
```

---

### A.4 Missing: OpenAI `prompt_cache_key`

OpenAI automatic caching works by prefix stability + backend routing. A consistent
`prompt_cache_key` routes calls with the same prefix to the same backend shard,
dramatically improving cache hit rates (documented: 60% → 87%).

**File:** `src/vs/workbench/contrib/trove/common/sendLLMMessageTypes.ts`

```typescript
// ADD to SendLLMMessageParams:
threadId?: string;     // used for OpenAI prompt_cache_key routing
```

**File:** `src/vs/workbench/contrib/trove/browser/chatThreadService.ts`

```typescript
// In the sendLLMMessage call, ADD:
threadId: thread.id,
```

**File:** `src/vs/workbench/contrib/trove/electron-main/llmMessage/sendLLMMessage.impl.ts`

In `_sendOpenAICompatibleChat`, add to the options object:

```typescript
const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: modelName,
    messages: messages as any,
    stream: true,
    ...nativeToolsObj,
    ...additionalOpenAIPayload,
    // Route calls with identical prefix to same backend — improves cache hit rate
    ...(threadId ? { prompt_cache_key: `trove:${threadId}:${modelName}` } : {}),
};
```

---

### A.5 Bug: File Read Dedup Skips by File, Not Range

**File:** `src/vs/workbench/contrib/trove/browser/fileReadDedup.ts`

`shouldSkipDuplicateFileRead` (line 82) currently skips the entire file on any
second read, even if a different range is requested. This blocks the agent from
reading a section it genuinely hasn't seen yet, causing unnecessary re-reads.

```typescript
// REPLACE shouldSkipDuplicateFileRead with range-aware version:

export const shouldSkipDuplicateFileRead = (
    fileReads: Map<string, FileReadRecord>,
    uri: URI,
    startLine: number | null,
    endLine: number | null,
): { skip: boolean; message?: string } => {
    const key = readFileUriKey(uri);
    const record = fileReads.get(key);
    if (!record || record.count < 1) return { skip: false };

    // Only skip if the requested range is FULLY COVERED by prior reads
    if (!isRangeCovered(record.ranges, startLine, endLine)) {
        return { skip: false };
    }

    const path = uri.fsPath;
    const requested = formatReadFileRange(startLine, endLine);
    const prior = record.ranges.join(', ');
    return {
        skip: true,
        message: [
            `${path}`, '```',
            `[read_file skipped — range already read]`,
            `Requested: ${requested}. Already have: ${prior}.`,
            `Use content already in the conversation instead of re-reading.`,
            '```',
        ].join('\n'),
    };
};

/** True if [start, end] is fully contained within any single prior range. */
const isRangeCovered = (
    priorRanges: string[],
    startLine: number | null,
    endLine: number | null,
): boolean => {
    if (priorRanges.includes('full file')) return true;
    // Requesting full file — only skip if full file was already read
    if (startLine === null && endLine === null) return priorRanges.includes('full file');

    const reqStart = startLine ?? 1;
    const reqEnd   = endLine ?? Infinity;

    for (const range of priorRanges) {
        if (range === 'full file') return true;
        const m = range.match(/^lines (\d+)-(\w+)$/);
        if (!m) continue;
        const rStart = parseInt(m[1], 10);
        const rEnd   = m[2] === 'end' ? Infinity : parseInt(m[2], 10);
        if (rStart <= reqStart && rEnd >= reqEnd) return true;
    }
    return false;
};
```

---

### A.6 Expected Impact

| Fix | Tokens saved | Sessions affected |
|-----|-------------|-------------------|
| A.1 stable/volatile split | 3,000–5,000 tokens/turn after turn 1 | Every session where files are switched |
| A.2 remove stale beta header | None (noise reduction) | All |
| A.3 conversation breakpoint | 500–8,000 tokens/turn in long sessions | Sessions with >5 turns |
| A.4 OpenAI prompt_cache_key | ~30% more cache hits for OpenAI | All OpenAI sessions |
| A.5 range-aware dedup | Fewer re-read tool calls | Agent sessions reading large files |

**Combined savings (Anthropic Sonnet 4.6, 20-turn session):**
- Before fixes: ~170,000 input tokens → $0.51
- After A.1+A.3: ~55,000 input tokens → ~$0.18 (cache reads + uncached)
- **Saving: ~65%**

---

## Part B — Temporal Knowledge Graph for Precision File Reading

### B.0 The Core Problem

`read_file` is the agent's primary way to understand code. For a 500-line file:

```
read_file(auth.service.ts)  →  500 lines  →  ~2,000 tokens
Agent actually uses:                            ~40 lines (one function)
Waste ratio: 50:1 on token cost
```

The existing `search_codebase` tool uses BM25 FTS5 on 80-line text chunks. It finds
relevant chunks but cannot answer: "what is the signature of `validateToken`?",
"what does `AuthService` import?", or "what changed in the last 30 minutes?".

### B.1 What Already Exists in the Codebase

**`repoIntelligenceDb.ts`** already has:
- `workspace_profiles` table ✅
- `file_metadata` table with `last_modified` (mtime) ✅
- `code_chunks` table with `start_line`, `end_line`, `chunk_type` ✅
- `chunks_fts` FTS5 virtual table with BM25 search ✅
- `replaceChunks()` / `searchChunks()` methods ✅

**What is missing:**
- Content hash column on `file_metadata` → can't detect actual content changes
- Per-file incremental re-indexing (currently full workspace rebuild)
- Symbol extraction (function/class names, signatures, line ranges)
- Import/call relationship edges
- `get_file_outline` and `get_symbol` tools

### B.2 Add Content Hash to Enable Incremental Indexing

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceDb.ts`

#### Schema change — add `content_hash` column

```sql
-- ADD to the file_metadata CREATE TABLE:
CREATE TABLE IF NOT EXISTS file_metadata (
    workspace_hash  TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    language        TEXT,
    last_modified   INTEGER NOT NULL,
    size_bytes      INTEGER NOT NULL,
    content_hash    TEXT,                  -- ADD: SHA-256 of file content
    PRIMARY KEY (workspace_hash, file_path),
    FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash)
        ON DELETE CASCADE
);

-- ADD: symbol table (output of the enhanced chunker)
CREATE TABLE IF NOT EXISTS symbols (
    workspace_hash  TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL,         -- 'function'|'class'|'interface'|'type'|'enum'
    start_line      INTEGER NOT NULL,
    end_line        INTEGER NOT NULL,
    signature       TEXT,                  -- first line of declaration (max 200 chars)
    docstring       TEXT,                  -- leading comment (max 150 chars)
    is_exported     INTEGER NOT NULL DEFAULT 0,
    content_hash    TEXT NOT NULL,         -- hash of this symbol's source text
    PRIMARY KEY (workspace_hash, file_path, name, kind),
    FOREIGN KEY (workspace_hash, file_path)
        REFERENCES file_metadata(workspace_hash, file_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(workspace_hash, name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(workspace_hash, file_path);

-- ADD: FTS over symbol names and signatures
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name,
    signature,
    docstring,
    content='symbols',
    content_rowid='rowid'
);

-- ADD: import edges (file A imports from file B)
CREATE TABLE IF NOT EXISTS import_edges (
    workspace_hash  TEXT NOT NULL,
    from_file       TEXT NOT NULL,
    to_file         TEXT NOT NULL,         -- resolved absolute path
    specifiers      TEXT,                  -- JSON array of imported names
    is_type_only    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_hash, from_file, to_file)
);
CREATE INDEX IF NOT EXISTS idx_import_to ON import_edges(workspace_hash, to_file);
```

#### New DB methods

```typescript
// ADD to RepoIntelligenceDb class:

async getFileHashes(workspaceHash: string): Promise<Map<string, string>> {
    const rows = await this._db.all<{ file_path: string; content_hash: string }>(
        `SELECT file_path, content_hash FROM file_metadata
         WHERE workspace_hash = ? AND content_hash IS NOT NULL`,
        [workspaceHash]
    );
    return new Map(rows.map(r => [r.file_path, r.content_hash]));
}

async upsertFileHash(workspaceHash: string, filePath: string, contentHash: string): Promise<void> {
    await this._db.run(
        `UPDATE file_metadata SET content_hash = ? WHERE workspace_hash = ? AND file_path = ?`,
        [contentHash, workspaceHash, filePath]
    );
}

async replaceSymbolsForFile(workspaceHash: string, filePath: string, symbols: ExtractedSymbol[]): Promise<void> {
    await this._db.run(
        `DELETE FROM symbols WHERE workspace_hash = ? AND file_path = ?`,
        [workspaceHash, filePath]
    );
    for (const s of symbols) {
        await this._db.run(
            `INSERT OR REPLACE INTO symbols
             (workspace_hash, file_path, name, kind, start_line, end_line,
              signature, docstring, is_exported, content_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [workspaceHash, filePath, s.name, s.kind, s.startLine, s.endLine,
             s.signature, s.docstring, s.isExported ? 1 : 0, s.contentHash]
        );
    }
}

async getFileOutline(workspaceHash: string, filePath: string): Promise<ExtractedSymbol[]> {
    return this._db.all<ExtractedSymbol>(
        `SELECT name, kind, start_line as startLine, end_line as endLine,
                signature, docstring, is_exported as isExported
         FROM symbols WHERE workspace_hash = ? AND file_path = ?
         ORDER BY start_line ASC`,
        [workspaceHash, filePath]
    );
}

async getSymbol(workspaceHash: string, filePath: string, symbolName: string): Promise<ExtractedSymbol | null> {
    return this._db.get<ExtractedSymbol>(
        `SELECT name, kind, start_line as startLine, end_line as endLine,
                signature, docstring, is_exported as isExported
         FROM symbols WHERE workspace_hash = ? AND file_path = ? AND name = ?
         LIMIT 1`,
        [workspaceHash, filePath, symbolName]
    ) ?? null;
}

async searchSymbols(workspaceHash: string, query: string, maxResults = 20): Promise<ExtractedSymbol[]> {
    // FTS5 search first
    try {
        const ftsResults = await this._db.all<ExtractedSymbol>(
            `SELECT s.name, s.kind, s.file_path as filePath,
                    s.start_line as startLine, s.end_line as endLine,
                    s.signature, s.docstring, s.is_exported as isExported
             FROM symbols_fts f
             JOIN symbols s ON s.rowid = f.rowid
             WHERE f MATCH ? AND s.workspace_hash = ?
             ORDER BY rank LIMIT ?`,
            [query.replace(/["\-^*():]/g, ' '), workspaceHash, maxResults]
        );
        if (ftsResults.length > 0) return ftsResults;
    } catch { /* FTS parse error — fall through to LIKE */ }

    // Fallback: LIKE on name
    return this._db.all<ExtractedSymbol>(
        `SELECT name, kind, file_path as filePath,
                start_line as startLine, end_line as endLine,
                signature, docstring, is_exported as isExported
         FROM symbols WHERE workspace_hash = ? AND name LIKE ?
         LIMIT ?`,
        [workspaceHash, `%${query}%`, maxResults]
    );
}
```

### B.3 Enhance `codeChunker.ts` to Extract Named Symbols

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/codeChunker.ts`

The current chunker splits files into 80-line chunks but doesn't capture symbol names,
signatures, or docstrings. Extend it to extract these while keeping the existing chunk
output unchanged (both run side-by-side):

```typescript
// ADD type (also export from common/repoIntelligenceTypes.ts):
export type ExtractedSymbol = {
    name: string;
    kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const';
    filePath: string;
    startLine: number;
    endLine: number;
    signature: string;      // first declaration line, max 200 chars
    docstring: string;      // leading comment text, max 150 chars
    isExported: boolean;
    contentHash: string;    // hash of symbol source text
};

// ADD named symbol patterns alongside existing LANGUAGE_BOUNDARIES:
type SymbolPattern = {
    nameRegex: RegExp;       // must have a capture group for the symbol name
    kind: ExtractedSymbol['kind'];
    exportRegex: RegExp;     // detect export keyword
};

const SYMBOL_PATTERNS: Record<string, SymbolPattern[]> = {
    TypeScript: [
        { nameRegex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, kind: 'function',   exportRegex: /^export\s/ },
        { nameRegex: /^(?:export\s+)?class\s+(\w+)/m,                  kind: 'class',     exportRegex: /^export\s/ },
        { nameRegex: /^(?:export\s+)?interface\s+(\w+)/m,              kind: 'interface', exportRegex: /^export\s/ },
        { nameRegex: /^(?:export\s+)?type\s+(\w+)\s*=/m,               kind: 'type',      exportRegex: /^export\s/ },
        { nameRegex: /^(?:export\s+)?enum\s+(\w+)/m,                   kind: 'enum',      exportRegex: /^export\s/ },
        { nameRegex: /^export\s+const\s+(\w+)/m,                       kind: 'const',     exportRegex: /^export\s/ },
    ],
    JavaScript: [
        { nameRegex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, kind: 'function', exportRegex: /^export\s/ },
        { nameRegex: /^(?:export\s+)?class\s+(\w+)/m,                  kind: 'class',    exportRegex: /^export\s/ },
        { nameRegex: /^export\s+const\s+(\w+)/m,                       kind: 'const',    exportRegex: /^export\s/ },
    ],
    Python: [
        { nameRegex: /^def\s+(\w+)/m,   kind: 'function', exportRegex: /^(?!_)/ },
        { nameRegex: /^class\s+(\w+)/m, kind: 'class',    exportRegex: /^(?!_)/ },
    ],
    Go: [
        { nameRegex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m, kind: 'function', exportRegex: /^func\s+[A-Z]/ },
        { nameRegex: /^type\s+(\w+)\s+struct/m,                  kind: 'class',    exportRegex: /^type\s+[A-Z]/ },
        { nameRegex: /^type\s+(\w+)\s+interface/m,               kind: 'interface', exportRegex: /^type\s+[A-Z]/ },
    ],
    Rust: [
        { nameRegex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m,  kind: 'function', exportRegex: /^pub\s/ },
        { nameRegex: /^(?:pub\s+)?struct\s+(\w+)/m,            kind: 'class',    exportRegex: /^pub\s/ },
        { nameRegex: /^(?:pub\s+)?trait\s+(\w+)/m,             kind: 'interface', exportRegex: /^pub\s/ },
    ],
};

// ADD helper functions:

const extractLeadingDocstring = (lines: string[], startLineIdx: number, language: string): string => {
    const commentChars = language === 'Python' ? ['#'] : ['//', '*', '/**', '/*'];
    const result: string[] = [];
    for (let i = startLineIdx - 1; i >= Math.max(0, startLineIdx - 8); i--) {
        const line = lines[i].trim();
        const isComment = commentChars.some(c => line.startsWith(c)) || line === '*/';
        if (!isComment && line !== '') break;
        if (isComment) result.unshift(line.replace(/^[/*#\s]+/, '').replace(/\*+\/$/, '').trim());
    }
    return result.filter(Boolean).join(' ').slice(0, 150);
};

// ADD new export alongside existing chunkFile:
export const extractSymbolsFromFile = (
    workspaceHash: string,
    filePath: string,
    content: string,
    language: string | null,
): ExtractedSymbol[] => {
    if (!language || SKIP_LANGUAGES.has(language)) return [];
    const patterns = SYMBOL_PATTERNS[language];
    if (!patterns || patterns.length === 0) return [];

    const lines = content.split('\n');
    const symbols: ExtractedSymbol[] = [];

    // Find boundary lines (reuse existing findBoundaryLines logic to get start positions)
    const boundaryLines = findBoundaryLines(content, LANGUAGE_BOUNDARIES[language] ?? []);

    for (let b = 0; b < boundaryLines.length; b++) {
        const startLineIdx = boundaryLines[b].line - 1;  // 0-based
        const endLineIdx   = b + 1 < boundaryLines.length
            ? boundaryLines[b + 1].line - 2
            : lines.length - 1;
        const line = lines[startLineIdx];

        for (const pat of patterns) {
            const match = pat.nameRegex.exec(line);
            if (!match || !match[1]) continue;

            const name        = match[1];
            const isExported  = pat.exportRegex.test(line);
            const signature   = line.trim().slice(0, 200);
            const docstring   = extractLeadingDocstring(lines, startLineIdx, language);
            const symbolText  = lines.slice(startLineIdx, endLineIdx + 1).join('\n');
            const contentHash = createHash('sha256').update(symbolText).digest('hex').slice(0, 16);

            symbols.push({
                name, kind: pat.kind, filePath,
                startLine: startLineIdx + 1,   // 1-based
                endLine:   endLineIdx + 1,
                signature, docstring, isExported, contentHash,
            });
            break;
        }
    }
    return symbols;
};
```

### B.4 Incremental Per-File Re-Indexing

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceService.impl.ts`

The current `_ensureChunksIndexed` (line 175) does a full workspace re-chunk when chunk
count is 0. Change it to a hash-gated per-file approach:

```typescript
// ADD: incremental symbol indexing (called after workspace scan)
private async _indexSymbolsIncremental(
    workspaceRoot: string,
    workspaceHash: string,
    fileMeta: FileMetadataEntry[],
): Promise<void> {
    // Get the stored content hashes for all files in this workspace
    const storedHashes = await this._db.getFileHashes(workspaceHash);

    const toReindex: FileMetadataEntry[] = [];
    for (const file of fileMeta) {
        if (SKIP_LANGUAGES.has(file.language ?? '')) continue;
        if (!SYMBOL_PATTERNS[file.language ?? '']) continue;

        const absPath = join(workspaceRoot, file.filePath);
        let content: string;
        try {
            content = readFileSync(absPath, 'utf8');
        } catch { continue; }

        const currentHash = createHash('sha256').update(content).digest('hex').slice(0, 32);
        if (storedHashes.get(file.filePath) === currentHash) continue;  // unchanged

        // File changed — re-index its symbols
        const symbols = extractSymbolsFromFile(workspaceHash, file.filePath, content, file.language);
        await this._db.replaceSymbolsForFile(workspaceHash, file.filePath, symbols);
        await this._db.upsertFileHash(workspaceHash, file.filePath, currentHash);
    }
}

// CHANGE _scanWorkspace to call this after chunk building:
private async _scanWorkspace(workspaceRoot: string): Promise<WorkspaceProfile> {
    // ...existing scan code...
    const chunks = buildChunksForWorkspace(workspaceRoot, hash, scan.fileMeta);
    await this._db.replaceChunks(hash, chunks);

    // ADD: index symbols incrementally
    await this._indexSymbolsIncremental(workspaceRoot, hash, scan.fileMeta);

    // ...rest unchanged...
}
```

### B.5 New Tools: `get_file_outline` and `get_symbol`

#### Step 1 — Add to types

**File:** `src/vs/workbench/contrib/trove/common/repoIntelligenceTypes.ts`

```typescript
// ADD to IRepoIntelligenceMainService:
getFileOutline(workspaceRoot: string, filePath: string): Promise<ExtractedSymbol[]>;
getSymbol(workspaceRoot: string, filePath: string, symbolName: string): Promise<string | null>;
searchSymbols(workspaceRoot: string, query: string, maxResults?: number): Promise<ExtractedSymbol[]>;
```

**File:** `src/vs/workbench/contrib/trove/common/toolsServiceTypes.ts`

Add to `BuiltinToolCallParams` and `BuiltinToolResultType`:

```typescript
// In BuiltinToolCallParams (the input params map):
'get_file_outline': { uri: URI },
'get_symbol':       { uri: URI, symbolName: string },
'search_symbols':   { query: string, maxResults: number },

// In BuiltinToolResultType (the output map):
'get_file_outline': { outline: string },
'get_symbol':       { source: string; startLine: number; endLine: number } | { error: string },
'search_symbols':   { results: string },
```

#### Step 2 — Add tool definitions to system prompt

**File:** `src/vs/workbench/contrib/trove/common/prompt/prompts.ts`

In the `builtinTools` list (where tool descriptions are defined for the LLM):

```typescript
get_file_outline: {
    description: `Get a structural outline of a file: all functions, classes, interfaces,
types and enums with their line ranges and signatures.
Use this BEFORE read_file on any file >100 lines to decide what to read.
Cost: ~50 tokens regardless of file size (vs 500–5000 for read_file).`,
    params: {
        uri: { description: 'Absolute path to the file' },
    },
},

get_symbol: {
    description: `Get the complete source code of one named symbol (function, class,
interface, type, or enum) by name. Reads only that symbol's lines — much cheaper
than reading the whole file.
Use get_file_outline first to confirm the symbol exists.`,
    params: {
        uri:        { description: 'Absolute path to the file containing the symbol' },
        symbolName: { description: 'Exact name of the function, class, interface, type, or enum' },
    },
},

search_symbols: {
    description: `Search for symbols by name or description across the entire codebase.
Returns symbol names, kinds, file paths, and signatures — no file content.
Use to locate where something is implemented before using get_symbol or read_file.`,
    params: {
        query:      { description: 'Symbol name, partial name, or description' },
        maxResults: { description: 'Maximum results to return (default 15)' },
    },
},
```

**Also add to the agent system prompt instructions:**

```typescript
// ADD to chat_systemMessage_stable, in the tool-use policy section:
const FILE_READING_POLICY = `
<file_reading_policy>
For large files (>100 lines), always follow this order:
1. get_file_outline(path) — see all symbols and line ranges (~50 tokens)
2. get_symbol(path, name) — read one symbol (~100–300 tokens)
3. read_file(path, startLine, endLine) — specific range only when get_symbol is insufficient
4. read_file(path) — only when you genuinely need the entire file

For finding where something is implemented: use search_symbols(query) first.
Never use read_file on a file >200 lines without first calling get_file_outline.
</file_reading_policy>
`;
```

#### Step 3 — Implement in the browser tools service

**File:** `src/vs/workbench/contrib/trove/browser/toolsService.ts`

In the `callTool` switch statement, add handlers for the three new tools:

```typescript
case 'get_file_outline': {
    const filePath = params.uri instanceof URI
        ? params.uri.fsPath
        : String(params.uri);
    const workspaceRoot = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
    const symbols = await this._repoIntelligenceService.getFileOutline(workspaceRoot, filePath);

    if (symbols.length === 0) {
        return {
            outline: `No indexed symbols found in ${filePath}.\n` +
                     `The file may not be indexed yet, or may use an unsupported language.\n` +
                     `Try read_file instead, or wait for indexing to complete.`,
        };
    }

    const lines = symbols.map(s => {
        const exportTag = s.isExported ? 'export ' : '       ';
        const range     = `L${s.startLine}–${s.endLine}`.padEnd(12);
        const sig       = (s.signature ?? `${s.kind} ${s.name}`).slice(0, 80);
        return `  ${range} ${exportTag}${s.kind.padEnd(10)} ${sig}`;
    });

    return {
        outline: `File outline: ${filePath}\n${'─'.repeat(60)}\n${lines.join('\n')}`,
    };
}

case 'get_symbol': {
    const uri = params.uri instanceof URI ? params.uri : URI.file(String(params.uri));
    const workspaceRoot = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
    const sym = await this._repoIntelligenceService.getSymbol(workspaceRoot, uri.fsPath, params.symbolName);

    if (!sym) {
        return {
            error: `Symbol '${params.symbolName}' not found in ${uri.fsPath}.\n` +
                   `Use get_file_outline to see all available symbols.`,
        };
    }

    // Read only the specific line range (not the full file)
    const fileContent = await this._fileService.readFile(uri);
    const allLines    = fileContent.value.toString().split('\n');
    const slice       = allLines.slice(sym.startLine - 1, sym.endLine).join('\n');
    const header      = sym.docstring ? `// ${sym.docstring}\n` : '';

    return {
        source: `// ${uri.fsPath} — ${params.symbolName} (L${sym.startLine}–${sym.endLine})\n` +
                '```\n' + header + slice + '\n```',
        startLine: sym.startLine,
        endLine:   sym.endLine,
    };
}

case 'search_symbols': {
    const workspaceRoot = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
    const max    = typeof params.maxResults === 'number' ? params.maxResults : 15;
    const found  = await this._repoIntelligenceService.searchSymbols(workspaceRoot, params.query, max);

    if (found.length === 0) {
        return { results: `No symbols found matching '${params.query}'.` };
    }

    const lines = found.map(s =>
        `  ${s.kind.padEnd(10)} ${s.name.padEnd(30)} ` +
        `${s.filePath}:${s.startLine}` +
        (s.docstring ? `\n              ${s.docstring.slice(0, 80)}` : '')
    );
    return { results: `Symbols matching '${params.query}' (${found.length}):\n${lines.join('\n')}` };
}
```

#### Step 4 — Expose via IPC channel

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceChannel.ts`

Add `getFileOutline`, `getSymbol`, `searchSymbols` to the channel handler alongside
the existing `searchCodebase` handler. The pattern is identical.

---

### B.6 Token Reduction by Task Type

| Task | Current (read_file) | With KG tools | Reduction |
|------|--------------------|--------------|----|
| "Fix bug in validateToken" | read whole file: ~2,000 tok | outline 50 + symbol 200 = 250 tok | **8×** |
| "What does AuthService import?" | read file: ~2,000 tok | import edges (TBD): ~60 tok | **33×** |
| "Find where UserType is defined" | search + read: ~3,000 tok | search_symbols: ~100 tok | **30×** |
| "Understand LoginController" | read file: ~1,500 tok | outline: ~80 tok | **19×** |
| "Refactor across 5 files" | read all 5: ~8,000 tok | outlines + targeted symbols: ~800 tok | **10×** |

---

## Implementation Order

```
Week 1: All of Part A (token caching fixes)
  A.1 stable/volatile system split  →  3 files changed
  A.2 remove stale beta header      →  1 file changed
  A.3 conversation cache breakpoint →  1 file changed
  A.4 OpenAI prompt_cache_key       →  3 files changed
  A.5 range-aware file dedup        →  1 file changed

  Verify: chat session with Anthropic, check cache_read_input_tokens > 0 after turn 2

Week 2: Part B — DB schema + symbol extraction
  B.2 add content_hash + symbol table to DB   →  repoIntelligenceDb.ts
  B.3 add extractSymbolsFromFile to chunker   →  codeChunker.ts
  B.4 incremental indexing in service         →  repoIntelligenceService.impl.ts

  Verify: after workspace open, symbols table has rows for TS/JS files

Week 3: Part B — New tools
  B.5 add tool types                          →  toolsServiceTypes.ts
  B.5 add tool descriptions                   →  prompts.ts
  B.5 add tool implementations                →  toolsService.ts
  B.5 expose via IPC                          →  repoIntelligenceChannel.ts

  Verify: agent calls get_file_outline instead of read_file on large files
```

---

## Quick Diagnostic: Check if Caching Is Working

After implementing Part A, add this to `chatThreadService.ts` temporarily:

```typescript
// In the onFinalMessage handler, after recordTurn():
if (usage) {
    const cacheRatio = usage.cacheReadTokens > 0
        ? `${((usage.cacheReadTokens / usage.inputTokens) * 100).toFixed(1)}% from cache`
        : `CACHE MISS (${usage.inputTokens} tokens paid at full rate)`;
    console.info(`[Trove Cache] Turn ${turnCount}: ${cacheRatio}`, {
        inputTokens:      usage.inputTokens,
        cacheReadTokens:  usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens:     usage.outputTokens,
    });
}
```

A healthy multi-turn session should show:
- Turn 1: `CACHE MISS` (expected — first write)
- Turn 2+: `60–80% from cache`

If you still see `CACHE MISS` after turn 2, the stable block is still volatile.
Add `console.log(stableBlock)` to verify it's identical across turns.
