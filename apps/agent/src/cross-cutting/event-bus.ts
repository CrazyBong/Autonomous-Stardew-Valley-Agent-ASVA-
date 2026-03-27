import { EventEmitter } from 'node:events';

/**
 * Typed EventBus — GEMINI Rule 02.
 * Provides pub/sub between layers WITHOUT circular imports.
 * Layers subscribe to events rather than calling upward.
 */

// ── Event Map (all agent events declared here) ────────────────────────────────

export interface AgentEventMap {
  'day.started': { gameDay: number; season: string; year: number };
  'day.ended': { gameDay: number };
  'bridge.connected': Record<string, never>;
  'bridge.disconnected': { reason: string };
  'bridge.reconnected': Record<string, never>;
  'task.completed': { taskId: string; type: string };
  'task.failed': { taskId: string; type: string; error: string };
  'task.blocked': { taskId: string; type: string; attemptCount: number };
  'goal.completed': { goalId: string; type: string };
  'bundle.item.available': { bundleId: string; itemId: string };
  'agent.safe-pause': { reason: string };
  'agent.resumed': Record<string, never>;
  'replan.started': { level: 'daily' | 'tactical' | 'strategic'; reason: string };
  'replan.completed': { level: 'daily' | 'tactical' | 'strategic' };
}

export type AgentEventName = keyof AgentEventMap;

// ── EventBus Class ────────────────────────────────────────────────────────────

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Prevent memory leak warnings for reasonable subscriber counts
    this.emitter.setMaxListeners(50);
  }

  public emit<K extends AgentEventName>(event: K, payload: AgentEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  public on<K extends AgentEventName>(
    event: K,
    handler: (payload: AgentEventMap[K]) => void
  ): () => void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    // Returns an unsubscribe function
    return () => this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  public once<K extends AgentEventName>(
    event: K,
    handler: (payload: AgentEventMap[K]) => void
  ): void {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
  }

  public removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
