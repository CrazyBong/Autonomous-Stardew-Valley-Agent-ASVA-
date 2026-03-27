import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigLoader } from '../src/infrastructure/config-loader.js';
import { AppError, ErrorCodes } from '../src/cross-cutting/app-error.js';
import { EventBus } from '../src/cross-cutting/event-bus.js';
import { MemoryStore } from '../src/infrastructure/memory-store.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import path from 'node:path';

// ── AppError ──────────────────────────────────────────────────────────────────

describe('AppError', () => {
  it('sets code, message, and statusCode', () => {
    const err = new AppError(ErrorCodes.BRIDGE_DISCONNECTED, 'Bridge is down', 503);
    expect(err.code).toBe('BRIDGE_DISCONNECTED');
    expect(err.message).toBe('Bridge is down');
    expect(err.statusCode).toBe(503);
  });

  it('satisfies instanceof check', () => {
    const err = new AppError(ErrorCodes.DB_WRITE_FAILED, 'write failed');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  it('isAppError returns true for AppError instances', () => {
    const err = new AppError(ErrorCodes.LLM_CALL_FAILED, 'llm failed');
    expect(AppError.isAppError(err)).toBe(true);
    expect(AppError.isAppError(new Error('plain'))).toBe(false);
  });

  it('serialises to JSON without stack trace', () => {
    const err = new AppError(ErrorCodes.PATH_NOT_FOUND, 'no path', 404, { details: { map: 'Farm' } });
    const json = err.toJSON();
    expect(json).toEqual({
      code: 'PATH_NOT_FOUND',
      message: 'no path',
      statusCode: 404,
      details: { map: 'Farm' },
    });
    expect(json).not.toHaveProperty('stack');
  });
});

// ── EventBus ──────────────────────────────────────────────────────────────────

describe('EventBus', () => {
  let bus: EventBus;
  beforeEach(() => { bus = new EventBus(); });

  it('delivers events to subscribers', () => {
    const handler = vi.fn();
    bus.on('day.started', handler);
    bus.emit('day.started', { gameDay: 1, season: 'spring', year: 1 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ gameDay: 1, season: 'spring', year: 1 });
  });

  it('returns an unsubscribe function', () => {
    const handler = vi.fn();
    const unsub = bus.on('task.failed', handler);
    unsub();
    bus.emit('task.failed', { taskId: 't1', type: 'MOVE', error: 'blocked' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('once() fires only one time', () => {
    const handler = vi.fn();
    bus.once('bridge.connected', handler);
    bus.emit('bridge.connected', {});
    bus.emit('bridge.connected', {});
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── ConfigLoader ──────────────────────────────────────────────────────────────

describe('ConfigLoader', () => {
  const tmpDir = path.join(os.tmpdir(), 'asva-test-config');
  const configPath = path.join(tmpDir, 'config.yaml');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(configPath, `
ollama:
  baseUrl: "http://localhost:11434"
  model: "llama3:8b"
  timeoutMs: 15000
  maxRetries: 3
bridge:
  host: "localhost"
  port: 7890
  reconnectDelaysMs: [1000, 2000]
agent:
  tickIntervalMs: 50
  maxReplanAttemptsPerTask: 3
database:
  path: "./data/test.db"
api:
  port: 3000
  host: "127.0.0.1"
log:
  level: "info"
`);
  });

  it('loads and validates a valid config file', () => {
    const loader = new ConfigLoader(configPath);
    expect(loader.get<string>('ollama.model')).toBe('llama3:8b');
    expect(loader.get<number>('bridge.port')).toBe(7890);
  });

  it('throws CONFIG_NOT_FOUND for missing file', () => {
    expect(() => new ConfigLoader('/nonexistent/path/config.yaml'))
      .toThrow(AppError);
  });

  it('throws CONFIG_INVALID for malformed config', () => {
    writeFileSync(configPath, 'ollama:\n  model: 123\n');
    expect(() => new ConfigLoader(configPath))
      .toThrow(AppError);
  });
});

// ── MemoryStore ───────────────────────────────────────────────────────────────

describe('MemoryStore', () => {
  const tmpDir = path.join(os.tmpdir(), 'asva-test-memory');
  const dbPath = path.join(tmpDir, 'test.db');

  const mockConfig = {
    get: (key: string) => {
      if (key === 'database.path') return dbPath;
      return null;
    },
  } as unknown as ConfigLoader;

  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('pino').Logger;

  it('records and retrieves experience by season', async () => {
    mkdirSync(tmpDir, { recursive: true });

    // Need StateRepository to create the tables first
    const { StateRepository } = await import('../src/infrastructure/state-repository.js');
    new StateRepository(mockConfig, mockLogger); // runs migrations

    const store = new MemoryStore(mockConfig, mockLogger);
    store.record({
      taskType: 'FISH',
      location: 'forest_pond',
      season: 'summer',
      outcome: 'success',
      details: { catches: 3 },
    });

    const memories = store.getRelevantMemories({ season: 'summer', taskType: 'FISH' });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ outcome: 'success', season: 'summer' });
  });
});
