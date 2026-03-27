/**
 * Process bootstrap — ASVA Agent entry point.
 * Wires all dependencies and starts the agent loop.
 */
import { ConfigLoader } from './infrastructure/config-loader.js';
import { SMAPIBridge } from './infrastructure/smapi-bridge.js';
import { StateRepository } from './infrastructure/state-repository.js';
import { MemoryStore } from './infrastructure/memory-store.js';
import { EventBus } from './cross-cutting/event-bus.js';
import { ErrorBoundary } from './cross-cutting/error-boundary.js';
import { createLogger } from './cross-cutting/logger.js';
import { ObservabilityService } from './cross-cutting/observability-service.js';
import { OllamaClient } from './infrastructure/ollama-client.js';
import { Agent } from './agent.js';

async function main(): Promise<void> {
  // 1. Config
  const config = new ConfigLoader();

  // 2. Logger (depends on config)
  const logger = createLogger(config);
  logger.info({ nodeVersion: process.version }, 'ASVA Agent starting up');

  // 3. Cross-cutting services
  const eventBus = new EventBus();
  const observability = new ObservabilityService(logger);
  const errorBoundary = new ErrorBoundary(eventBus, logger);
  errorBoundary.registerProcessHandlers();

  // 4. Infrastructure (L1)
  const stateRepository = new StateRepository(config, logger);
  const memoryStore = new MemoryStore(stateRepository.db, logger);
  const ollamaClient = new OllamaClient(config, observability, logger);
  const smapiBridge = new SMAPIBridge(config, eventBus, logger);

  // 5. Ollama health check
  const ollamaOk = await ollamaClient.healthCheck();
  if (!ollamaOk) {
    logger.warn('Ollama is not reachable — agent will use fallback plans until recovered');
  } else {
    logger.info({ model: config.get<string>('ollama.model') }, 'Ollama health check passed');
  }

  // 6. SMAPI Bridge connection
  try {
    await smapiBridge.connect();
    logger.info('SMAPI bridge connected — waiting for game state');
  } catch (err) {
    logger.error({ err }, 'Failed to connect to SMAPI bridge — will retry in background');
  }

  // 7. Agent
  const tickIntervalMs = config.get<number>('agent.tickIntervalMs');
  const agent = new Agent(
    smapiBridge,
    eventBus,
    errorBoundary,
    observability,
    stateRepository,
    memoryStore,
    ollamaClient,
    logger,
    tickIntervalMs
  );

  // 8. Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal — draining agent loop');
    
    // Safety net: force exit after 10s if loop hangs
    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out — forcing exit');
      process.exit(1);
    }, 10000);

    agent.stop().then(() => {
      clearTimeout(forceExit);
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 9. Start
  await agent.run();
}

main().catch((err) => {
  // Last-resort catch — this should never fire under normal operation
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
