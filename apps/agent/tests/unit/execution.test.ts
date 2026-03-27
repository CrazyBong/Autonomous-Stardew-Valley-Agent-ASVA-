/**
 * Phase 2 Unit Tests — Execution Layer
 *
 * Tests: Pathfinder A*, InventoryManager tool-matching, ActionDispatcher state machine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pathfinder } from '../../src/execution/pathfinder.js';
import { InventoryManager } from '../../src/execution/inventory-manager.js';
import { ActionDispatcher } from '../../src/execution/action-dispatcher.js';
import type { GameStateSnapshot } from '@asva/shared-types';

// ── Shared test logger (silent) ───────────────────────────────────────────────

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as import('pino').Logger;

// ── Minimal game state fixture ────────────────────────────────────────────────

function makeState(overrides: Partial<GameStateSnapshot['player']> = {}): GameStateSnapshot {
  return {
    tick: 1,
    gameDay: 1,
    season: 'spring',
    year: 1,
    timeOfDay: 600,
    player: {
      position: { x: 0, y: 0, map: 'Farm' },
      health: 100,
      maxHealth: 100,
      stamina: 270,
      maxStamina: 270,
      gold: 500,
      equippedTool: null,
      skills: { farming: 1, mining: 0, foraging: 0, fishing: 0, combat: 0 },
      inventory: [],
      ...overrides,
    },
    farm: { tiles: [], buildings: [], sprinklerCoverage: [] },
    world: { weather: 'sunny', tomorrowWeather: 'sunny', mineLevel: 0, hasAccessToSkullCavern: false },
    bundles: { bundles: [], totalComplete: 0, totalBundles: 0 },
  };
}

// ── 1. Pathfinder ─────────────────────────────────────────────────────────────

describe('Pathfinder', () => {
  const pf = new Pathfinder(mockLogger);

  // All true = passable grid
  const openGrid: boolean[][] = Array.from({ length: 5 }, () => Array(5).fill(true));

  // Grid with a partial wall: column 2 is blocked EXCEPT the last row (row 4)
  // This means the path must go south to row 4, then east, then north.
  const walledGrid: boolean[][] = Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 5 }, (__, col) => col !== 2 || row === 4)
  );

  it('returns empty steps when start === target', () => {
    const result = pf.findPath(
      { x: 2, y: 2, map: 'Farm' },
      { x: 2, y: 2, map: 'Farm' },
      openGrid
    );
    expect(result).not.toBeNull();
    expect(result?.steps).toHaveLength(0);
    expect(result?.cost).toBe(0);
  });

  it('finds a straight path on an open grid', () => {
    const result = pf.findPath(
      { x: 0, y: 0, map: 'Farm' },
      { x: 3, y: 0, map: 'Farm' },
      openGrid
    );
    expect(result).not.toBeNull();
    expect(result?.cost).toBe(3);
    expect(result?.steps[result.steps.length - 1]).toMatchObject({ x: 3, y: 0 });
  });

  it('navigates around a wall', () => {
    // x=2 is blocked; must go around via y axis
    const result = pf.findPath(
      { x: 0, y: 0, map: 'Farm' },
      { x: 4, y: 0, map: 'Farm' },
      walledGrid
    );
    // A path must exist (going through the gap at y=4)
    expect(result).not.toBeNull();
    // The path may only cross x=2 at the gap row (y=4) — never at blocked rows (y=0..3)
    const illegalWallCross = result?.steps.some((s) => s.x === 2 && s.y < 4);
    expect(illegalWallCross).toBe(false);
  });

  it('returns null when target is unreachable (fully walled)', () => {
    // A 3x3 grid with the center completely isolated
    const isolatedGrid: boolean[][] = [
      [true,  false, true],
      [false, true,  false],
      [true,  false, true],
    ];
    const result = pf.findPath(
      { x: 0, y: 0, map: 'Farm' },
      { x: 1, y: 1, map: 'Farm' },
      isolatedGrid
    );
    expect(result).toBeNull();
  });

  it('returns null for cross-map routing', () => {
    const result = pf.findPath(
      { x: 0, y: 0, map: 'Farm' },
      { x: 5, y: 5, map: 'Town' },
      openGrid
    );
    expect(result).toBeNull();
  });
});

// ── 2. InventoryManager ───────────────────────────────────────────────────────

describe('InventoryManager', () => {
  const inv = new InventoryManager(mockLogger);

  const stateWithWateringCan = makeState({
    inventory: [
      { itemId: '179', name: 'Watering Can', quantity: 1, quality: 0, stackable: false },
      { itemId: '24',  name: 'Parsnip',      quantity: 5, quality: 0, stackable: true },
    ],
  });

  it('detects presence of an item by itemId', () => {
    expect(inv.hasItem(stateWithWateringCan, '179')).toBe(true);
    expect(inv.hasItem(stateWithWateringCan, '999')).toBe(false);
  });

  it('counts stacked items correctly', () => {
    expect(inv.countItem(stateWithWateringCan, '24')).toBe(5);
  });

  it('finds the best tool slot for WateringCan', () => {
    const slot = inv.findBestTool(stateWithWateringCan, 'WateringCan');
    expect(slot).toBe(0);
  });

  it('returns -1 when tool type not in inventory', () => {
    const slot = inv.findBestTool(stateWithWateringCan, 'Pickaxe');
    expect(slot).toBe(-1);
  });

  it('builds an equip action for a known tool', () => {
    const action = inv.buildEquipAction(stateWithWateringCan, 'WateringCan');
    expect(action).not.toBeNull();
    expect(action?.type).toBe('ACTION_EQUIP_TOOL');
    if (action?.type === 'ACTION_EQUIP_TOOL') {
      expect(action.payload.tool).toBe('Watering Can');
    }
  });

  it('returns null equip action when tool missing', () => {
    const state = makeState({ inventory: [] });
    const action = inv.buildEquipAction(state, 'Pickaxe');
    expect(action).toBeNull();
  });

  it('correctly identifies equipped tool', () => {
    const stateEquipped = makeState({ equippedTool: 'WateringCan' });
    expect(inv.isEquipped(stateEquipped, 'WateringCan')).toBe(true);
    expect(inv.isEquipped(stateEquipped, 'Hoe')).toBe(false);
  });
});

// ── 3. ActionDispatcher ───────────────────────────────────────────────────────

describe('ActionDispatcher', () => {
  let bridge: ReturnType<typeof makeMockBridge>;
  let eventBus: ReturnType<typeof makeMockEventBus>;
  let dispatcher: ActionDispatcher;

  function makeMockBridge() {
    return { dispatch: vi.fn().mockResolvedValue(undefined) };
  }

  function makeMockEventBus() {
    return {
      emit: vi.fn(),
      on: vi.fn(),
    };
  }

  const openGrid: boolean[][] = Array.from({ length: 10 }, () => Array(10).fill(true));

  beforeEach(() => {
    bridge = makeMockBridge();
    eventBus = makeMockEventBus();
    dispatcher = new ActionDispatcher(
      bridge as unknown as import('../../src/infrastructure/smapi-bridge.js').SMAPIBridge,
      eventBus as unknown as import('../../src/cross-cutting/event-bus.js').EventBus,
      { recordBusinessEvent: vi.fn(), logDecision: vi.fn(), recordMetrics: vi.fn() } as unknown as import('../../src/cross-cutting/observability-service.js').ObservabilityService,
      new Pathfinder(mockLogger),
      new InventoryManager(mockLogger),
      mockLogger
    );
  });

  it('starts in IDLE state', () => {
    expect(dispatcher.isIdle()).toBe(true);
    expect(dispatcher.getState()).toBe('IDLE');
  });

  it('transitions to PATHING after loadTask', () => {
    const task = makeTask('WATER_CROP', { tileX: 2, tileY: 2, map: 'Farm' });
    dispatcher.loadTask(task);
    expect(dispatcher.getState()).toBe('PATHING');
  });

  it('dispatches ACTION_EQUIP_TOOL + ACTION_USE_TOOL for WATER_CROP when player already adjacent', async () => {
    const stateAtTarget = makeState({
      position: { x: 1, y: 2, map: 'Farm' }, // adjacent to (2,2)
      inventory: [{ itemId: '179', name: 'Watering Can', quantity: 1, quality: 0, stackable: false }],
    });
    const task = makeTask('WATER_CROP', { tileX: 2, tileY: 2, map: 'Farm' });
    dispatcher.loadTask(task);

    // Tick 1: PATHING resolves to EXECUTING (adjacent)
    await dispatcher.executeTick(stateAtTarget, openGrid);
    expect(dispatcher.getState()).toBe('EXECUTING');

    // Tick 2: dispatch equip action
    await dispatcher.executeTick(stateAtTarget, openGrid);
    expect(bridge.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ACTION_EQUIP_TOOL' })
    );
  });

  it('emits task.completed on success', async () => {
    // Give the player position = target so no movement needed, no tool needed
    const task = makeTask('SLEEP', {});
    const state = makeState({ position: { x: 0, y: 0, map: 'Farm' } });
    dispatcher.loadTask(task);

    // PATHING → EXECUTING (no path needed for SLEEP)
    await dispatcher.executeTick(state, openGrid);
    // EXECUTING → dispatches ACTION_SLEEP → queue empties → SUCCEEDED
    await dispatcher.executeTick(state, openGrid);
    // SUCCEEDED → emits event + clears → IDLE
    await dispatcher.executeTick(state, openGrid);
    // A 4th tick is a no-op (no task loaded)
    await dispatcher.executeTick(state, openGrid);

    expect(eventBus.emit).toHaveBeenCalledWith(
      'task.completed',
      expect.objectContaining({ taskId: task.id })
    );
    expect(dispatcher.isIdle()).toBe(true);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(type: string, parameters: Record<string, unknown>) {
  return {
    id: `task-${type}-test`,
    type: type as import('@asva/shared-types').TaskType,
    priority: 50,
    estimatedDurationTicks: 10,
    energyCost: 5,
    prerequisites: [],
    parameters,
    status: 'pending' as const,
    attemptCount: 0,
    createdAt: new Date().toISOString(),
  };
}
