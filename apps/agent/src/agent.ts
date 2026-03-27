import type { Logger } from 'pino';
import type { GameStateSnapshot, Task } from '@asva/shared-types';
import type { SMAPIBridge } from './infrastructure/smapi-bridge.js';
import type { EventBus } from './cross-cutting/event-bus.js';
import type { ErrorBoundary } from './cross-cutting/error-boundary.js';
import type { ObservabilityService } from './cross-cutting/observability-service.js';
import type { StateRepository } from './infrastructure/state-repository.js';
import type { MemoryStore } from './infrastructure/memory-store.js';
import type { TileGrid } from './execution/index.js';
import { ActionDispatcher } from './execution/index.js';
import { Pathfinder } from './execution/index.js';
import { InventoryManager } from './execution/index.js';

/**
 * Agent — main decision loop.
 * Implements the main cycle from spec Section 3 (Decision Loop — Main Cycle).
 *
 * L2 Execution Layer (Phase 2): The tick now drives the ActionDispatcher,
 * which sequences move/equip/use actions toward the current Task target.
 *
 * L3/L4 Tactical/Strategic layers are wired in Phase 3-4 via EventBus:
 *  - 'task.requested' → TaskScheduler provides next Task
 *  - 'task.failed'    → ReplanEngine handles blocked tasks
 *  - 'day.started'    → DayPlanner triggers LLM day plan call
 */
export class Agent {
  private running = false;
  private paused = false;
  private stopResolver: (() => void) | null = null;
  private readonly tickIntervalMs: number;

  // ── L2 Execution Layer ──────────────────────────────────────────────────
  private readonly pathfinder: Pathfinder;
  private readonly inventoryManager: InventoryManager;
  private readonly dispatcher: ActionDispatcher;

  /** Sparse tile-walkability grid supplied by the bridge on each state update. */
  private tileGrid: TileGrid = [];

  constructor(
    private readonly bridge: SMAPIBridge,
    private readonly eventBus: EventBus,
    private readonly errorBoundary: ErrorBoundary,
    private readonly observability: ObservabilityService,
    private readonly stateRepository: StateRepository,
    private readonly memoryStore: MemoryStore,
    private readonly logger: Logger,
    tickIntervalMs = 50
  ) {
    this.tickIntervalMs = tickIntervalMs;

    // Instantiate execution layer
    this.pathfinder = new Pathfinder(logger);
    this.inventoryManager = new InventoryManager(logger);
    this.dispatcher = new ActionDispatcher(
      bridge,
      eventBus,
      observability,
      this.pathfinder,
      this.inventoryManager,
      logger
    );

    this.logger.debug(
      { hasStateRepo: !!this.stateRepository, hasMemoryStore: !!this.memoryStore },
      'Agent initialized with L1 + L2 layers'
    );

    // ── EventBus wiring ──────────────────────────────────────────────────

    // Safe-pause / resume
    this.eventBus.on('agent.safe-pause', ({ reason }) => {
      this.logger.error({ reason }, 'Agent entering safe pause');
      this.paused = true;
    });
    this.eventBus.on('agent.resumed', () => {
      this.logger.info({}, 'Agent resuming from pause');
      this.paused = false;
    });

    // L3 Tactical Layer hook (Phase 3): accepts the next Task from the scheduler
    this.eventBus.on('task.next', ({ task }: { task: Task }) => {
      if (!this.dispatcher.isIdle()) return;
      this.dispatcher.loadTask(task);
    });

    // Tile grid updates from bridge (sent alongside game state)
    this.eventBus.on('bridge.tileGridUpdated', ({ grid }: { grid: TileGrid }) => {
      this.tileGrid = grid;
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Starts the agent loop. Resolves only when stop() is called. */
  public async run(): Promise<void> {
    if (this.running) {
      this.logger.warn({}, 'Agent.run() called while already running — ignoring');
      return;
    }

    this.running = true;
    this.logger.info({ tickIntervalMs: this.tickIntervalMs }, 'Agent loop started');

    try {
      while (this.running) {
        if (!this.paused) {
          await this.errorBoundary.execute(
            () => this.tick(),
            { component: 'AgentLoop' }
          );
        }
        await this.sleep(this.tickIntervalMs);
      }
    } finally {
      this.running = false;
      this.logger.info({}, 'Agent loop stopped');
      if (this.stopResolver) this.stopResolver();
    }
  }

  /** Stops the agent loop; resolves when the current tick finishes. */
  public async stop(): Promise<void> {
    if (!this.running) return;
    return new Promise((resolve) => {
      this.stopResolver = resolve;
      this.running = false;
    });
  }

  public pause(): void {
    this.paused = true;
    this.logger.info({}, 'Agent paused by API request');
  }

  public resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.eventBus.emit('agent.resumed', {});
  }

  public isPaused(): boolean { return this.paused; }

  // ── Main Tick ─────────────────────────────────────────────────────────────

  /**
   * Single agent tick (Phase 2).
   *
   * Cycle:
   *  1. Pull latest game state from bridge.
   *  2. Advance the ActionDispatcher one step (path / execute / confirm).
   *  3. If dispatcher is IDLE, request next task from the Tactical Layer.
   *  4. If dispatcher is BLOCKED, emit a replan request.
   *  5. Emit metrics snapshot.
   */
  private async tick(): Promise<void> {
    if (!this.bridge.isConnected()) return;

    const state: GameStateSnapshot = this.bridge.getLatestState();

    // 1. Advance the execution state machine
    await this.dispatcher.executeTick(state, this.tileGrid);

    // 2. If idle and no task, ask the Tactical Layer for the next task
    if (this.dispatcher.isIdle()) {
      this.eventBus.emit('task.requested', { state });
    }

    // 3. If blocked, escalate to Replan Engine (Phase 3)
    if (this.dispatcher.isBlocked()) {
      const blockedTask = this.dispatcher.getCurrentTask();
      if (blockedTask) {
        this.logger.warn({ taskId: blockedTask.id }, 'Agent: task blocked — requesting replan');
        this.eventBus.emit('task.replan', { state, blockedTask });
        this.dispatcher.clearTask(); // clear so loop doesn't tight-spin
      }
    }

    // 4. Metrics
    this.observability.recordMetrics({
      tick: state.tick,
      gameDay: state.gameDay,
      connected: true,
      paused: this.paused,
      dispatcherState: this.dispatcher.getState(),
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

