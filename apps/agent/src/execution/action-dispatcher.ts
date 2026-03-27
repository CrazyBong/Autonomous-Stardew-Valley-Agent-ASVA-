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
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type DispatcherState = 'IDLE' | 'PATHING' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED';

/** Maximum consecutive dispatch failures before a task is marked 'failed'. */
const MAX_TASK_ATTEMPTS = 3;

/** Ticks we wait for the game to confirm an action before considering it stalled. */
const ACTION_TIMEOUT_TICKS = 20; // 20 × 50ms = 1s

/** Tool type required for each task type. */
const TASK_TOOL_MAP: Partial<Record<string, string>> = {
  WATER_CROP: 'WateringCan',
  HARVEST_CROP: 'Scythe',
  TILL_SOIL: 'Hoe',
  PLANT_SEED: undefined,  // Bare-hand planting via inventory slot selection
  MINE_ROCKS: 'Pickaxe',
  COMBAT: 'Sword',
  FISH: 'FishingRod',
  FORAGE: undefined,
};

/** Maps TaskType to the target coordinates field in task.parameters. */
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

  /** Remaining path steps (tile positions to walk through). */
  private pendingPath: Array<{ x: number; y: number; map: string }> = [];

  /** Remaining action queue for the current interaction (equip → use → confirm). */
  private actionQueue: GameAction[] = [];

  /** Ticks since last action was dispatched (stall detection). */
  private stallCounter = 0;

  constructor(
    private readonly bridge: SMAPIBridge,
    private readonly eventBus: EventBus,
    private readonly observability: ObservabilityService,
    private readonly pathfinder: Pathfinder,
    private readonly inventoryManager: InventoryManager,
    private readonly logger: Logger
  ) {}

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Returns the current execution state. */
  public getState(): DispatcherState { return this.state; }

  /** Returns true if the dispatcher is idle and ready to accept a new task. */
  public isIdle(): boolean { return this.state === 'IDLE'; }

  /** Returns true if the current task is blocked (FAILED) and needs replanning. */
  public isBlocked(): boolean { return this.state === 'FAILED'; }

  /** Returns the current task being executed (if any). */
  public getCurrentTask(): Task | null { return this.currentTask; }

  /**
   * Loads a new task for execution. Replaces any current task.
   * Call only when `isIdle()` is true, or after explicitly calling `clearTask()`.
   */
  public loadTask(task: Task): void {
    this.logger.info({ taskId: task.id, taskType: task.type }, 'ActionDispatcher: loading task');
    this.currentTask = { ...task, status: 'running', attemptCount: task.attemptCount + 1 };
    this.pendingPath = [];
    this.actionQueue = [];
    this.stallCounter = 0;
    this.state = 'PATHING';
  }

  /** Clears the current task and resets to IDLE. */
  public clearTask(): void {
    this.currentTask = null;
    this.pendingPath = [];
    this.actionQueue = [];
    this.state = 'IDLE';
  }

  /**
   * Called every agent tick. Drives the state machine one step forward.
   *
   * - In PATHING: Computes or advances the A* path to the task target.
   * - In EXECUTING: Dispatches the next queued GameAction to the bridge.
   * - In SUCCEEDED/FAILED: Emits an event and transitions to IDLE.
   */
  public async executeTick(state: GameStateSnapshot, grid: TileGrid): Promise<void> {
    if (!this.currentTask) return;

    switch (this.state) {
      case 'PATHING':    await this.tickPathing(state, grid); break;
      case 'EXECUTING':  await this.tickExecuting(state);     break;
      case 'SUCCEEDED':  this.handleSucceeded();               break;
      case 'FAILED':     this.handleFailed();                  break;
    }
  }

  // ── State Machine ─────────────────────────────────────────────────────────

  /** Builds or advances the path to the task's target tile. */
  private async tickPathing(state: GameStateSnapshot, grid: TileGrid): Promise<void> {
    if (!this.currentTask) return;

    const paramMap = TASK_TARGET_PARAM[this.currentTask.type];
    const params = this.currentTask.parameters;

    // Tasks with no tile target (SLEEP, TALK_TO_NPC by name) skip pathing
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
      this.fail('MISSING_TARGET_PARAMS');
      return;
    }

    const start = state.player.position;
    const target = { x: targetX, y: targetY, map: targetMap };

    // Already adjacent to or on target — go straight to action execution
    if (this.isAdjacentOrEqual(start, target)) {
      this.pendingPath = [];
      this.state = 'EXECUTING';
      this.buildActionQueue(state);
      return;
    }

    // Cross-map routing: emit a warp intent and let the bridge handle it
    if (start.map !== targetMap) {
      this.logger.info({ from: start.map, to: targetMap }, 'ActionDispatcher: cross-map warp needed');
      this.actionQueue = [{ type: 'ACTION_MOVE', payload: { targetX, targetY, map: targetMap } }];
      this.state = 'EXECUTING';
      return;
    }

    // A* pathfinding on current map
    const result = this.pathfinder.findPath(start, target, grid);
    if (!result) {
      this.logger.warn({ start, target }, 'ActionDispatcher: pathfinding failed — task blocked');
      this.fail('PATH_NOT_FOUND');
      return;
    }

    if (result.steps.length === 0) {
      // Already there
      this.state = 'EXECUTING';
      this.buildActionQueue(state);
      return;
    }

    this.pendingPath = [...result.steps];
    this.logger.debug({ steps: result.steps.length, cost: result.cost }, 'ActionDispatcher: path computed');
    this.state = 'EXECUTING';
    // Action queue is built from the path + interaction actions
    this.buildActionQueueFromPath(state);
  }

  /** Dispatches the next queued action to the bridge. */
  private async tickExecuting(state: GameStateSnapshot): Promise<void> {
    if (!this.currentTask) return;

    // Stall detection
    this.stallCounter++;
    if (this.stallCounter > ACTION_TIMEOUT_TICKS && this.actionQueue.length > 0) {
      this.logger.warn(
        { stallTicks: this.stallCounter, taskId: this.currentTask.id },
        'ActionDispatcher: action stalled — retrying'
      );
      this.stallCounter = 0;
      // Re-try the same action by not popping — just re-dispatch
    }

    if (this.actionQueue.length === 0) {
      // All actions dispatched — mark as succeeded
      this.logger.info({ taskId: this.currentTask.id }, 'ActionDispatcher: task succeeded');
      this.state = 'SUCCEEDED';
      return;
    }

    const action = this.actionQueue.shift()!;
    this.stallCounter = 0;

    try {
      await this.bridge.dispatch(action);
      this.observability.recordBusinessEvent('action.dispatched', {
        taskId: this.currentTask.id,
        actionType: action.type,
      });
    } catch (error) {
      this.logger.warn({ action, error }, 'ActionDispatcher: dispatch failed');
      const attempts = this.currentTask.attemptCount;
      if (attempts >= MAX_TASK_ATTEMPTS) {
        this.fail('DISPATCH_FAILED');
      } else {
        // Re-queue action for retry next tick
        this.actionQueue.unshift(action);
      }
    }

    // Unused state parameter on purpose — may be used for future success validation
    void state;
  }

  private handleSucceeded(): void {
    if (!this.currentTask) return;
    const task = this.currentTask;
    this.eventBus.emit('task.completed', { taskId: task.id, type: task.type });
    this.clearTask();
  }

  private handleFailed(): void {
    if (!this.currentTask) return;
    const task = this.currentTask;
    this.logger.error({ taskId: task.id, lastError: task.lastError }, 'ActionDispatcher: task failed');
    this.eventBus.emit('task.failed', {
      taskId: task.id,
      type: task.type,
      reason: task.lastError ?? ErrorCodes.UNKNOWN,
      attemptCount: task.attemptCount,
    });
    this.clearTask();
  }

  // ── Action Queue Builders ─────────────────────────────────────────────────

  /**
   * Builds the action queue for direct interaction (no path steps needed).
   * Order: [equip tool if needed] → [use tool at target]
   */
  private buildActionQueue(state: GameStateSnapshot): void {
    if (!this.currentTask) return;
    const actions: GameAction[] = [];

    // Handle special task types first
    if (this.currentTask.type === 'SLEEP') {
      actions.push({ type: 'ACTION_SLEEP' });
      this.actionQueue = actions;
      return;
    }

    const toolType = TASK_TOOL_MAP[this.currentTask.type];
    if (toolType && !this.inventoryManager.isEquipped(state, toolType)) {
      const equipAction = this.inventoryManager.buildEquipAction(state, toolType);
      if (equipAction) actions.push(equipAction);
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
   * Builds an action queue from a computed path + the interaction action at the end.
   * Each path step becomes an ACTION_MOVE, then the interaction follows.
   */
  private buildActionQueueFromPath(state: GameStateSnapshot): void {
    if (!this.currentTask) return;
    const moveActions: GameAction[] = this.pendingPath.map((pos) => ({
      type: 'ACTION_MOVE' as const,
      payload: { targetX: pos.x, targetY: pos.y, map: pos.map },
    }));

    // Append interaction actions after the move sequence
    const interactionQueue: GameAction[] = [];
    const toolType = TASK_TOOL_MAP[this.currentTask.type];
    if (toolType && !this.inventoryManager.isEquipped(state, toolType)) {
      const equipAction = this.inventoryManager.buildEquipAction(state, toolType);
      if (equipAction) interactionQueue.push(equipAction);
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

  private isAdjacentOrEqual(
    a: { x: number; y: number },
    b: { x: number; y: number }
  ): boolean {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1;
  }

  private fail(reason: string): void {
    if (!this.currentTask) return;
    this.currentTask = { ...this.currentTask, status: 'failed', lastError: reason };
    this.state = 'FAILED';
  }
}
