 Plan to implement                                                                                                                              │
│                                                                                                                                                │
│ Claude Code Telegram Gateway — Implementation Plan                                                                                             │
│                                                                                                                                                │
│ Context                                                                                                                                        │
│                                                                                                                                                │
│ Building an open-source Telegram bot that acts as a gateway to Claude Code via the @anthropic-ai/claude-agent-sdk TypeScript SDK. Users send   │
│ messages in Telegram, the bot forwards them to Claude Code (which has access to tools like file reading, editing, bash, etc.), and responses   │
│ come back to the chat. Includes a TUI onboarding wizard for first-time setup.                                                                  │
│                                                                                                                                                │
│ Tech Stack                                                                                                                                     │
│                                                                                                                                                │
│ - TypeScript (ESM, Node.js 18+)                                                                                                                │
│ - @anthropic-ai/claude-agent-sdk — Claude Agent SDK                                                                                            │
│ - grammy — Telegram bot framework (better TS types, modern API, auto-retry plugin)                                                             │
│ - @inquirer/prompts — TUI setup wizard                                                                                                         │
│ - tsx — dev runner (no build step needed during dev)                                                                                           │
│                                                                                                                                                │
│ Key Design Decisions                                                                                                                           │
│                                                                                                                                                │
│ 1. grammY over Telegraf — first-class TS support, cleaner middleware, @grammyjs/auto-retry for rate limits                                     │
│ 2. Stable V1 query() API — not the unstable V2 preview. resume: sessionId handles multi-turn                                                   │
│ 3. Local config.json (gitignored) — simplest model for a clone-and-run project                                                                 │
│ 4. Session persistence — Map<chatId, sessionId> backed by sessions.json so sessions survive restarts                                           │
│ 5. MarkdownV2 with plain-text fallback — attempt formatting, catch errors, fall back gracefully                                                │
│                                                                                                                                                │
│ Project Structure                                                                                                                              │
│                                                                                                                                                │
│ claude-telegram/                                                                                                                               │
│ ├── package.json                                                                                                                               │
│ ├── tsconfig.json                                                                                                                              │
│ ├── .gitignore                                                                                                                                 │
│ ├── PLAN.md                                                                                                                                    │
│ ├── config.json                    # [GENERATED, GITIGNORED]                                                                                   │
│ ├── sessions.json                  # [GENERATED, GITIGNORED]                                                                                   │
│ ├── .claude/                                                                                                                                   │
│ │   └── commands/                                                                                                                              │
│ │       └── setup.md               # Claude Code slash command for setup                                                                       │
│ └── src/                                                                                                                                       │
│     ├── index.ts                   # Entry point: load config, start bot                                                                       │
│     ├── setup.ts                   # TUI onboarding wizard (npm run setup)                                                                     │
│     ├── config.ts                  # Config loading + validation                                                                               │
│     ├── bot.ts                     # grammY bot: handlers, middleware, user restriction                                                        │
│     ├── claude.ts                  # Agent SDK integration: query, session capture, error handling                                             │
│     ├── sessions.ts                # SessionManager: chatId <-> sessionId persistence                                                          │
│     ├── hooks.ts                   # PreToolUse safety hooks (block dangerous commands)                                                        │
│     ├── formatter.ts               # Telegram message chunking (4096 limit) + MarkdownV2 escaping                                              │
│     └── types.ts                   # Shared TypeScript interfaces                                                                              │
│                                                                                                                                                │
│ Config Schema (config.json)                                                                                                                    │
│                                                                                                                                                │
│ interface AppConfig {                                                                                                                          │
│   telegramBotToken: string;                                                                                                                    │
│   anthropicApiKey: string;                                                                                                                     │
│   allowedUserIds: number[];                                                                                                                    │
│   workingDirectory: string;                                                                                                                    │
│   permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";                                                                    │
│   allowedTools: string[];                                                                                                                      │
│   model?: string;                                                                                                                              │
│   maxBudgetUsd?: number;                                                                                                                       │
│ }                                                                                                                                              │
│                                                                                                                                                │
│ Implementation Order                                                                                                                           │
│                                                                                                                                                │
│ Phase 1: Scaffolding                                                                                                                           │
│                                                                                                                                                │
│ - package.json, tsconfig.json, .gitignore, src/types.ts                                                                                        │
│ - Install deps: grammy, @anthropic-ai/claude-agent-sdk, @inquirer/prompts, tsx, typescript                                                     │
│ - Verify: npx tsc --noEmit passes                                                                                                              │
│                                                                                                                                                │
│ Phase 2: Config + Setup (Two Paths)                                                                                                            │
│                                                                                                                                                │
│ - src/config.ts — load and validate config.json                                                                                                │
│ - src/setup.ts — TUI wizard (npm run setup): collects bot token, API key, user IDs, working dir, permission mode, tools via @inquirer/prompts  │
│ - .claude/commands/setup.md — Claude Code slash command (/project:setup): instructs Claude to collect the same info via AskUserQuestion,       │
│ validate it, then write config.json using the Write tool. This lets users configure the bot without leaving Claude Code.                       │
│ - Both paths write the same config.json format                                                                                                 │
│ - Verify: npm run setup creates valid config.json; running /project:setup in Claude Code does the same                                         │
│                                                                                                                                                │
│ Phase 3: Sessions + Hooks + Formatter                                                                                                          │
│                                                                                                                                                │
│ - src/sessions.ts — SessionManager class with JSON persistence                                                                                 │
│ - src/hooks.ts — PreToolUse hook blocking dangerous bash patterns (rm -rf, git push --force, fork bombs, etc.)                                 │
│ - src/formatter.ts — split at 4000 chars on paragraph/line boundaries, MarkdownV2 escaping                                                     │
│ - Verify: Unit-level manual tests for each                                                                                                     │
│                                                                                                                                                │
│ Phase 4: Claude Integration                                                                                                                    │
│                                                                                                                                                │
│ - src/claude.ts — sendToClaude() wrapping query(), captures session ID on init, handles result/error subtypes, tracks tools used and cost      │
│ - Verify: Call with a simple prompt, confirm response + session ID                                                                             │
│                                                                                                                                                │
│ Phase 5: Bot Assembly                                                                                                                          │
│                                                                                                                                                │
│ - src/bot.ts — grammY bot with:                                                                                                                │
│   - User restriction middleware (silently ignores unauthorized users)                                                                          │
│   - /start — reset session, show working dir info                                                                                              │
│   - /reset — clear session                                                                                                                     │
│   - /status — show session state                                                                                                               │
│   - Text handler — typing indicator (refreshed every 4s), call sendToClaude, format + send response chunks, optional cost footer               │
│ - src/index.ts — bootstrap: load config, set ANTHROPIC_API_KEY, create SessionManager, create bot, start polling, handle SIGINT                │
│ - Verify: Full end-to-end: /start in Telegram, send a message, get Claude response                                                             │
│                                                                                                                                                │
│ Phase 6 (Future): Streaming                                                                                                                    │
│                                                                                                                                                │
│ - Add sendToClaudeStreaming() with onPartialUpdate callback                                                                                    │
│ - Edit a "Working..." placeholder message as partial results arrive                                                                            │
│ - Throttle edits to every ~2.5s to avoid Telegram rate limits                                                                                  │
│ - Use @grammyjs/auto-retry plugin                                                                                                              │
│                                                                                                                                                │
│ npm Scripts                                                                                                                                    │
│                                                                                                                                                │
│ ┌────────┬────────────────────┬───────────────────────┐                                                                                        │
│ │ Script │      Command       │        Purpose        │                                                                                        │
│ ├────────┼────────────────────┼───────────────────────┤                                                                                        │
│ │ setup  │ tsx src/setup.ts   │ Run onboarding wizard │                                                                                        │
│ ├────────┼────────────────────┼───────────────────────┤                                                                                        │
│ │ dev    │ tsx src/index.ts   │ Dev mode (no build)   │                                                                                        │
│ ├────────┼────────────────────┼───────────────────────┤                                                                                        │
│ │ build  │ tsc                │ Compile to dist/      │                                                                                        │
│ ├────────┼────────────────────┼───────────────────────┤                                                                                        │
│ │ start  │ node dist/index.js │ Production run        │                                                                                        │
│ └────────┴────────────────────┴───────────────────────┘                                                                                        │
│                                                                                                                                                │
│ Verification                                                                                                                                   │
│                                                                                                                                                │
│ End-to-end test after Phase 5:                                                                                                                 │
│ 1. npm run setup — fill in real tokens                                                                                                         │
│ 2. npm run dev — bot starts, prints @botname is running                                                                                        │
│ 3. Send /start in Telegram — get welcome message                                                                                               │
│ 4. Send "What files are in this directory?" — get Claude response with file listing                                                            │
│ 5. Send a follow-up referencing the previous context — confirm session persistence                                                             │
│ 6. /reset then send another message — confirm fresh session                                                                                    │
│ 7. Unauthorized user sends message — confirm no response
