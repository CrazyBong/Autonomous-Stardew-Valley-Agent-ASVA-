import { z } from 'zod';

// ── Task ──────────────────────────────────────────────────────────────────────

export const TaskTypeSchema = z.enum([
  'MOVE',
  'WATER_CROP',
  'HARVEST_CROP',
  'PLANT_SEED',
  'TILL_SOIL',
  'PICKUP_ITEM',
  'SELL_ITEMS',
  'BUY_ITEM',
  'MINE_ROCKS',
  'COMBAT',
  'FISH',
  'FORAGE',
  'TALK_TO_NPC',
  'GIFT_NPC',
  'SLEEP',
  'UPGRADE_TOOL',
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  type: TaskTypeSchema,
  priority: z.number().int().min(0).max(100),
  estimatedDurationTicks: z.number().int().min(1),
  energyCost: z.number().min(0),
  prerequisites: z.array(z.string()),
  parameters: z.record(z.string(), z.unknown()),
  status: TaskStatusSchema,
  attemptCount: z.number().int().min(0),
  lastError: z.string().optional(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// ── Experience Record ─────────────────────────────────────────────────────────

export const ExperienceRecordSchema = z.object({
  id: z.string(),
  taskType: TaskTypeSchema,
  location: z.string(),
  season: z.string(),
  outcome: z.enum(['success', 'failure', 'partial']),
  details: z.record(z.string(), z.unknown()),
  recordedAt: z.string().datetime(),
});
export type ExperienceRecord = z.infer<typeof ExperienceRecordSchema>;
