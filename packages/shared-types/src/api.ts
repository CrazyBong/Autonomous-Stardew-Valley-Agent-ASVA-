import { z } from 'zod';

// ── Standard Response Envelopes (GEMINI Rule 02) ─────────────────────────────

export const PaginationMetaSchema = z.object({
  cursor: z.string().nullable(),
  total: z.number().int(),
  limit: z.number().int(),
});
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export function successResponse<T>(data: T, meta?: PaginationMeta) {
  return { success: true as const, data, meta };
}

export function errorResponse(code: string, message: string, details?: unknown) {
  return {
    success: false as const,
    error: { code, message, details },
  };
}

// ── Health ─────────────────────────────────────────────────────────────────────

export const HealthStatusSchema = z.enum(['ok', 'degraded', 'offline']);

export const ShallowHealthSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
});
export type ShallowHealth = z.infer<typeof ShallowHealthSchema>;

export const DeepHealthSchema = z.object({
  status: HealthStatusSchema,
  smapiBridge: z.enum(['connected', 'disconnected', 'unknown']),
  ollama: z.enum(['ok', 'unavailable', 'unknown']),
  sqlite: z.enum(['ok', 'error', 'unknown']),
  agentLoop: z.enum(['running', 'paused', 'stopped']),
});
export type DeepHealth = z.infer<typeof DeepHealthSchema>;

// ── Metrics ───────────────────────────────────────────────────────────────────

export const AgentMetricsSchema = z.object({
  totalGameDays: z.number().int(),
  taskCompletionRate: z.number().min(0).max(1),
  agentPassOutCount: z.number().int(),
  llmCallCount: z.number().int(),
  llmLatencyP50Ms: z.number(),
  llmLatencyP99Ms: z.number(),
  replanCount: z.number().int(),
  totalGoldEarned: z.number().int(),
  bundlesCompleted: z.number().int(),
  bundlesTotal: z.number().int(),
});
export type AgentMetrics = z.infer<typeof AgentMetricsSchema>;

// ── Decision Log Entry ────────────────────────────────────────────────────────

export const DecisionTypeSchema = z.enum(['strategic', 'daily', 'replan']);
export type DecisionType = z.infer<typeof DecisionTypeSchema>;

export const DecisionLogEntrySchema = z.object({
  id: z.string(),
  type: DecisionTypeSchema,
  gameDay: z.number().int(),
  season: z.string(),
  year: z.number().int(),
  prompt: z.string(),
  rawResponse: z.string(),
  parsedPlan: z.unknown(),
  latencyMs: z.number(),
  modelVersion: z.string(),
  promptVersion: z.string(),
  createdAt: z.string().datetime(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntrySchema>;
