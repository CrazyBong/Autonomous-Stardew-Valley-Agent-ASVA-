import pino, { Logger } from 'pino';
import { ConfigLoader } from '../infrastructure/config-loader.js';

/**
 * Structured logger (Pino) — GEMINI Rule 04.
 * - No console.log in production.
 * - Every entry includes timestamp, level, requestId, environment.
 * - Never log PII, passwords, or tokens.
 */

let _logger: Logger | null = null;

export function createLogger(config: ConfigLoader): Logger {
  const logger = pino({
    level: config.get('log.level') as string ?? 'info',
    redact: {
      paths: [
        'password', '*.password', '**.password',
        'token', '*.token', '**.token',
        'secret', '*.secret', '**.secret',
        'apiKey', '*.apiKey', '**.apiKey',
        'authorization', '*.authorization', '**.authorization'
      ],
      censor: '[REDACTED]',
    },
    base: {
      environment: process.env['NODE_ENV'] ?? 'development',
      service: 'asva-agent',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });

  _logger = logger;
  return logger;
}

/** Returns the preconfigured logger instance. Call createLogger first. */
export function getLogger(): Logger {
  if (_logger === null) {
    // Basic fallback for bootstrap phase
    return pino({
      level: 'debug',
      redact: {
        paths: ['password', 'token', 'secret', 'apiKey', 'authorization'],
        censor: '[REDACTED]',
      }
    });
  }
  return _logger;
}

export type { Logger };
