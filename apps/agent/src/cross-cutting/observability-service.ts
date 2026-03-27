import type { Logger } from 'pino';
import type { DecisionLogEntry } from '@asva/shared-types';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * ObservabilityService — GEMINI Rule 04.
 * Structured JSON logging + immutable decision trace records.
 * Every LLM call is recorded here; every layer forwards events via this service.
 */
export class ObservabilityService {
  private readonly decisionLogPath: string;

  constructor(
    private readonly logger: Logger,
    decisionLogPath?: string
  ) {
    this.decisionLogPath = decisionLogPath ?? resolve(process.cwd(), 'data', 'decisions.jsonl');
    try {
      mkdirSync(dirname(this.decisionLogPath), { recursive: true });
    } catch (cause) {
      this.logger.error({ cause, path: this.decisionLogPath }, 'Failed to create decision log directory');
    }
  }

  /**
   * Records a complete LLM decision trace to an append-only JSONL file.
   * Never mutates or truncates existing records (immutable log).
   */
  public logDecision(entry: DecisionLogEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.decisionLogPath, line, 'utf-8');
      this.logger.info({ decisionId: entry.id, type: entry.type, latencyMs: entry.latencyMs, model: entry.modelVersion }, 'LLM decision recorded');
    } catch (cause) {
      // Log but do not crash — decision loss is preferable to agent halt
      this.logger.error({ cause }, 'Failed to write decision log entry');
    }
  }

  /**
   * Records a business metric event (rule 04 — track business events at INFO level).
   */
  public recordBusinessEvent(event: string, data: Record<string, unknown>): void {
    this.logger.info({ event, ...data }, 'Business event');
  }

  /**
   * Emits a structured agent metric snapshot.
   */
  public recordMetrics(metrics: Record<string, number | string | boolean>): void {
    this.logger.info({ metrics }, 'Agent metrics snapshot');
  }
}
