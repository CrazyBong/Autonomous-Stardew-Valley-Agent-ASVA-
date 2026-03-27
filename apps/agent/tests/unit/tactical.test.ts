import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskExpander, TaskScheduler, ReplanEngine } from '../../src/tactical/index.js';
import { EventBus } from '../../src/cross-cutting/event-bus.js';
import type { GameStateSnapshot, TaskBlock, DayPlan, Task } from '@asva/shared-types';
import pino from 'pino';

// ── Test Helpers ─────────────────────────────────────────────────────────────

const mockLogger = pino({ level: 'silent' });

function createMockState(): GameStateSnapshot {
  return {
    tick: 1,
    gameDay: 1,
    season: 'spring',
    year: 1,
    timeOfDay: 600,
    player: {
      position: { x: 0, y: 0, map: 'Farm' },
      health: 100, maxHealth: 100,
      stamina: 270, maxStamina: 270,
      gold: 500, inventory: [], equippedTool: null,
      skills: { farming: 0, mining: 0, foraging: 0, fishing: 0, combat: 0 },
    },
    farm: { tiles: [], sprinklerCoverage: [], buildings: [] },
    world: { weather: 'sunny', tomorrowWeather: 'sunny', mineLevel: 0, hasAccessToSkullCavern: false },
    bundles: { bundles: [], totalComplete: 0, totalBundles: 0 },
  };
}

// ── Suites ───────────────────────────────────────────────────────────────────

describe('Tactical Layer (Phase 3)', () => {
  describe('TaskExpander', () => {
    let expander: TaskExpander;

    beforeEach(() => {
      expander = new TaskExpander(mockLogger);
    });

    it('expands WATER_CROPS into granular tasks based on GameState', () => {
      const state = createMockState();
      state.farm.tiles = [
        { x: 1, y: 1, cropId: 'Parsnip', daysToHarvest: null, watered: false, fertilized: false },
        { x: 2, y: 1, cropId: 'Parsnip', daysToHarvest: null, watered: true, fertilized: false }, // already watered
        { x: 3, y: 1, cropId: 'Parsnip', daysToHarvest: null, watered: false, fertilized: false },
      ];

      const block: TaskBlock = { activity: 'WATER_CROPS', location: 'Farm', estimatedDurationTicks: 10, energyCost: 2, priority: 50, goalId: null };
      const tasks = expander.expand(block, state);

      expect(tasks).toHaveLength(2); // Only the 2 unwatered crops
      expect(tasks[0]!.type).toBe('WATER_CROP');
      expect(tasks[0]!.parameters['tileX']).toBe(1);
      expect(tasks[1]!.parameters['tileX']).toBe(3);
    });

    it('expands HARVEST_CROPS into granular tasks based on GameState', () => {
      const state = createMockState();
      state.farm.tiles = [
        { x: 1, y: 1, cropId: 'Parsnip', daysToHarvest: 1, watered: true, fertilized: false }, // Not ready
        { x: 2, y: 1, cropId: 'Parsnip', daysToHarvest: 0, watered: true, fertilized: false }, // Ready!
      ];

      const block: TaskBlock = { activity: 'HARVEST_CROPS', location: 'Farm', estimatedDurationTicks: 10, energyCost: 2, priority: 50, goalId: null };
      const tasks = expander.expand(block, state);

      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.type).toBe('HARVEST_CROP');
      expect(tasks[0]!.parameters['tileX']).toBe(2);
    });
  });

  describe('TaskScheduler', () => {
    let eventBus: EventBus;
    let scheduler: TaskScheduler;
    let expander: TaskExpander;

    beforeEach(() => {
      eventBus = new EventBus();
      expander = new TaskExpander(mockLogger);
      scheduler = new TaskScheduler(eventBus, expander, mockLogger);
    });

    it('loads a DayPlan, expands it, and emits task.next on request', () => {
      const state = createMockState();
      state.farm.tiles = [{ x: 5, y: 5, cropId: 'Parsnip', daysToHarvest: null, watered: false, fertilized: false }];

      const plan: DayPlan = {
        id: 'plan-1',
        gameDay: 1, season: 'spring', year: 1,
        tasks: [{ activity: 'WATER_CROPS', location: 'Farm', estimatedDurationTicks: 10, energyCost: 2, priority: 100, goalId: null }],
        totalEnergyCost: 2, llmRationale: '', modelVersion: 'test', promptVersion: 'test', createdAt: new Date().toISOString(),
      };

      scheduler.loadDayPlan(plan, state);
      expect(scheduler.hasPendingTasks()).toBe(true);

      const spy = vi.spyOn(eventBus, 'emit');
      eventBus.emit('task.requested', { state });

      expect(spy).toHaveBeenCalledWith('task.next', expect.objectContaining({
        task: expect.objectContaining({ type: 'WATER_CROP' })
      }));
      expect(scheduler.hasPendingTasks()).toBe(false); // Task was popped
    });

    it('injects tasks at the front of the queue', () => {
      const t1: Task = { id: 't1', type: 'MOVE', priority: 10, estimatedDurationTicks: 1, energyCost: 0, prerequisites: [], parameters: {}, status: 'pending', attemptCount: 0, createdAt: '' };
      const t2: Task = { id: 't2', type: 'SLEEP', priority: 10, estimatedDurationTicks: 1, energyCost: 0, prerequisites: [], parameters: {}, status: 'pending', attemptCount: 0, createdAt: '' };

      scheduler.injectTasks([t1, t2]);
      expect(scheduler.hasPendingTasks()).toBe(true);

      const spy = vi.fn();
      eventBus.on('task.next', spy);

      eventBus.emit('task.requested', { state: createMockState() });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ id: 't1' }) }));

      eventBus.emit('task.requested', { state: createMockState() });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ id: 't2' }) }));
    });
  });

  describe('ReplanEngine', () => {
    let eventBus: EventBus;
    let scheduler: TaskScheduler;
    let replanEngine: ReplanEngine;

    beforeEach(() => {
      eventBus = new EventBus();
      const expander = new TaskExpander(mockLogger);
      scheduler = new TaskScheduler(eventBus, expander, mockLogger);
      replanEngine = new ReplanEngine(eventBus, scheduler, mockLogger);
    });

    it('listens to task.replan and currently drops unrecoverable tasks', () => {
      const state = createMockState();
      const blockedTask: Task = {
        id: 't-blocked', type: 'WATER_CROP', priority: 50, estimatedDurationTicks: 10, energyCost: 2,
        prerequisites: [], parameters: {}, status: 'failed', attemptCount: 1, lastError: 'TASK_EXECUTION_FAILED',
        createdAt: new Date().toISOString()
      };

      const spy = vi.spyOn(scheduler, 'injectTasks');
      eventBus.emit('task.replan', { state, blockedTask });

      // In current implementation, TASK_EXECUTION_FAILED drops the task.
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
