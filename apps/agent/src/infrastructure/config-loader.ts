import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { AppError, ErrorCodes } from '../cross-cutting/app-error.js';

// ── Config Schema ─────────────────────────────────────────────────────────────

const AgentConfigSchema = z.object({
  ollama: z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().min(1),
  }),
  bridge: z.object({
    host: z.string(),
    port: z.number().int().min(1024).max(65535),
    reconnectDelaysMs: z.array(z.number().int().positive()),
  }),
  agent: z.object({
    tickIntervalMs: z.number().int().positive(),
    maxReplanAttemptsPerTask: z.number().int().min(1),
  }),
  database: z.object({
    path: z.string().min(1),
  }),
  api: z.object({
    port: z.number().int().min(1024).max(65535),
    host: z.string(),
  }),
  log: z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  }),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ── ConfigLoader ──────────────────────────────────────────────────────────────

/**
 * Loads, parses, and validates config.yaml on startup.
 * Throws CONFIG_INVALID if any required field is missing or malformed.
 */
export class ConfigLoader {
  private readonly config: AgentConfig;

  constructor(configPath?: string) {
    const filePath = configPath ?? resolve(process.cwd(), 'config.yaml');
    let raw: unknown;

    let fileContents: string;
    try {
      fileContents = readFileSync(filePath, 'utf-8');
    } catch (cause) {
      throw new AppError(
        ErrorCodes.CONFIG_NOT_FOUND,
        `Could not read config file at ${filePath}`,
        500,
        { cause }
      );
    }

    try {
      raw = yaml.load(fileContents);
    } catch (cause) {
      throw new AppError(
        ErrorCodes.CONFIG_INVALID,
        `Config file at ${filePath} is not valid YAML`,
        500,
        { cause }
      );
    }

    const result = AgentConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new AppError(
        ErrorCodes.CONFIG_INVALID,
        'Configuration file failed schema validation',
        500,
        { cause: result.error, details: result.error.flatten() }
      );
    }

    this.config = result.data;
  }

  /**
   * Type-safe deep-key getter using dot notation.
   * Example: config.get('ollama.model')
   */
  public get<T>(keyPath: string): T {
    const keys = keyPath.split('.');
    let current: unknown = this.config;
    for (const key of keys) {
      if (typeof current !== 'object' || current === null || !(key in current)) {
        throw new AppError(ErrorCodes.CONFIG_INVALID, `Config key not found: ${keyPath}`);
      }
      current = (current as Record<string, unknown>)[key];
    }

    if (current === undefined) {
      throw new AppError(ErrorCodes.CONFIG_INVALID, `Config value is undefined for key: ${keyPath}`);
    }

    return current as T;
  }

  /** Returns the full parsed config object. */
  public getAll(): Readonly<AgentConfig> {
    return Object.freeze({ ...this.config });
  }
}
