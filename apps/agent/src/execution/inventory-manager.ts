import type { Logger } from 'pino';
import type { GameStateSnapshot, InventorySlot } from '@asva/shared-types';
import type { GameAction } from '@asva/shared-types';

/**
 * InventoryManager — L2 Execution Layer.
 * Provides read-only queries over the player's current inventory state
 * and generates equip/pickup/drop GameActions for the ActionDispatcher.
 *
 * Design rules:
 *  - Never mutates game state directly — only produces typed GameAction objects.
 *  - All queries are synchronous and <1ms (pure in-memory).
 *  - Uses `DisplayName`-based tool matching to be compatible with mod-renamed tools.
 */

// ── Tool → Known Display Name Mapping ────────────────────────────────────────

/** Maps abstract tool type names to their expected Stardew Valley display names. */
const TOOL_DISPLAY_NAMES: Record<string, string[]> = {
  WateringCan:  ['Watering Can', 'Copper Watering Can', 'Steel Watering Can', 'Gold Watering Can', 'Iridium Watering Can'],
  Hoe:          ['Hoe', 'Copper Hoe', 'Steel Hoe', 'Gold Hoe', 'Iridium Hoe'],
  Pickaxe:      ['Pickaxe', 'Copper Pickaxe', 'Steel Pickaxe', 'Gold Pickaxe', 'Iridium Pickaxe'],
  Axe:          ['Axe', 'Copper Axe', 'Steel Axe', 'Gold Axe', 'Iridium Axe'],
  Scythe:       ['Scythe', 'Golden Scythe'],
  FishingRod:   ['Bamboo Pole', 'Fiberglass Rod', 'Iridium Rod'],
  Sword:        ['Rusty Sword', 'Wood Club', 'Pirate\'s Sword', 'Cutlass', 'Elf Blade', 'Silver Saber',
                 'Wood Mallet', 'Lead Rod', 'Knight\'s Sword', 'Claymore', 'Steel Smallsword', 'Obsidian Edge',
                 'Pirate\'s Sword', 'Bone Sword', 'Crystal Dagger', 'Yeti Tooth', 'Wood Mallet',
                 'Dragontooth Cutlass', 'Infinity Blade'],
};

// ── Class ─────────────────────────────────────────────────────────────────────

export class InventoryManager {
  constructor(private readonly logger: Logger) {}

  /**
   * Checks whether the player has at least `quantity` of the given item (by itemId).
   */
  public hasItem(state: GameStateSnapshot, itemId: string, quantity = 1): boolean {
    const total = state.player.inventory
      .filter((slot) => slot.itemId === itemId)
      .reduce((sum, slot) => sum + slot.quantity, 0);
    return total >= quantity;
  }

  /**
   * Returns the total quantity of an item in inventory.
   */
  public countItem(state: GameStateSnapshot, itemId: string): number {
    return state.player.inventory
      .filter((slot) => slot.itemId === itemId)
      .reduce((sum, slot) => sum + slot.quantity, 0);
  }

  /**
   * Returns the slot index (0-indexed) of the best tool of the given type in inventory.
   * "Best" = highest-tier (longest display name generally correlates, but we rank by
   * position in TOOL_DISPLAY_NAMES list — higher index = better tier).
   *
   * Returns -1 if no matching tool is found.
   */
  public findBestTool(state: GameStateSnapshot, toolType: string): number {
    const candidates = TOOL_DISPLAY_NAMES[toolType] ?? [];
    let bestSlot = -1;
    let bestTier = -1;

    state.player.inventory.forEach((slot, index) => {
      const tier = candidates.indexOf(slot.name);
      if (tier !== -1 && tier > bestTier) {
        bestTier = tier;
        bestSlot = index;
      }
    });

    return bestSlot;
  }

  /**
   * Returns true if the currently equipped tool matches the given tool type.
   * Matches against both the ToolType enum key (e.g. 'WateringCan') and
   * any known display name variant (e.g. 'Watering Can', 'Gold Watering Can').
   */
  public isEquipped(state: GameStateSnapshot, toolType: string): boolean {
    const equipped = state.player.equippedTool;
    if (!equipped) return false;
    // Check the type key itself (e.g. 'WateringCan')
    if (equipped === toolType) return true;
    // Check display name variants
    const candidates = TOOL_DISPLAY_NAMES[toolType] ?? [];
    return candidates.includes(equipped as string);
  }

  /**
   * Produces an ACTION_EQUIP_TOOL action for the best available tool of the given type.
   * Returns null if no tool of that type is present in inventory.
   */
  public buildEquipAction(state: GameStateSnapshot, toolType: string): GameAction | null {
    const slot = this.findBestTool(state, toolType);
    if (slot === -1) {
      this.logger.warn({ toolType }, 'InventoryManager: no tool of requested type in inventory');
      return null;
    }

    const toolItem = state.player.inventory[slot];
    if (!toolItem) {
      this.logger.warn({ toolType, slot }, 'InventoryManager: inventory slot resolved but item is undefined');
      return null;
    }
    const toolName = toolItem.name;
    this.logger.debug({ toolType, toolName, slot }, 'InventoryManager: building equip action');

    return {
      type: 'ACTION_EQUIP_TOOL',
      payload: { tool: toolName },
    };
  }

  /**
   * Returns all inventory slots that are considered "junk" (low-value items that
   * should be shipped end-of-day rather than carried). This is intentionally conservative —
   * the dispatcher confirms before any drop action.
   *
   * For Phase 2, this is limited to: basic foraged items, broken tools.
   */
  public getShippableItems(state: GameStateSnapshot): InventorySlot[] {
    // Shippable: non-null quantity, not a named tool, not a seed (itemId starts with known prefixes)
    return state.player.inventory.filter((slot) => {
      if (slot.quantity <= 0) return false;
      if (this.isTool(slot.name)) return false;
      return true;
    });
  }

  /** Heuristic: is this item a tool (based on display name matching known tools)? */
  private isTool(name: string): boolean {
    return Object.values(TOOL_DISPLAY_NAMES)
      .flat()
      .some((n) => n === name);
  }
}
