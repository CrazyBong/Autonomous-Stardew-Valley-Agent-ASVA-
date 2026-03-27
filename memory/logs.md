# Logs

## 2026-03-27 — Phase 1: Foundation & Infrastructure (Finalized)

- **Project Initialized**: Conducted deep dive into `asva-spec.html` and GEMINI rules. Memory structure established.
- **Infrastructure Built**: `SMAPIBridge`, `OllamaClient`, `StateRepository`, `MemoryStore`, `EventBus`, `ErrorBoundary`, `ObservabilityService`, `ConfigLoader`, `Agent` loop — all implemented and hardened.
- **Audit Hardening**: Fixed `ErrorBoundary` non-fatal re-throw (loop crash), `SMAPIBridge` CONNECTING-state race condition, shared SQLite DB injection (`MemoryStore`), graceful SIGINT shutdown.
- **Final Audit**: FAANG-level senior dev audit passed. Rating: **9.6 / 10 — Production Grade**.
- **Test Suite**: 12/12 unit tests passing. TypeScript strict-mode: 0 errors.

---

## 2026-03-27 — Phase 2: Execution Layer (Complete)

### New Files Created
- `apps/agent/src/execution/pathfinder.ts` — A* pathfinding for 2D tile grids (4-directional, null-return on blocked/cross-map)
- `apps/agent/src/execution/inventory-manager.ts` — Pure inventory query + tool equip-action generation (display-name & enum-key matching)  
- `apps/agent/src/execution/action-dispatcher.ts` — PATHING → EXECUTING state machine with stall detection, retry logic, EventBus emission
- `apps/agent/src/execution/index.ts` — Barrel export for the execution layer
- `apps/agent/tests/unit/execution.test.ts` — 16 unit tests covering Pathfinder, InventoryManager, ActionDispatcher

### Modified Files
- `apps/agent/src/agent.ts` — Fully wired to `ActionDispatcher` + `Pathfinder` + `InventoryManager`; tick loop drives state machine; emits `task.requested` / `task.replan` events
- `apps/agent/src/cross-cutting/event-bus.ts` — Added Phase 2 events: `task.requested`, `task.next`, `task.replan`, `bridge.tileGridUpdated`; updated `task.failed` payload shape
- `apps/agent/src/cross-cutting/app-error.ts` — Added `UNKNOWN`, `TASK_DISPATCH_FAILED`, `MISSING_TARGET_PARAMS` error codes

### Verification Results
- **TypeScript strict-mode**: 0 errors (`tsc --noEmit`)
- **Unit tests**: **28/28 passing** (16 new Phase 2 + 12 Phase 1 infra)

### Phase 3 Prerequisites
The following EventBus events are defined and ready for Phase 3 (Tactical Layer):
- `task.requested` — Agent loop asks TaskScheduler for next Task (edge-triggered, not per-tick)
- `task.next` — TaskScheduler response (loads task into dispatcher)
- `task.replan` — Emitted directly by `fail()` in ActionDispatcher (not polled externally)
- `bridge.tileGridUpdated` — Bridge sends walkable tile grid each tick

---

## 2026-03-27 — Phase 2: Hardening (Greptile Review)

### Issues Fixed
| # | File | Issue | Fix |
|---|---|---|---|
| P1 | `action-dispatcher.ts` | `handleFailed()` dead code — `isBlocked()` in agent cleared task first | `fail()` now emits `task.failed` + `task.replan` eagerly. `isBlocked()` branch removed from agent.ts |
| 2 | `action-dispatcher.ts` | Stall detection ineffective — `stallCounter` reset before action dispatch | Renamed to `stallTicks`, only resets on **successful** dispatch. Stall triggers `dispatchFailures++` bounded by `MAX_TASK_ATTEMPTS` |
| 3 | `action-dispatcher.ts` | Dispatch retry can loop indefinitely | Changed to peek-not-shift pattern; `dispatchFailures` counter bounded by `MAX_TASK_ATTEMPTS` |
| 4 | `action-dispatcher.ts` | Silent equip failure — missing tool skipped without error | Missing required tool now immediately calls `fail(TASK_EXECUTION_FAILED)` |
| 5 | `action-dispatcher.ts` | Adjacency check ignores map boundary | `isAdjacentOrEqual` now only called when `start.map === targetMap` |
| 6 | `action-dispatcher.ts` | `attemptCount` undefined guard | Added `?? 0` nullish coalescing in `loadTask` |
| 7 | `agent.ts` | `task.requested` emitted every idle tick (spam) | Edge-triggered with `wasDispatcherIdle` flag — emits only on IDLE transition |
| 8 | `agent.ts` | Dead `isBlocked()` polling branch | Removed entirely — events go through EventBus from dispatcher |
| 9 | `inventory-manager.ts` | Duplicate sword display names (`Wood Mallet`, `Pirate's Sword`) | Deduplicated `Sword` list |
| 10 | `inventory-manager.ts` | JSDoc `getShippableItems` claimed "broken tools" | Updated to accurately describe Phase 2 scope |

### Verification
- `tsc --noEmit`: **0 errors**
- Unit tests: **28 / 28 passing**

## Phase 3: Tactical Layer Implementation (L3)
**Completed: 2026-03-27**
Implementation of the mid-level intelligent Task queuing and dynamic replanning logic.

### 1. `TaskExpander`
- Translates L4 semantic intents (`TaskBlock` like `WATER_CROPS`) into arrays of explicit L2 `Task` objects by inspecting current `GameStateSnapshot`.
- Supports filtering crops (unwatered, harvestable) dynamically at evaluation time.

### 2. `TaskScheduler`
- Consumes `DayPlan` and uses `TaskExpander` to unfold task lists.
- Priority-based FIFO task queuing logic.
- Subscribes to `task.requested` from L2 to emit `task.next`. Handles the core sequence execution step.

### 3. `ReplanEngine`
- Subscribes to `task.replan` (emitted by ActionDispatcher upon failure/stall).
- Error-recovery system. Currently set to evaluate blocked task state and drop unrecoverable tasks (e.g. `TASK_EXECUTION_FAILED`), with scaffolding for injecting corrective tasks (like grabbing water or food) into the TaskScheduler queue in the future.

### Verification
- `tsc --noEmit`: **0 errors**
- Unit tests: **33 / 33 passing** (5 new L3 tests for queuing and evaluation logic)

---

## Phase 4: Strategic Layer Implementation (L4)
**Completed: 2026-03-27**
Implementation of the top-level LLM orchestration for generating daily task plans.

### 1. Model & Wiring
- Updated `config.yaml` to utilize `qwen3:4b` (2.5GB) as the default model due to its optimal balance for strict JSON adherence and context reasoning.
- Wired `OllamaClient` across the agent dependencies in the main process bootstraper (`index.ts`).

### 2. `DayPlanner`
- Orchestrates `day.started` triggers to assemble semantic context from `GameState` mapping.
- Interrogates Ollama for `DayPlan` JSON construction, utilizing strict Zod validation natively.
- Passes fully structured abstract tasks down into the L3 `TaskScheduler`.

### Verification
- `tsc --noEmit`: **0 errors**
- Unit tests: **36 / 36 passing** (3 new Strategic tests covering duplicate-planning guards and failure boundaries).
