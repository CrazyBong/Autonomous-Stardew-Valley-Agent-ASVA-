import type { Logger } from 'pino';
import type { GameStateSnapshot } from '@asva/shared-types';
import { DayPlanSchema } from '@asva/shared-types';
import type { EventBus } from '../cross-cutting/event-bus.js';
import type { OllamaClient } from '../infrastructure/ollama-client.js';
import type { TaskScheduler } from '../tactical/task-scheduler.js';
import { DAY_PLANNER_SYSTEM_PROMPT, DAY_PLANNER_PROMPT_VERSION } from './prompts.js';
import type { SMAPIBridge } from '../infrastructure/smapi-bridge.js';

/**
 * DayPlanner — L4 Strategic Layer.
 *
 * Subscribes to `day.started` and calls the local LLM (via OllamaClient)
 * to generate a structured DayPlan. The validated plan is then loaded into
 * the L3 TaskScheduler for expansion and execution.
 */
export class DayPlanner {
  /** Tracks the last day we planned for to prevent duplicate plans. */
  private lastPlannedDay: string | null = null;

  constructor(
    private readonly ollamaClient: OllamaClient,
    private readonly scheduler: TaskScheduler,
    private readonly eventBus: EventBus,
    private readonly bridge: SMAPIBridge,
    private readonly logger: Logger
  ) {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.eventBus.on('day.started', (payload) => {
      void this.handleDayStarted(payload);
    });
  }

  /**
   * Core planning method. Gathers game state context, calls the LLM,
   * validates the response through Zod, and loads the plan into the scheduler.
   */
  public async handleDayStarted(payload: {
    gameDay: number;
    season: 'spring' | 'summer' | 'fall' | 'winter';
    year: number;
  }): Promise<void> {
    const dayKey = `${payload.year}-${payload.season}-${payload.gameDay}`;

    // Guard against duplicate planning (e.g. event fires twice).
    if (this.lastPlannedDay === dayKey) {
      this.logger.warn({ dayKey }, 'DayPlanner: already planned for this day — skipping');
      return;
    }

    // Reserve this day immediately to block concurrent calls
    this.lastPlannedDay = dayKey;

    this.logger.info(
      { gameDay: payload.gameDay, season: payload.season, year: payload.year },
      'DayPlanner: generating day plan via LLM'
    );

    this.eventBus.emit('replan.started', { level: 'daily', reason: 'day.started' });

    try {
      // In Phase 4 we need to fetch the live state to plan the day
      let state = this.bridge.getLatestState();
      
      const variables = this.buildPromptVariables(payload, state);

      const result = await this.ollamaClient.call({
        promptTemplate: DAY_PLANNER_SYSTEM_PROMPT,
        promptVersion: DAY_PLANNER_PROMPT_VERSION,
        variables,
        responseSchema: DayPlanSchema.pick({
          tasks: true,
          totalEnergyCost: true,
          llmRationale: true,
        }),
        decisionType: 'daily',
        gameDay: payload.gameDay,
        season: payload.season,
        year: payload.year,
        cacheable: false, // Each day is unique
      });

      // Stamp the full DayPlan envelope with metadata the LLM doesn't provide.
      const fullPlan = {
        id: `plan-${dayKey}`,
        gameDay: payload.gameDay,
        season: payload.season,
        year: payload.year,
        tasks: result.data.tasks,
        totalEnergyCost: result.data.totalEnergyCost,
        llmRationale: result.data.llmRationale,
        modelVersion: this.ollamaClient.modelName ?? 'unknown',
        promptVersion: DAY_PLANNER_PROMPT_VERSION,
        createdAt: new Date().toISOString(),
      };

      this.logger.info(
        { planId: fullPlan.id, taskCount: fullPlan.tasks.length, latencyMs: result.latencyMs },
        'DayPlanner: LLM plan generated successfully'
      );

      // Load the plan into the tactical scheduler for expansion
      this.scheduler.loadDayPlan(fullPlan, state);

      this.eventBus.emit('replan.completed', { level: 'daily' });
    } catch (error) {
      // On failure, clear the reservation so a retry is possible
      this.lastPlannedDay = null;
      this.logger.error({ error }, 'DayPlanner: LLM planning failed — initiating safe pause');
      this.eventBus.emit('agent.safe-pause', { reason: 'LLM_PLANNING_FAILED' });
    }
  }

  /**
   * Builds the template variable map from the current game state.
   */
  private buildPromptVariables(
    payload: { gameDay: number; season: string; year: number },
    state: GameStateSnapshot
  ): Record<string, unknown> {
    const unwateredCrops = state.farm.tiles.filter(t => t.cropId !== null && !t.watered);
    const harvestableCrops = state.farm.tiles.filter(
      t => t.cropId !== null && t.daysToHarvest !== null && t.daysToHarvest <= 0
    );
    const plantedTiles = state.farm.tiles.filter(t => t.cropId !== null);

    const inventoryItems = state.player.inventory
      .slice(0, 8)
      .map(slot => `- ${slot.name} x${slot.quantity}`)
      .join('\n') || 'Empty inventory.';

    return {
      season: payload.season,
      gameDay: payload.gameDay,
      year: payload.year,
      weather: state.world.weather,
      tomorrowWeather: state.world.tomorrowWeather,
      timeOfDay: state.timeOfDay,
      gold: state.player.gold,
      stamina: state.player.stamina,
      maxStamina: state.player.maxStamina,
      currentMap: state.player.position.map,
      unwateredCropCount: unwateredCrops.length,
      harvestableCropCount: harvestableCrops.length,
      totalPlantedTiles: plantedTiles.length,
      inventorySummary: inventoryItems,
      goalsSummary: 'No active goals (strategic goal system not yet implemented).',
    };
  }
}
