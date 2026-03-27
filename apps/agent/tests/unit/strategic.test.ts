import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DayPlanner } from '../../src/strategic/day-planner.js';
import { TaskScheduler } from '../../src/tactical/task-scheduler.js';
import { TaskExpander } from '../../src/tactical/task-expander.js';
import { EventBus } from '../../src/cross-cutting/event-bus.js';
import type { OllamaClient } from '../../src/infrastructure/ollama-client.js';
import type { SMAPIBridge } from '../../src/infrastructure/smapi-bridge.js';
import type { GameStateSnapshot } from '@asva/shared-types';
import pino from 'pino';

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

describe('Strategic Layer (Phase 4)', () => {
  describe('DayPlanner', () => {
    let eventBus: EventBus;
    let scheduler: TaskScheduler;
    let ollamaClient: Partial<OllamaClient>;
    let bridge: Partial<SMAPIBridge>;
    let dayPlanner: DayPlanner;

    beforeEach(() => {
      eventBus = new EventBus();
      const expander = new TaskExpander(mockLogger);
      scheduler = new TaskScheduler(eventBus, expander, mockLogger);
      ollamaClient = {
        call: vi.fn() as any,
      };
      bridge = {
        getLatestState: vi.fn(),
      };
      dayPlanner = new DayPlanner(
        ollamaClient as OllamaClient,
        scheduler,
        eventBus,
        bridge as SMAPIBridge,
        mockLogger
      );
    });

    it('generates a DayPlan via LLM on day.started and loads it into scheduler', async () => {
      const state = createMockState();
      state.farm.tiles = [{ x: 5, y: 5, cropId: 'Parsnip', daysToHarvest: null, watered: false, fertilized: false }];
      (bridge.getLatestState as any).mockReturnValue(state);

      // Mock LLM Response
      const mockLlmResponse = {
        data: {
          tasks: [
            { activity: 'WATER_CROPS', location: 'Farm', estimatedDurationTicks: 10, energyCost: 2, priority: 100, goalId: null }
          ],
          totalEnergyCost: 2,
          llmRationale: 'Watering crops is the morning priority.',
        },
        latencyMs: 150,
        attempt: 0,
      };
      (ollamaClient.call as any).mockResolvedValue(mockLlmResponse);

      const spySchedulerLoad = vi.spyOn(scheduler, 'loadDayPlan');

      // Trigger planning
      eventBus.emit('day.started', { gameDay: 1, season: 'spring', year: 1 });
      await dayPlanner.handleDayStarted({ gameDay: 1, season: 'spring', year: 1 });

      // Verify LLM was called with correct context
      expect(ollamaClient.call).toHaveBeenCalledWith(expect.objectContaining({
        decisionType: 'daily',
        gameDay: 1,
        season: 'spring',
      }));

      // Verify scheduler received the plan with the envelope
      expect(spySchedulerLoad).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.stringContaining('plan-1-spring-1'),
          tasks: expect.arrayContaining([expect.objectContaining({ activity: 'WATER_CROPS' })]),
        }),
        state
      );
    });

    it('guards against duplicate planning for the same day', async () => {
      (bridge.getLatestState as any).mockReturnValue(createMockState());
      (ollamaClient.call as any).mockResolvedValue({ data: { tasks: [], totalEnergyCost: 0, llmRationale: '' }, latencyMs: 10, attempt: 0 });
      
      await dayPlanner.handleDayStarted({ gameDay: 2, season: 'spring', year: 1 });
      expect(ollamaClient.call).toHaveBeenCalledTimes(1);

      // Call again for same day
      await dayPlanner.handleDayStarted({ gameDay: 2, season: 'spring', year: 1 });
      expect(ollamaClient.call).toHaveBeenCalledTimes(1); // Not called again
    });

    it('emits agent.safe-pause if LLM fails', async () => {
      (bridge.getLatestState as any).mockReturnValue(createMockState());
      const error = new Error('LLM Offline');
      (ollamaClient.call as any).mockRejectedValue(error);

      const spyPause = vi.fn();
      eventBus.on('agent.safe-pause', spyPause);

      await dayPlanner.handleDayStarted({ gameDay: 3, season: 'spring', year: 1 });

      expect(spyPause).toHaveBeenCalledWith({ reason: 'LLM_PLANNING_FAILED' });
    });
  });
});
