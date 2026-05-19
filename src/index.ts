import 'dotenv/config';
import http from 'http';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { registry } from './state/sessionRegistry.js';
import { createApp } from './http/createApp.js';

const app = createApp(registry, config);
const server = http.createServer(app);

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

server.listen(config.port, () => {
  cleanupTimer = registry.startCleanupTimer(config.cleanupIntervalMs);
  logger.info(`mcp-live-db-stream listening on port ${config.port}`, {
    port: config.port,
    logLevel: config.logLevel,
    sessionTtlMs: config.sessionTtlMs,
  });
});

async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  server.close();

  if (cleanupTimer !== undefined) {
    clearInterval(cleanupTimer);
  }

  const sessions = registry.all();
  await Promise.allSettled(sessions.map(s => registry.closeSession(s.sessionId)));

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled rejection', { reason: reason instanceof Error ? reason.stack : String(reason) });
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
