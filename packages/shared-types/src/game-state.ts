import { z } from 'zod';

// ── Primitives ────────────────────────────────────────────────────────────────

export const SeasonSchema = z.enum(['spring', 'summer', 'fall', 'winter']);
export type Season = z.infer<typeof SeasonSchema>;

export const ToolTypeSchema = z.enum([
  'Axe',
  'Hoe',
  'Pickaxe',
  'WateringCan',
  'FishingRod',
  'Sword',
  'Scythe',
  'MilkPail',
  'Shears',
]);
export type ToolType = z.infer<typeof ToolTypeSchema>;

export const SkillNameSchema = z.enum([
  'farming',
  'mining',
  'foraging',
  'fishing',
  'combat',
]);
export type SkillName = z.infer<typeof SkillNameSchema>;

// ── Inventory ─────────────────────────────────────────────────────────────────

export const InventorySlotSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  quantity: z.number().int().min(0),
  quality: z.number().int().min(0).max(4),
  stackable: z.boolean(),
});
export type InventorySlot = z.infer<typeof InventorySlotSchema>;

// ── Player ────────────────────────────────────────────────────────────────────

export const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  map: z.string(),
});
export type Position = z.infer<typeof PositionSchema>;

export const PlayerStateSchema = z.object({
  position: PositionSchema,
  health: z.number().int().min(0),
  maxHealth: z.number().int().min(1),
  stamina: z.number().min(0),
  maxStamina: z.number().min(1),
  gold: z.number().int().min(0),
  inventory: z.array(InventorySlotSchema).readonly(),
  equippedTool: ToolTypeSchema.nullable(),
  skills: z.record(SkillNameSchema, z.number().int().min(0).max(10)),
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;

// ── Farm ──────────────────────────────────────────────────────────────────────

export const CropTileSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  cropId: z.string().nullable(),
  daysToHarvest: z.number().int().nullable(),
  watered: z.boolean(),
  fertilized: z.boolean(),
});
export type CropTile = z.infer<typeof CropTileSchema>;

export const FarmStateSchema = z.object({
  tiles: z.array(CropTileSchema),
  sprinklerCoverage: z.array(PositionSchema),
  buildings: z.array(
    z.object({
      type: z.string(),
      position: PositionSchema,
      animals: z.number().int().min(0),
    })
  ),
});
export type FarmState = z.infer<typeof FarmStateSchema>;

// ── World ─────────────────────────────────────────────────────────────────────

export const WeatherSchema = z.enum([
  'sunny',
  'rainy',
  'stormy',
  'snowy',
  'windy',
]);
export type Weather = z.infer<typeof WeatherSchema>;

export const WorldStateSchema = z.object({
  weather: WeatherSchema,
  tomorrowWeather: WeatherSchema,
  mineLevel: z.number().int().min(0),
  hasAccessToSkullCavern: z.boolean(),
});
export type WorldState = z.infer<typeof WorldStateSchema>;

// ── Bundles ───────────────────────────────────────────────────────────────────

export const BundleItemStatusSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  requiredQty: z.number().int().min(1),
  deliveredQty: z.number().int().min(0),
  complete: z.boolean(),
});
export type BundleItemStatus = z.infer<typeof BundleItemStatusSchema>;

export const BundleSchema = z.object({
  bundleId: z.string(),
  name: z.string(),
  roomId: z.string(),
  complete: z.boolean(),
  items: z.array(BundleItemStatusSchema),
});
export type Bundle = z.infer<typeof BundleSchema>;

export const BundleStateSchema = z.object({
  bundles: z.array(BundleSchema),
  totalComplete: z.number().int().min(0),
  totalBundles: z.number().int(),
});
export type BundleState = z.infer<typeof BundleStateSchema>;

// ── Game State Snapshot ───────────────────────────────────────────────────────

export const GameStateSnapshotSchema = z.object({
  tick: z.number().int().min(0),
  gameDay: z.number().int().min(1).max(28),
  season: SeasonSchema,
  year: z.number().int().min(1),
  timeOfDay: z.number().int().min(600).max(2600),
  player: PlayerStateSchema,
  farm: FarmStateSchema,
  world: WorldStateSchema,
  bundles: BundleStateSchema,
});
export type GameStateSnapshot = z.infer<typeof GameStateSnapshotSchema>;
