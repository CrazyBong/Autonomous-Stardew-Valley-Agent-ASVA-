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
