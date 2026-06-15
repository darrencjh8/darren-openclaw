# Implementation Plan: Expense Tracker Plugin Tools

**Branch**: `014-expense-plugin-tools` | **Date**: 2026-06-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/014-expense-plugin-tools/spec.md`

## Summary

Replace the fragile `exec curl` pattern in the expense-tracker SKILL.md with an OpenClaw plugin that wraps all 21 expense-tracker REST endpoints as typed tools with `budget_`-prefixed names. The plugin is a thin HTTP client layer: each `api.registerTool()` call makes a POST request to `http://expense-tracker:8080/tools/<endpoint>`. Bind-mount persistence ensures the plugin survives container rebuilds. The SKILL.md, design.md, and gateway baseline spec are updated to reflect typed tool invocation.

## Technical Context

**Language/Version**: JavaScript (Node.js ESM, Node 22+)

**Primary Dependencies**: `openclaw/plugin-sdk/plugin-entry` (bundled with gateway image), `typebox` (bundled with gateway image)

**Storage**: N/A — plugin is stateless; all state lives in the expense-tracker container

**Testing**: vitest (matches project convention at `modules/expense-tracker/vitest.config.js`); tests mock global `fetch` to verify HTTP calls without a running expense-tracker

**Target Platform**: Docker (Linux container, `gateway-openclaw` image based on `openclaw:latest-browser`)

**Project Type**: OpenClaw plugin (tool-only, non-capability)

**Performance Goals**: HTTP call overhead < 100ms per tool (internal Docker network); plugin load time < 1s

**Constraints**: No impact on existing gateway startup time; plugin source must be version-controlled and bind-mounted

**Scale/Scope**: 21 tools, single gateway instance, internal use only

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|---|---|---|
| §2.1 We Configure OpenClaw — We Don't Build It | ✅ PASS | Plugin uses official `api.registerTool()` SDK; no gateway source modification |
| §2.2 We Build Skills + Deterministic Tools | ✅ PASS | Each tool is a deterministic HTTP call with a TypeBox schema |
| §2.3 TDD | ✅ PASS | Tools are thin wrappers testable with mocked `fetch`; vitest matches project convention |
| §2.4 Docker-First | ✅ PASS | Plugin bind-mounted in `docker-compose.yml`; version-controlled at `gateway/plugins/` |
| §2.5 Memory Budget | ✅ PASS | Plugin adds <5MB (21 thin wrappers, no state) |
| §2.6 Security | ✅ PASS | Plugin calls internal Docker network only (`expense-tracker:8080`); no external I/O |
| §2.7 Data Integrity | ✅ PASS | Plugin passes data through without modification; expense-tracker owns validation |
| §2.8 LLM Agent Principles | ✅ PASS | Eliminates `exec curl` shell hallucination class; tools are deterministic typed functions |
| §2.9 Observability | ✅ PASS | Plugin load status logged by Gateway; tool calls tracked via normal OpenClaw telemetry |

**Gate Result**: ALL PASS — proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/014-expense-plugin-tools/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
gateway/
├── plugins/
│   └── expense-tracker-tools/       # Plugin source (NEW)
│       ├── package.json             # npm metadata + openclaw compat
│       ├── openclaw.plugin.json     # Manifest (contracts.tools, activation)
│       └── index.js                 # 21 api.registerTool() calls
├── workspace/
│   └── skills/
│       └── expense-tracker/
│           └── SKILL.md             # Updated: exec curl → typed tool refs
├── docker-compose.yml               # Updated: add plugin bind-mount
└── openclaw.json                    # Updated: add plugins.entries

design.md                            # Updated: tool count 16->21, add check_statement_duplicate to 5A.4, plugin architecture
specs/001-gateway-baseline/spec.md   # Updated: expense-tracker skill description (10 tools -> 21 typed plugin tools)
```

## Complexity Tracking

> No violations. All constitution gates pass.

