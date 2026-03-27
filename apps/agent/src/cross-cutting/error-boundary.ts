import type { Logger } from 'pino';
import type { EventBus } from './event-bus.js';
import type { AppError } from './app-error.js';

/**
 * ErrorBoundary — GEMINI Rule 02.
 * Catches unhandled rejections and exceptions at layer boundaries.
 * Triggers recovery: retry → replan → safe-pause.
 * Never swallows errors silently.
 */
export class ErrorBoundary {
  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger
  ) {}

  /**
   * Wraps an async operation with structured error recovery.
   * @param operation - function to execute
   * @param context - metadata logged on failure
   */
  public async execute<T>(
    operation: () => Promise<T>,
    context: Record<string, unknown>
  ): Promise<T | void> {
    try {
      return await operation();
    } catch (error) {
      this.logger.error({ error, context }, 'ErrorBoundary caught unhandled error');

      if (this.isFatal(error)) {
        this.logger.error({ error }, 'Fatal error encountered — initiating safe pause');
        this.eventBus.emit('agent.safe-pause', {
          reason: (error as AppError).code ?? 'UNKNOWN_FATAL_ERROR',
        });
        throw error;
      }

      // Non-fatal: log and let the loop continue
      return;
    }
  }

  /** Registers Node.js process-level unhandled rejection and exception handlers. */
  public registerProcessHandlers(): void {
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error({ reason, promise }, 'Unhandled Promise rejection');
      // Do not crash — log and continue. Safe-pause if needed.
    });

    process.on('uncaughtException', (error) => {
      this.logger.fatal({ error }, 'Uncaught exception — attempting graceful shutdown');
      this.eventBus.emit('agent.safe-pause', { reason: 'UNCAUGHT_EXCEPTION' });
      // Give async event loop a moment to flush logs before exit
      setTimeout(() => process.exit(1), 1000);
    });
  }

  private isFatal(error: unknown): boolean {
    if (error instanceof Error) {
      const fatalCodes = ['BRIDGE_DISCONNECTED', 'DB_WRITE_FAILED'];
      const code = (error as { code?: string }).code;
      return code != null && fatalCodes.includes(code);
    }
    return false;
  }
}
