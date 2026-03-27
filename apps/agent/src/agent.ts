import type { Logger } from 'pino';
import type { GameStateSnapshot } from '@asva/shared-types';
import type { SMAPIBridge } from './infrastructure/smapi-bridge.js';
import type { EventBus } from './cross-cutting/event-bus.js';
import type { ErrorBoundary } from './cross-cutting/error-boundary.js';
import type { ObservabilityService } from './cross-cutting/observability-service.js';
import type { StateRepository } from './infrastructure/state-repository.js';

import type { MemoryStore } from './infrastructure/memory-store.js';

/**
 * Agent — main decision loop.
 * Implements the main cycle from spec Section 3 (Decision Loop — Main Cycle).
 *
 * LLM planning is handled by the Tactical/Strategic layers that subscribe
 * to EventBus events. This loop is purely deterministic: pull state,
 * dispatch next action, yield.
 */
export class Agent {
  private running = false;
  private paused = false;
  private stopResolver: (() => void) | null = null;
  private readonly tickIntervalMs: number;

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

    this.logger.debug({
      hasStateRepo: !!this.stateRepository,
      hasMemoryStore: !!this.memoryStore
    }, 'Agent initialized with L1 repositories');

    // Register safe-pause handler
    this.eventBus.on('agent.safe-pause', ({ reason }) => {
      this.logger.error({ reason }, 'Agent entering safe pause');
      this.paused = true;
    });

    this.eventBus.on('agent.resumed', () => {
      this.logger.info({}, 'Agent resuming from pause');
      this.paused = false;
    });
  }

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

  /**
   * Stops the agent loop and resolves when the current tick finishes.
   */
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

  public isPaused(): boolean {
    return this.paused;
  }

  // ── Main Tick ─────────────────────────────────────────────────────────────

  /**
   * Single agent tick — runs every TICK_INTERVAL_MS.
   * Phase 1: skeleton only. Execution and Planning layers wired in Phase 2-4.
   */
  private async tick(): Promise<void> {
    if (!this.bridge.isConnected()) return;

    const _state: GameStateSnapshot = this.bridge.getLatestState();

    // L2 Execution and L3/L4 Tactical/Strategic logic wired here in Phase 2-4.
    // For Phase 1, the loop keeps alive and forwards events correctly.
    this.observability.recordMetrics({
      tick: _state.tick,
      gameDay: _state.gameDay,
      connected: true,
      paused: this.paused,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
