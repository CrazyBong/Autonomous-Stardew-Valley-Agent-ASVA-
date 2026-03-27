import type { Logger } from 'pino';
import type { GameStateSnapshot, Task, GameAction } from '@asva/shared-types';
import type { SMAPIBridge } from '../infrastructure/smapi-bridge.js';
import type { EventBus } from '../cross-cutting/event-bus.js';
import type { ObservabilityService } from '../cross-cutting/observability-service.js';
import type { Pathfinder, TileGrid } from './pathfinder.js';
import type { InventoryManager } from './inventory-manager.js';
import { ErrorCodes } from '../cross-cutting/app-error.js';

/**
 * ActionDispatcher — L2 Execution Layer.
 *
 * Translates abstract `Task` objects (from the Tactical Layer) into concrete
 * `GameAction` sequences and dispatches them to the SMAPI bridge one-per-tick.
 *
 * Spec Section 4 (L2 module responsibilities):
 *  - Manages action retry logic, timeout detection, success validation.
 *  - Single responsibility: bridge tasks to bridge actions.
 *
 * State machine per Task:
 *  IDLE → PATHING → EXECUTING → [SUCCEEDED | FAILED]
 *
 * NOTE on FAILED:
 *  `fail()` emits `task.failed` and `task.replan` synchronously before clearing
 *  state. The FAILED branch in the switch is therefore a defensive guard only
 *  (idempotent cleanup if state somehow lingers). Agent.ts does NOT check
 *  `isBlocked()` after executeTick() — all failure signalling goes through EventBus.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type DispatcherState = 'IDLE' | 'PATHING' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED';

/** Maximum times a single Task may be attempted before permanently failing. */
const MAX_TASK_ATTEMPTS = 3;

/**
 * Ticks of inactivity (no successful dispatch) before the action is considered
 * stalled and a hard retry of the entire task is forced.
 * At 50 ms/tick this equals 1 second.
 */
const STALL_TIMEOUT_TICKS = 20;

/** Tool type required for each task type. */
const TASK_TOOL_MAP: Partial<Record<string, string>> = {
  WATER_CROP:   'WateringCan',
  HARVEST_CROP: 'Scythe',
  TILL_SOIL:    'Hoe',
  PLANT_SEED:   undefined, // Bare-hand / seed bag selection in future impl
  MINE_ROCKS:   'Pickaxe',
  COMBAT:       'Sword',
  FISH:         'FishingRod',
  FORAGE:       undefined,
};

/** Maps TaskType to the coordinate parameter keys in task.parameters. */
const TASK_TARGET_PARAM: Partial<Record<string, { x: string; y: string; map: string }>> = {
  WATER_CROP:   { x: 'tileX', y: 'tileY', map: 'map' },
  TILL_SOIL:    { x: 'tileX', y: 'tileY', map: 'map' },
  HARVEST_CROP: { x: 'tileX', y: 'tileY', map: 'map' },
  PLANT_SEED:   { x: 'tileX', y: 'tileY', map: 'map' },
  MINE_ROCKS:   { x: 'tileX', y: 'tileY', map: 'map' },
  FORAGE:       { x: 'tileX', y: 'tileY', map: 'map' },
  MOVE:         { x: 'targetX', y: 'targetY', map: 'map' },
};

// ── ActionDispatcher ──────────────────────────────────────────────────────────

export class ActionDispatcher {
  private state: DispatcherState = 'IDLE';
  private currentTask: Task | null = null;

  /** Pending path steps (tile positions from start to target, exclusive of start). */
  private pendingPath: Array<{ x: number; y: number; map: string }> = [];

  /** Ordered GameAction queue for the current interaction phase. */
  private actionQueue: GameAction[] = [];

  /**
   * Counts ticks elapsed since the last SUCCESSFUL bridge.dispatch() call.
   * Incremented every EXECUTING tick; reset to 0 on success.
   * When it exceeds STALL_TIMEOUT_TICKS the current action is treated as stalled.
   */
  private stallTicks = 0;

  /**
   * Per-action dispatch failure counter.
   * Reset to 0 on each new action shift; incremented on each dispatch error.
   * When it reaches MAX_TASK_ATTEMPTS the task is permanently failed.
   */
  private dispatchFailures = 0;

  constructor(
    private readonly bridge: SMAPIBridge,
    private readonly eventBus: EventBus,
    private readonly observability: ObservabilityService,
    private readonly pathfinder: Pathfinder,
    private readonly inventoryManager: InventoryManager,
    private readonly logger: Logger
  ) {}

  // ── Public API ───────────────────────────────────────────────────────────────

  public getState(): DispatcherState { return this.state; }
  public isIdle(): boolean { return this.state === 'IDLE'; }
  /** @deprecated Agent.ts no longer polls this — events are emitted by fail(). Kept for tests. */
  public isBlocked(): boolean { return this.state === 'FAILED'; }
  public getCurrentTask(): Task | null { return this.currentTask; }

  /**
   * Loads a new task for execution.
   * Asserts dispatcher is IDLE; caller must ensure this.
   */
  public loadTask(task: Task): void {
    this.logger.info({ taskId: task.id, taskType: task.type }, 'ActionDispatcher: loading task');
    this.currentTask = {
      ...task,
      status: 'running',
      attemptCount: (task.attemptCount ?? 0) + 1,
    };
    this.pendingPath = [];
    this.actionQueue = [];
    this.stallTicks = 0;
    this.dispatchFailures = 0;
    this.state = 'PATHING';
  }

  /** Resets the dispatcher to IDLE without emitting any events. */
  public clearTask(): void {
    this.currentTask = null;
    this.pendingPath = [];
    this.actionQueue = [];
    this.stallTicks = 0;
    this.dispatchFailures = 0;
    this.state = 'IDLE';
  }

  /**
   * Advances the state machine by one tick.
   * SUCCEEDED and FAILED branches handle their own cleanup via EventBus — no
   * external polling of `isBlocked()` is required.
   */
  public async executeTick(state: GameStateSnapshot, grid: TileGrid): Promise<void> {
    if (!this.currentTask) return;

    switch (this.state) {
      case 'PATHING':   await this.tickPathing(state, grid); break;
      case 'EXECUTING': await this.tickExecuting(state);     break;
      case 'SUCCEEDED': this.handleSucceeded();              break;
      case 'FAILED':    this.handleFailed();                 break;
    }
  }

  // ── State: PATHING ────────────────────────────────────────────────────────

  private async tickPathing(state: GameStateSnapshot, grid: TileGrid): Promise<void> {
    if (!this.currentTask) return;

    const paramMap = TASK_TARGET_PARAM[this.currentTask.type];
    const params = this.currentTask.parameters;

    // Tasks with no tile target (SLEEP, GIFT_NPC by name, etc.) skip pathing
    if (!paramMap || params['skipPath']) {
      this.state = 'EXECUTING';
      this.buildActionQueue(state);
      return;
    }

    const targetX = params[paramMap.x] as number | undefined;
    const targetY = params[paramMap.y] as number | undefined;
    const targetMap = (params[paramMap.map] as string | undefined) ?? state.player.position.map;

    if (targetX === undefined || targetY === undefined) {
      this.logger.error(
        { taskId: this.currentTask.id, params },
        'ActionDispatcher: task missing target coordinates'
      );
      this.fail(ErrorCodes.MISSING_TARGET_PARAMS);
      return;
    }

    const start = state.player.position;
    const target = { x: targetX, y: targetY, map: targetMap };

    // FIX: adjacency check must also verify same map — tiles (0,0) on different
    // maps must NOT be treated as adjacent, as it would skip a required warp.
    const sameMaP = start.map === targetMap;
    if (sameMaP && this.isAdjacentOrEqual(start, target)) {
      this.pendingPath = [];
      this.state = 'EXECUTING';
      this.buildActionQueue(state);
      return;
    }

    // Cross-map: emit a single high-level move; bridge resolves warp transitions
    if (!sameMaP) {
      this.logger.info({ from: start.map, to: targetMap }, 'ActionDispatcher: cross-map warp needed');
      this.actionQueue = [{ type: 'ACTION_MOVE', payload: { targetX, targetY, map: targetMap } }];
      this.state = 'EXECUTING';
      return;
    }

    // A* on same map
    const result = this.pathfinder.findPath(start, target, grid);
    if (!result) {
      this.logger.warn({ start, target }, 'ActionDispatcher: pathfinding failed');
      this.fail(ErrorCodes.PATH_NOT_FOUND);
      return;
    }

    if (result.steps.length === 0) {
      // A* returned empty — already at target
      this.state = 'EXECUTING';
      this.buildActionQueue(state);
      return;
    }

    this.pendingPath = [...result.steps];
    this.logger.debug({ steps: result.steps.length, cost: result.cost }, 'ActionDispatcher: path computed');
    this.state = 'EXECUTING';
    this.buildActionQueueFromPath(state);
  }

  // ── State: EXECUTING ──────────────────────────────────────────────────────

  private async tickExecuting(state: GameStateSnapshot): Promise<void> {
    if (!this.currentTask) return;

    // ── Stall detection ──────────────────────────────────────────────────────
    // stallTicks is only reset on a SUCCESSFUL dispatch (below).
    // If it exceeds the threshold the current action is considered unresponsive.
    this.stallTicks++;
    if (this.stallTicks > STALL_TIMEOUT_TICKS && this.actionQueue.length > 0) {
      this.logger.warn(
        { stallTicks: this.stallTicks, task: this.currentTask.id },
        'ActionDispatcher: action stalled — forcing failure'
      );
      // Treat a stalled action the same as a dispatch error so the retry/fail
      // path is shared and bounded by MAX_TASK_ATTEMPTS.
      this.dispatchFailures++;
      this.stallTicks = 0;
      if (this.dispatchFailures >= MAX_TASK_ATTEMPTS) {
        this.fail(ErrorCodes.TASK_DISPATCH_FAILED);
        return;
      }
      // Drop the stalled action and proceed with the next one
      this.actionQueue.shift();
    }

    if (this.actionQueue.length === 0) {
      this.logger.info({ taskId: this.currentTask.id }, 'ActionDispatcher: task succeeded');
      this.state = 'SUCCEEDED';
      return;
    }

    // Peek — do NOT shift yet; shift only after success so a failed action stays
    // at the front and can be retried or counted against the cap.
    const action = this.actionQueue[0]!;

    try {
      await this.bridge.dispatch(action);
      // Success — consume the action and reset both counters
      this.actionQueue.shift();
      this.stallTicks = 0;
      this.dispatchFailures = 0;
      this.observability.recordBusinessEvent('action.dispatched', {
        taskId: this.currentTask.id,
        actionType: action.type,
      });
    } catch (error) {
      this.logger.warn({ action, error }, 'ActionDispatcher: dispatch failed');
      this.dispatchFailures++;
      this.stallTicks = 0; // reset stall — we got a real error, not silence
      if (this.dispatchFailures >= MAX_TASK_ATTEMPTS) {
        this.fail(ErrorCodes.TASK_DISPATCH_FAILED);
      }
      // If under the cap: leave action at front for retry next tick
    }

    void state; // may be used for post-dispatch state validation in future
  }

  // ── State: SUCCEEDED / FAILED ─────────────────────────────────────────────

  private handleSucceeded(): void {
    if (!this.currentTask) return;
    const task = this.currentTask;
    this.clearTask();
    // Emit AFTER clearTask so subscribers see IDLE state if they re-check
    this.eventBus.emit('task.completed', { taskId: task.id, type: task.type });
  }

  /**
   * Defensive guard — only reached if executeTick() is called while state=FAILED
   * without a `fail()` having already cleared it. Emits the failure events and
   * transitions to IDLE (idempotent w.r.t. a second `fail()` call).
   */
  private handleFailed(): void {
    if (!this.currentTask) { this.state = 'IDLE'; return; }
    const task = this.currentTask;
    this.clearTask();
    this.eventBus.emit('task.failed', {
      taskId: task.id,
      type: task.type,
      reason: task.lastError ?? ErrorCodes.UNKNOWN,
      attemptCount: task.attemptCount,
    });
  }

  // ── Action Queue Builders ─────────────────────────────────────────────────

  /**
   * Builds the action queue for a task already at or adjacent to its target.
   * Order: [equip tool if needed] → [use tool / place item / etc.]
   *
   * If a required tool is not in the inventory, the task is immediately failed
   * rather than silently continuing without the tool.
   */
  private buildActionQueue(state: GameStateSnapshot): void {
    if (!this.currentTask) return;
    const actions: GameAction[] = [];

    if (this.currentTask.type === 'SLEEP') {
      this.actionQueue = [{ type: 'ACTION_SLEEP' }];
      return;
    }

    const toolType = TASK_TOOL_MAP[this.currentTask.type];
    if (toolType && !this.inventoryManager.isEquipped(state, toolType)) {
      const equipAction = this.inventoryManager.buildEquipAction(state, toolType);
      if (!equipAction) {
        // FIX: silently skipping was wrong — fail hard so replan can fetch the tool.
        this.logger.error(
          { taskType: this.currentTask.type, toolType },
          'ActionDispatcher: required tool not in inventory — failing task'
        );
        this.fail(ErrorCodes.TASK_EXECUTION_FAILED);
        return;
      }
      actions.push(equipAction);
    }

    const paramMap = TASK_TARGET_PARAM[this.currentTask.type];
    if (paramMap) {
      const params = this.currentTask.parameters;
      const x = params[paramMap.x] as number | undefined;
      const y = params[paramMap.y] as number | undefined;
      if (x !== undefined && y !== undefined) {
        actions.push({ type: 'ACTION_USE_TOOL', payload: { x, y } });
      }
    }

    this.actionQueue = actions;
  }

  /**
   * Builds an action queue from a computed A* path followed by the interaction.
   * Each path step → ACTION_MOVE, then equip + use actions follow.
   */
  private buildActionQueueFromPath(state: GameStateSnapshot): void {
    if (!this.currentTask) return;

    const moveActions: GameAction[] = this.pendingPath.map((pos) => ({
      type: 'ACTION_MOVE' as const,
      payload: { targetX: pos.x, targetY: pos.y, map: pos.map },
    }));

    const interactionQueue: GameAction[] = [];
    const toolType = TASK_TOOL_MAP[this.currentTask.type];
    if (toolType && !this.inventoryManager.isEquipped(state, toolType)) {
      const equipAction = this.inventoryManager.buildEquipAction(state, toolType);
      if (!equipAction) {
        this.logger.error(
          { taskType: this.currentTask.type, toolType },
          'ActionDispatcher: required tool not in inventory — failing task'
        );
        this.fail(ErrorCodes.TASK_EXECUTION_FAILED);
        return;
      }
      interactionQueue.push(equipAction);
    }

    const paramMap = TASK_TARGET_PARAM[this.currentTask.type];
    if (paramMap) {
      const params = this.currentTask.parameters;
      const x = params[paramMap.x] as number | undefined;
      const y = params[paramMap.y] as number | undefined;
      if (x !== undefined && y !== undefined) {
        interactionQueue.push({ type: 'ACTION_USE_TOOL', payload: { x, y } });
      }
    }

    this.actionQueue = [...moveActions, ...interactionQueue];
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Tile adjacency check (same-map only; cross-map is handled by the caller). */
  private isAdjacentOrEqual(
    a: { x: number; y: number },
    b: { x: number; y: number }
  ): boolean {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1;
  }

  /**
   * Marks the current task as failed and immediately emits `task.failed` and
   * `task.replan` events, then clears state.
   *
   * Emitting eagerly here (rather than in handleFailed()) ensures the events
   * are never swallowed by the agent's isBlocked() guard in agent.ts.
   */
  private fail(reason: string): void {
    if (!this.currentTask) return;
    const task = { ...this.currentTask, status: 'failed' as const, lastError: reason };
    this.logger.error({ taskId: task.id, reason }, 'ActionDispatcher: task failed');

    this.clearTask(); // → IDLE before emitting so subscribers see correct state
    this.eventBus.emit('task.failed', {
      taskId: task.id,
      type: task.type,
      reason,
      attemptCount: task.attemptCount,
    });
    this.eventBus.emit('task.replan', {
      state: null as unknown as GameStateSnapshot, // state unavailable here; agent loop re-supplies
      blockedTask: task,
    });
  }
}
