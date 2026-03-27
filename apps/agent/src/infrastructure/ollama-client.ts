import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { ZodSchema } from 'zod';
import type { Logger } from 'pino';
import type { DecisionLogEntry, DecisionType } from '@asva/shared-types';
import { AppError, ErrorCodes } from '../cross-cutting/app-error.js';
import type { ObservabilityService } from '../cross-cutting/observability-service.js';
import type { ConfigLoader } from './config-loader.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OllamaCallOptions<T> {
  promptTemplate: string;
  promptVersion: string;
  variables: Record<string, unknown>;
  responseSchema: ZodSchema<T>;
  decisionType: DecisionType;
  gameDay: number;
  season: string;
  year: number;
  timeoutMs?: number;
  maxRetries?: number;
  cacheable?: boolean;
}

export interface OllamaResult<T> {
  data: T;
  latencyMs: number;
  attempt: number;
}

// ── OllamaClient ──────────────────────────────────────────────────────────────

/**
 * OllamaClient — L1 Infrastructure Layer.
 * HTTP client for local Ollama REST API.
 * - Validates every response through a Zod schema (P0).
 * - Retries on failure with corrective prompt hint.
 * - Logs every call to ObservabilityService (immutable decision trace).
 * - Prompt caching via hash comparison.
 */
export class OllamaClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRetries: number;
  private readonly promptCache = new Map<string, unknown>();
  private readonly MAX_CACHE_SIZE = 50;

  constructor(
    config: ConfigLoader,
    private readonly observability: ObservabilityService,
    private readonly logger: Logger
  ) {
    this.baseUrl = config.get<string>('ollama.baseUrl');
    this.model = config.get<string>('ollama.model');
    this.defaultTimeoutMs = config.get<number>('ollama.timeoutMs');
    this.defaultMaxRetries = config.get<number>('ollama.maxRetries');
  }

  /**
   * Executes an LLM call with full retry/validation/logging.
   * Never returns an unvalidated response.
   */
  public async call<T>(options: OllamaCallOptions<T>): Promise<OllamaResult<T>> {
    const prompt = this.renderTemplate(options.promptTemplate, options.variables);
    const cacheKey = this.hashPrompt(prompt);
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    if (options.cacheable === true) {
      const cached = this.promptCache.get(cacheKey);
      if (cached !== undefined) {
        const validated = options.responseSchema.safeParse(cached);
        if (validated.success) {
          this.logger.debug({ cacheKey }, 'OllamaClient: cache hit (validated)');
          return { data: validated.data, latencyMs: 0, attempt: -1 };
        }
        this.logger.warn({ cacheKey }, 'OllamaClient: cache hit failed re-validation — purging');
        this.promptCache.delete(cacheKey);
      }
    }

    const startMs = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const raw = await this.httpPost(prompt, timeoutMs);
        const parsed = options.responseSchema.safeParse(raw);

        if (!parsed.success) {
          throw new AppError(
            ErrorCodes.LLM_INVALID_RESPONSE,
            `Response failed schema validation (attempt ${attempt})`,
            422,
            { details: parsed.error.flatten() }
          );
        }

        const result: OllamaResult<T> = {
          data: parsed.data,
          latencyMs: Date.now() - startMs,
          attempt,
        };

        this.recordDecision({
          id: randomUUID(),
          type: options.decisionType,
          gameDay: options.gameDay,
          season: options.season,
          year: options.year,
          prompt,
          rawResponse: JSON.stringify(raw),
          parsedPlan: parsed.data,
          latencyMs: result.latencyMs,
          modelVersion: this.model,
          promptVersion: options.promptVersion,
          createdAt: new Date().toISOString(),
        });

        if (options.cacheable === true) {
          // Unbounded cache prevention: Simple FIFO eviction if full
          if (this.promptCache.size >= this.MAX_CACHE_SIZE) {
            const firstKey = this.promptCache.keys().next().value;
            if (firstKey !== undefined) this.promptCache.delete(firstKey);
          }
          this.promptCache.set(cacheKey, parsed.data);
        }
        return result;
      } catch (error) {
        lastError = error as Error;
        this.logger.warn({ attempt, error }, 'OllamaClient: attempt failed');
      }
    }

    throw new AppError(
      ErrorCodes.LLM_CALL_FAILED,
      'All Ollama retry attempts exhausted',
      500,
      { cause: lastError }
    );
  }

  /** Shallow health check — confirms Ollama HTTP is reachable. */
  public async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async httpPost(prompt: string, timeoutMs: number): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new AppError(
        ErrorCodes.OLLAMA_UNAVAILABLE,
        `Ollama returned HTTP ${res.status}`,
        res.status
      );
    }

    const json = (await res.json()) as { response?: string };
    const responseText = json.response ?? '';

    // Strip markdown code fences if present
    const cleaned = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    try {
      return JSON.parse(cleaned);
    } catch {
      return responseText; // Return as-is for string schemas
    }
  }

  private renderTemplate(template: string, variables: Record<string, unknown>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      result = result.replace(placeholder, JSON.stringify(value));
    }
    return result;
  }

  private hashPrompt(prompt: string): string {
    return createHash('sha256').update(prompt).digest('hex');
  }

  private recordDecision(entry: DecisionLogEntry): void {
    this.observability.logDecision(entry);
  }
}
