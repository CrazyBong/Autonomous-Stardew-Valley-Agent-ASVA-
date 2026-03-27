import type { Logger } from 'pino';
import type { Task, GameStateSnapshot } from '@asva/shared-types';
import type { EventBus } from '../cross-cutting/event-bus.js';
import type { TaskScheduler } from './task-scheduler.js';

/**
 * ReplanEngine — L3 Error Recovery.
 *
 * Subscribes to `task.replan` events emitted by the ActionDispatcher (L2) when
 * a Task permanently fails execution (e.g. path blocked, tool missing, stalled).
 *
 * Analyzes the failure reason and the current GameState, then dynamically
 * generates corrective tasks (or drops the unachievable task) and injects
 * them into the TaskScheduler to resume execution smoothly.
 */
export class ReplanEngine {
  constructor(
    private readonly eventBus: EventBus,
    private readonly scheduler: TaskScheduler,
    private readonly logger: Logger
  ) {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.eventBus.on('task.replan', this.handleTaskReplan.bind(this));
  }

  private handleTaskReplan(payload: { state: GameStateSnapshot | null; blockedTask: Task }): void {
    const { state, blockedTask } = payload;
    this.logger.warn(
      { taskId: blockedTask.id, reason: blockedTask.lastError },
      'ReplanEngine: analyzing blocked task'
    );

    // If state is completely unavailable, recovery is impossible. Drop task.
    if (!state) {
      this.logger.error({}, 'ReplanEngine: gameState is null — cannot replan. Dropping task.');
      // By doing nothing, the Agent tick loop will just see idle and request the next task.
      return;
    }

    const nextTasks = this.analyzeFailure(blockedTask, state);

    if (nextTasks.length > 0) {
      this.logger.info({ newTasks: nextTasks.length }, 'ReplanEngine: injecting corrective tasks');
      this.scheduler.injectTasks(nextTasks);
    } else {
      this.logger.info({}, 'ReplanEngine: no corrective action found. Task dropped.');
    }

    // Since the task failed and was cleared from the dispatcher, the dispatcher is IDLE.
    // In agent.ts, the RISING EDGE of IDLE will fire `task.requested` naturally,
    // so the scheduler will instantly pick up the newly injected tasks (or the next normal task).
  }

  /**
   * Evaluates the blocked task to formulate a recovery plan.
   * Returns an array of tasks to be injected at the FRONT of the queue.
   */
  private analyzeFailure(failedTask: Task, state: GameStateSnapshot): Task[] {
    const error = failedTask.lastError;

    // TODO (Phase 3+): Add heuristic recovery rules based on failure type.
    // Example: OUT_OF_ENERGY -> Inject EAT_FOOD.
    // Example: OUT_OF_WATER -> Inject REFILL_WATERING_CAN.
    
    switch (error) {
      case 'PATH_NOT_FOUND':
        // Path blocked. Drop task and move on for now.
        return [];
        
      case 'TASK_EXECUTION_FAILED':
        // Typically triggered if a required tool isn't in inventory at all.
        // Recovery would mean navigating to a chest, but we don't have chest routing yet.
        return [];

      default:
        // Unknown error — drop to prevent infinite crash loops.
        void state;
        return [];
    }
  }

  // /** 
  //  * Helper to build ad-hoc recovery tasks.
  //  * Uncomment when specific recoveries (like REFILL_CAN) are implemented.
  //  */
  // private buildRecoveryTask(type: Task['type'], priority: number, parameters: Record<string, unknown> = {}): Task {
  //   return {
  //     id: randomUUID(),
  //     type,
  //     priority,
  //     estimatedDurationTicks: 100, // Safe default
  //     energyCost: 0,
  //     prerequisites: [],
  //     parameters,
  //     status: 'pending',
  //     attemptCount: 0,
  //     createdAt: new Date().toISOString(),
  //   };
  // }
}
