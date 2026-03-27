import type { Logger } from 'pino';
import type { Task, DayPlan, GameStateSnapshot } from '@asva/shared-types';
import type { EventBus } from '../cross-cutting/event-bus.js';
import type { TaskExpander } from './task-expander.js';

/**
 * TaskScheduler — L3 Tactical Queue Manager.
 *
 * Maintains the sequence of Tasks to be executed for the day.
 * - Subscribes to `task.requested` from L2, emitting `task.next` with the next task.
 * - Translates L4 `DayPlan` into granular L2 Tasks via `TaskExpander`.
 * - Allows the `ReplanEngine` to inject corrective tasks at the front of the queue.
 */
export class TaskScheduler {
  private queue: Task[] = [];
  private completedTaskIds: Set<string> = new Set();
  
  constructor(
    private readonly eventBus: EventBus,
    private readonly taskExpander: TaskExpander,
    private readonly logger: Logger
  ) {
    this.registerHandlers();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Loads a new high-level plan from the Strategic Layer (L4).
   * Expands all TaskBlocks into granular Tasks and queues them.
   */
  public loadDayPlan(plan: DayPlan, state: GameStateSnapshot): void {
    this.logger.info({ planId: plan.id, tasks: plan.tasks.length }, 'TaskScheduler: loading new DayPlan');
    
    const newTasks: Task[] = [];
    for (const block of plan.tasks) {
      const expanded = this.taskExpander.expand(block, state);
      newTasks.push(...expanded);
    }

    // Sort descending by priority so highest priority is popped from the end
    // Or just push them in sequence if we assume blocks are sequential.
    // For now, assume sequential FIFO + Priority sort.
    this.queue = newTasks.sort((a, b) => b.priority - a.priority);
    
    this.logger.info({ expandedTaskCount: this.queue.length }, 'TaskScheduler: DayPlan expanded and queued');
  }

  /**
   * Injects high-priority tasks at the front of the queue.
   * Used by the ReplanEngine to insert corrective logic (e.g. refill watering can).
   */
  public injectTasks(tasks: Task[]): void {
    this.logger.warn({ count: tasks.length }, 'TaskScheduler: injecting corrective tasks at front of queue');
    // We want the injected tasks to execute immediately, in sequence.
    // So if tasks = [A, B], we unshift B then A so the queue front is [A, B, ...]
    for (let i = tasks.length - 1; i >= 0; i--) {
      this.queue.unshift(tasks[i]!);
    }
  }

  /** Returns true if there are tasks waiting to be dispatched. */
  public hasPendingTasks(): boolean {
    return this.queue.length > 0;
  }

  /** Clears the current queue. */
  public clear(): void {
    this.queue = [];
  }

  // ── Private Handlers ─────────────────────────────────────────────────────────

  private registerHandlers(): void {
    // 1. L2 requests the next task
    this.eventBus.on('task.requested', this.handleTaskRequested.bind(this));
    
    // 2. Track completion for prerequisite resolution in the future
    this.eventBus.on('task.completed', (payload) => {
      this.completedTaskIds.add(payload.taskId);
      this.logger.debug({ taskId: payload.taskId }, 'TaskScheduler: registered task completion');
    });
  }

  private handleTaskRequested({ state }: { state: GameStateSnapshot }): void {
    if (this.queue.length === 0) {
      this.logger.debug({}, 'TaskScheduler: task requested but queue is empty');
      return;
    }

    // Pop the next task.
    // (Future enhancement: check task.prerequisites against completedTaskIds)
    const nextTask = this.queue.shift()!;
    
    this.logger.info({ taskId: nextTask.id, taskType: nextTask.type }, 'TaskScheduler: dispatching next task');
    this.eventBus.emit('task.next', { task: nextTask });

    // State parameter is ignored here, but we could use it to skip tasks that
    // are already naturally fulfilled (e.g. crop is already watered).
    void state;
  }
}
