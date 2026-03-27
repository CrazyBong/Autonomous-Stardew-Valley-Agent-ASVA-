import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { ExperienceRecord } from '@asva/shared-types';
import { AppError, ErrorCodes } from '../cross-cutting/app-error.js';
import type { ConfigLoader } from './config-loader.js';

/**
 * MemoryStore — L1 Infrastructure Layer.
 * Episodic and semantic memory for the agent.
 * Stores experience records (e.g., fishing success rates) used as
 * context in planning prompts. Tag-based retrieval — no vector DB needed.
 *
 * Rule 02: Append-only inserts, never mutate historical experiences.
 */
export class MemoryStore {
  private readonly db: Database.Database;

  constructor(config: ConfigLoader, _logger: Logger) {
    const dbPath = resolve(process.cwd(), config.get<string>('database.path'));
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_WRITE_FAILED, `Failed to create database directory: ${dirname(dbPath)}`, 500, { cause });
    }

    // Reuse the same database file as StateRepository
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  /**
   * Appends a new experience record. Immutable — never updated after insertion.
   */
  public record(experience: Omit<ExperienceRecord, 'id' | 'recordedAt'>): void {
    try {
      this.db.prepare(`
        INSERT INTO experience_records
          (id, task_type, location, season, outcome, details, recorded_at)
        VALUES
          (@id, @taskType, @location, @season, @outcome, @details, @recordedAt)
      `).run({
        id: randomUUID(),
        taskType: experience.taskType,
        location: experience.location,
        season: experience.season,
        outcome: experience.outcome,
        details: JSON.stringify(experience.details),
        recordedAt: new Date().toISOString(),
      });
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_WRITE_FAILED, 'Failed to write experience record', 500, { cause });
    }
  }

  /**
   * Tag-based retrieval: returns up to `limit` relevant experiences
   * filtered by season and/or task type. Sorted by most recent.
   */
  public getRelevantMemories(
    filters: { season?: string; taskType?: string; location?: string },
    limit = 5
  ): ExperienceRecord[] {
    const conditions: string[] = [];
    const params: Record<string, string> = {};

    if (filters.season !== undefined) {
      conditions.push('season = @season');
      params['season'] = filters.season;
    }
    if (filters.taskType !== undefined) {
      conditions.push('task_type = @taskType');
      params['taskType'] = filters.taskType;
    }
    if (filters.location !== undefined) {
      conditions.push('location = @location');
      params['location'] = filters.location;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM experience_records ${where} ORDER BY recorded_at DESC LIMIT ${limit}`)
      .all(params) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r['id'] as string,
      taskType: r['task_type'] as ExperienceRecord['taskType'],
      location: r['location'] as string,
      season: r['season'] as string,
      outcome: r['outcome'] as ExperienceRecord['outcome'],
      details: JSON.parse(r['details'] as string) as Record<string, unknown>,
      recordedAt: r['recorded_at'] as string,
    }));
  }

  /** Returns aggregate statistics for a given activity in a given season. */
  public getActivityStats(taskType: string, season: string): {
    successRate: number;
    sampleCount: number;
  } {
    try {
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes
        FROM experience_records
        WHERE task_type = @taskType AND season = @season
      `).get({ taskType, season }) as { total: number; successes: number | null };

      const total = row.total;
      const successes = row.successes ?? 0;

      return {
        successRate: total > 0 ? successes / total : 0,
        sampleCount: total,
      };
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_READ_FAILED, 'Failed to calculate activity stats', 500, { cause });
    }
  }
}
