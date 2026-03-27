import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  GameStateSnapshotSchema,
  type GameStateSnapshot,
  type GameAction,
} from '@asva/shared-types';
import { AppError, ErrorCodes } from '../cross-cutting/app-error.js';
import type { EventBus } from '../cross-cutting/event-bus.js';
import type { ConfigLoader } from './config-loader.js';

/**
 * SMAPIBridge — L1 Infrastructure Layer.
 * WebSocket client to the SMAPI mod server (ws://localhost:7890).
 * Handles connection, reconnection, and all game I/O.
 *
 * Rule 02: All game interaction routes through here — no other module
 * accesses the bridge directly.
 */
export class SMAPIBridge {
  private ws: WebSocket | null = null;
  private latestState: GameStateSnapshot | null = null;
  private readonly bridgeUrl: string;
  private readonly reconnectDelays: readonly number[];
  private reconnecting = false;
  private closed = false;

  constructor(
    config: ConfigLoader,
    private readonly eventBus: EventBus,
    private readonly logger: Logger
  ) {
    const host = config.get<string>('bridge.host');
    const port = config.get<number>('bridge.port');
    this.bridgeUrl = `ws://${host}:${port}`;
    this.reconnectDelays = config.get<number[]>('bridge.reconnectDelaysMs');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Connects to the SMAPI bridge. Rejects if initial connection fails. */
  public async connect(): Promise<void> {
    this.closed = false;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    return new Promise((resolve, reject) => {
      this.logger.info({ url: this.bridgeUrl }, 'SMAPIBridge: connecting');
      const ws = new WebSocket(this.bridgeUrl);

      const onInitialError = (err: Error) => {
        ws.removeAllListeners();
        this.logger.error({ err }, 'SMAPIBridge: initial connection error');
        reject(new AppError(ErrorCodes.BRIDGE_DISCONNECTED, err.message, 503, { cause: err }));
      };

      const onInitialOpen = () => {
        ws.removeListener('error', onInitialError);
        this.ws = ws;
        this.logger.info({}, 'SMAPIBridge: connected');
        this.setupHandlers();
        this.eventBus.emit('bridge.connected', {});
        resolve();
      };

      ws.once('open', onInitialOpen);
      ws.once('error', onInitialError);
    });
  }

  /** Gracefully closes the bridge connection. */
  public close(): void {
    if (this.ws) {
      this.closed = true;
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
      this.logger.info({}, 'SMAPIBridge: connection closed by agent');
    }
  }

  /** Sends a typed action to the SMAPI bridge. */
  public async dispatch(action: GameAction): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new AppError(ErrorCodes.BRIDGE_DISCONNECTED, 'Cannot dispatch: bridge not connected', 503);
    }

    const message = JSON.stringify({
      messageId: randomUUID(),
      timestamp: new Date().toISOString(),
      type: action.type,
      payload: 'payload' in action ? action.payload : undefined,
    });

    return new Promise((resolve, reject) => {
      this.ws!.send(message, (err) => {
        if (err) {
          reject(new AppError(ErrorCodes.BRIDGE_TIMEOUT, `Dispatch failed: ${err.message}`, 503, { cause: err }));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Returns the latest game state snapshot (in-memory, no I/O).
   * Updated on every 50ms tick from the bridge.
   */
  public getLatestState(): GameStateSnapshot {
    if (this.latestState === null) {
      throw new AppError(ErrorCodes.BRIDGE_DISCONNECTED, 'No game state received yet', 503);
    }
    return this.latestState;
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private setupHandlers(): void {
    if (!this.ws) return;

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (typeof msg !== 'object' || msg === null || !('type' in msg)) return;

        if (msg.type === 'GAME_STATE_UPDATE') {
          const result = GameStateSnapshotSchema.safeParse(msg.payload);
          if (result.success) {
            this.latestState = result.data;
          } else {
            this.logger.warn({ errors: result.error.issues }, 'SMAPIBridge: invalid state snapshot received');
          }
        } else if (msg.type === 'DAY_STARTED') {
          const p = msg.payload as Record<string, unknown>;
          if (typeof p?.day === 'number' && typeof p?.season === 'string' && typeof p?.year === 'number') {
            this.eventBus.emit('day.started', { gameDay: p.day, season: p.season as 'spring' | 'summer' | 'fall' | 'winter', year: p.year });
          }
        } else if (msg.type === 'DAY_ENDED') {
          const p = msg.payload as Record<string, unknown>;
          if (typeof p?.day === 'number') {
            this.eventBus.emit('day.ended', { gameDay: p.day });
          }
        }
      } catch (err) {
        this.logger.error({ err }, 'SMAPIBridge: message parse error');
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error({ err }, 'SMAPIBridge: socket error');
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason.toString();
      this.logger.warn({ code, reason: reasonStr }, 'SMAPIBridge: connection closed');
      this.eventBus.emit('bridge.disconnected', { reason: reasonStr });
      void this.scheduleReconnect();
    });
  }

  /** Exponential backoff reconnection — enters safe-pause after all delays exhausted. */
  private async scheduleReconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    for (const delayMs of this.reconnectDelays) {
      await new Promise((r) => setTimeout(r, delayMs));
      if (this.closed) {
        this.reconnecting = false;
        return;
      }
      this.logger.info({ delayMs }, 'SMAPIBridge: attempting reconnect');
      try {
        await this.connect();
        this.logger.info({}, 'SMAPIBridge: reconnected successfully');
        this.eventBus.emit('bridge.reconnected', {});
        this.reconnecting = false;
        return;
      } catch {
        this.logger.warn({ delayMs }, 'SMAPIBridge: reconnect attempt failed');
      }
    }

    this.logger.error({}, 'SMAPIBridge: all reconnect attempts exhausted — safe pause initiated');
    this.eventBus.emit('agent.safe-pause', { reason: ErrorCodes.BRIDGE_DISCONNECTED });
    this.reconnecting = false;
  }
}
