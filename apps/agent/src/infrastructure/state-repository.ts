import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Logger } from 'pino';
import type {
  StrategicPlan,
  DayPlan,
  Task,
} from '@asva/shared-types';
import { AppError, ErrorCodes } from '../cross-cutting/app-error.js';
import type { ConfigLoader } from './config-loader.js';

/**
 * StateRepository — L1 Infrastructure Layer.
 * SQLite-backed persistence (better-sqlite3 + WAL mode).
 *
 * Rule 02: No raw SQL in upper layers. All DB access through this class.
 * All writes are transactional. Soft deletes for important records.
 */
export class StateRepository {
  private readonly db: Database.Database;

  constructor(config: ConfigLoader, private readonly logger: Logger) {
    const dbPath = resolve(process.cwd(), config.get<string>('database.path'));
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_WRITE_FAILED, `Failed to create database directory: ${dirname(dbPath)}`, 500, { cause });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    this.runMigrations();
    this.logger.info({ dbPath }, 'StateRepository: SQLite initialized');
  }

  // ── Strategic Plans ───────────────────────────────────────────────────────

  public saveStrategicPlan(plan: StrategicPlan): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO strategic_plans
          (id, created_at, season, year, primary_goals, crop_calendar, bundle_targets, llm_rationale, model_version, prompt_version)
        VALUES
          (@id, @createdAt, @season, @year, @primaryGoals, @cropCalendar, @bundleTargets, @llmRationale, @modelVersion, @promptVersion)
      `);
      stmt.run({
        id: plan.id,
        createdAt: plan.createdAt,
        season: plan.season,
        year: plan.year,
        primaryGoals: JSON.stringify(plan.primaryGoals),
        cropCalendar: JSON.stringify(plan.cropCalendar),
        bundleTargets: JSON.stringify(plan.bundleTargets),
        llmRationale: plan.llmRationale,
        modelVersion: plan.modelVersion,
        promptVersion: plan.promptVersion,
      });
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_WRITE_FAILED, 'Failed to save strategic plan', 500, { cause });
    }
  }

  public getLatestStrategicPlan(): StrategicPlan | null {
    try {
      const row = this.db
        .prepare('SELECT * FROM strategic_plans ORDER BY created_at DESC LIMIT 1')
        .get() as Record<string, unknown> | undefined;

      if (row === undefined) return null;
      return this.rowToStrategicPlan(row);
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_READ_FAILED, 'Failed to read strategic plan', 500, { cause });
    }
  }

  // ── Day Plans ─────────────────────────────────────────────────────────────

  public saveDayPlan(plan: DayPlan): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO day_plans
          (id, game_day, season, year, tasks, total_energy_cost, llm_rationale, model_version, prompt_version, created_at)
        VALUES
          (@id, @gameDay, @season, @year, @tasks, @totalEnergyCost, @llmRationale, @modelVersion, @promptVersion, @createdAt)
      `);
      stmt.run({
        id: plan.id,
        gameDay: plan.gameDay,
        season: plan.season,
        year: plan.year,
        tasks: JSON.stringify(plan.tasks),
        totalEnergyCost: plan.totalEnergyCost,
        llmRationale: plan.llmRationale,
        modelVersion: plan.modelVersion,
        promptVersion: plan.promptVersion,
        createdAt: plan.createdAt,
      });
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_WRITE_FAILED, 'Failed to save day plan', 500, { cause });
    }
  }

  public getLatestDayPlan(): DayPlan | null {
    try {
      const row = this.db
        .prepare('SELECT * FROM day_plans ORDER BY created_at DESC LIMIT 1')
        .get() as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return {
        id: row['id'] as string,
        gameDay: row['game_day'] as number,
        season: row['season'] as DayPlan['season'],
        year: row['year'] as number,
        tasks: JSON.parse(row['tasks'] as string) as DayPlan['tasks'],
        totalEnergyCost: row['total_energy_cost'] as number,
        llmRationale: row['llm_rationale'] as string,
        modelVersion: row['model_version'] as string,
        promptVersion: row['prompt_version'] as string,
        createdAt: row['created_at'] as string,
      };
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_READ_FAILED, 'Failed to read day plan', 500, { cause });
    }
  }

  // ── Task Queue ────────────────────────────────────────────────────────────

  public saveTasks(tasks: Task[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO tasks
        (id, type, priority, estimated_duration_ticks, energy_cost, prerequisites,
         parameters, status, attempt_count, last_error, created_at, completed_at)
      VALUES
        (@id, @type, @priority, @estimatedDurationTicks, @energyCost, @prerequisites,
         @parameters, @status, @attemptCount, @lastError, @createdAt, @completedAt)
    `);

    const insertMany = this.db.transaction((ts: Task[]) => {
      for (const t of ts) {
        insert.run({
          id: t.id,
          type: t.type,
          priority: t.priority,
          estimatedDurationTicks: t.estimatedDurationTicks,
          energyCost: t.energyCost,
          prerequisites: JSON.stringify(t.prerequisites),
          parameters: JSON.stringify(t.parameters),
          status: t.status,
          attemptCount: t.attemptCount,
          lastError: t.lastError ?? null,
          createdAt: t.createdAt,
          completedAt: t.completedAt ?? null,
        });
      }
    });

    try {
      insertMany(tasks);
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_WRITE_FAILED, 'Failed to save task queue', 500, { cause });
    }
  }

  public getPendingTasks(): Task[] {
    try {
      const rows = this.db
        .prepare("SELECT * FROM tasks WHERE status IN ('pending', 'running') ORDER BY priority DESC")
        .all() as Record<string, unknown>[];
      return rows.map((r) => this.rowToTask(r));
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_READ_FAILED, 'Failed to read pending tasks', 500, { cause });
    }
  }

  /** Atomic agent state snapshot for crash recovery. */
  public snapshotAgentState(state: {
    currentDayPlanId: string | null;
    activeGoalIds: string[];
    replanCount: number;
  }): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO agent_snapshots (id, snapshot, created_at)
        VALUES ('current', @snapshot, @createdAt)
      `).run({ snapshot: JSON.stringify(state), createdAt: new Date().toISOString() });
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_WRITE_FAILED, 'Failed to snapshot agent state', 500, { cause });
    }
  }

  public getAgentSnapshot(): { currentDayPlanId: string | null; activeGoalIds: string[]; replanCount: number } | null {
    try {
      const row = this.db.prepare("SELECT snapshot FROM agent_snapshots WHERE id = 'current'").get() as { snapshot: string } | undefined;
      if (row === undefined) return null;
      return JSON.parse(row.snapshot) as { currentDayPlanId: string | null; activeGoalIds: string[]; replanCount: number };
    } catch (cause) {
      throw new AppError(ErrorCodes.DB_READ_FAILED, 'Failed to read agent snapshot', 500, { cause });
    }
  }

  // ── Migrations ─────────────────────────────────────────────────────────────

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategic_plans (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        season TEXT NOT NULL,
        year INTEGER NOT NULL,
        primary_goals TEXT NOT NULL,
        crop_calendar TEXT NOT NULL,
        bundle_targets TEXT NOT NULL,
        llm_rationale TEXT NOT NULL,
        model_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS day_plans (
        id TEXT PRIMARY KEY,
        game_day INTEGER NOT NULL,
        season TEXT NOT NULL,
        year INTEGER NOT NULL,
        tasks TEXT NOT NULL,
        total_energy_cost REAL NOT NULL,
        llm_rationale TEXT NOT NULL,
        model_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        priority INTEGER NOT NULL,
        estimated_duration_ticks INTEGER NOT NULL,
        energy_cost REAL NOT NULL,
        prerequisites TEXT NOT NULL,
        parameters TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_snapshots (
        id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS experience_records (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        location TEXT NOT NULL,
        season TEXT NOT NULL,
        outcome TEXT NOT NULL,
        details TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_experience_season ON experience_records(season);
      CREATE INDEX IF NOT EXISTS idx_experience_task_type ON experience_records(task_type);
    `);
  }

  private rowToStrategicPlan(row: Record<string, unknown>): StrategicPlan {
    return {
      id: row['id'] as string,
      createdAt: row['created_at'] as string,
      season: row['season'] as StrategicPlan['season'],
      year: row['year'] as number,
      primaryGoals: JSON.parse(row['primary_goals'] as string) as StrategicPlan['primaryGoals'],
      cropCalendar: JSON.parse(row['crop_calendar'] as string) as StrategicPlan['cropCalendar'],
      bundleTargets: JSON.parse(row['bundle_targets'] as string) as StrategicPlan['bundleTargets'],
      llmRationale: row['llm_rationale'] as string,
      modelVersion: row['model_version'] as string,
      promptVersion: row['prompt_version'] as string,
    };
  }

  private rowToTask(row: Record<string, unknown>): Task {
    return {
      id: row['id'] as string,
      type: row['type'] as Task['type'],
      priority: row['priority'] as number,
      estimatedDurationTicks: row['estimated_duration_ticks'] as number,
      energyCost: row['energy_cost'] as number,
      prerequisites: JSON.parse(row['prerequisites'] as string) as string[],
      parameters: JSON.parse(row['parameters'] as string) as Record<string, unknown>,
      status: row['status'] as Task['status'],
      attemptCount: row['attempt_count'] as number,
      lastError: (row['last_error'] as string | null) ?? undefined,
      createdAt: row['created_at'] as string,
      completedAt: (row['completed_at'] as string | null) ?? undefined,
    };
  }
}
