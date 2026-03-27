import { z } from 'zod';
import { SeasonSchema } from './game-state.js';

// ── Goals ─────────────────────────────────────────────────────────────────────

export const GoalTypeSchema = z.enum([
  'COMPLETE_BUNDLE',
  'PLANT_CROPS',
  'HARVEST_CROPS',
  'UPGRADE_TOOL',
  'REACH_SKILL_LEVEL',
  'EXPLORE_MINE_FLOOR',
  'EARN_GOLD',
  'BEFRIEND_NPC',
]);
export type GoalType = z.infer<typeof GoalTypeSchema>;

export const GoalStatusSchema = z.enum([
  'active',
  'deferred',
  'completed',
  'failed',
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalSchema = z.object({
  id: z.string(),
  type: GoalTypeSchema,
  description: z.string(),
  priority: z.number().int().min(0).max(100),
  status: GoalStatusSchema,
  estimatedCompletionDay: z.number().int().nullable(),
  parameters: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type Goal = z.infer<typeof GoalSchema>;

// ── Crop Calendar ─────────────────────────────────────────────────────────────

export const CropCalendarEntrySchema = z.object({
  cropId: z.string(),
  cropName: z.string(),
  quantity: z.number().int().min(1),
  plantDay: z.number().int().min(1).max(28),
  harvestDay: z.number().int().min(1).max(28),
  estimatedProfit: z.number(),
});
export type CropCalendarEntry = z.infer<typeof CropCalendarEntrySchema>;

// ── Bundle Targets ─────────────────────────────────────────────────────────────

export const BundleTargetSchema = z.object({
  bundleId: z.string(),
  bundleName: z.string(),
  missingItems: z.array(z.string()),
  targetAcquisitionDay: z.number().int().nullable(),
});
export type BundleTarget = z.infer<typeof BundleTargetSchema>;

// ── Strategic Plan ─────────────────────────────────────────────────────────────

export const StrategicPlanSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  season: SeasonSchema,
  year: z.number().int().min(1),
  primaryGoals: z.array(GoalSchema),
  cropCalendar: z.array(CropCalendarEntrySchema),
  bundleTargets: z.array(BundleTargetSchema),
  llmRationale: z.string(),
  modelVersion: z.string(),
  promptVersion: z.string(),
});
export type StrategicPlan = z.infer<typeof StrategicPlanSchema>;

// ── Task Blocks ───────────────────────────────────────────────────────────────

export const TaskBlockSchema = z.object({
  activity: z.string(),
  location: z.string(),
  estimatedDurationTicks: z.number().int().min(1),
  energyCost: z.number().min(0),
  priority: z.number().int().min(0).max(100),
  goalId: z.string().nullable(),
});
export type TaskBlock = z.infer<typeof TaskBlockSchema>;

export const DayPlanSchema = z.object({
  id: z.string(),
  gameDay: z.number().int().min(1).max(28),
  season: SeasonSchema,
  year: z.number().int().min(1),
  tasks: z.array(TaskBlockSchema),
  totalEnergyCost: z.number(),
  llmRationale: z.string(),
  modelVersion: z.string(),
  promptVersion: z.string(),
  createdAt: z.string().datetime(),
});
export type DayPlan = z.infer<typeof DayPlanSchema>;
