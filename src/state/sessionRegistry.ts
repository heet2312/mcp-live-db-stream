import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ISessionRegistry, SessionRuntime } from '../types/index.js';
import { metrics } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';

const sessions = new Map<string, SessionRuntime>();

function createSession(
  sessionId: string,
  transport: StreamableHTTPServerTransport,
  server: McpServer,
): SessionRuntime {
  const runtime: SessionRuntime = {
    sessionId,
    transport,
    server,
    watchers: new Map(),
    changeLog: [],
    createdAt: new Date(),
    lastActiveAt: new Date(),
  };
  sessions.set(sessionId, runtime);
  metrics.activeSessions.set(sessions.size);
  logger.info('Session created', { sessionId });
  return runtime;
}

function getSession(sessionId: string): SessionRuntime | undefined {
  return sessions.get(sessionId);
}

function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActiveAt = new Date();
  }
}

async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  const durationSec = (Date.now() - session.createdAt.getTime()) / 1000;
  metrics.sessionDuration.observe(durationSec);

  // Stop all watchers
  const stopPromises: Promise<void>[] = [];
  for (const [watcherId, watcher] of session.watchers) {
    logger.info('Stopping watcher on session close', { sessionId, watcherId });
    stopPromises.push(
      watcher.stop().catch((err: unknown) => {
        logger.warn('Error stopping watcher', { sessionId, watcherId, err });
      }),
    );
  }
  await Promise.allSettled(stopPromises);
  session.watchers.clear();

  try {
    await session.transport.close();
  } catch (err) {
    logger.warn('Error closing transport', { sessionId, err });
  }

  sessions.delete(sessionId);
  metrics.activeSessions.set(sessions.size);
  logger.info('Session closed', { sessionId });
}

async function expireIdleSessions(ttlMs: number): Promise<void> {
  const now = Date.now();
  const expired: string[] = [];
  for (const [sessionId, session] of sessions) {
    if (now - session.lastActiveAt.getTime() > ttlMs) {
      expired.push(sessionId);
    }
  }
  for (const sessionId of expired) {
    logger.info('Expiring idle session', { sessionId });
    await closeSession(sessionId);
  }
}

function startCleanupTimer(intervalMs: number): ReturnType<typeof setInterval> {
  return setInterval(() => {
    expireIdleSessions(intervalMs).catch((err: unknown) =>
      logger.error('Error during session cleanup', { err }),
    );
  }, intervalMs);
}

function getSessionStats(): {
  count: number;
  sessions: Array<{ sessionId: string; createdAt: Date; lastActiveAt: Date; watcherCount: number }>;
} {
  return {
    count: sessions.size,
    sessions: Array.from(sessions.values()).map(s => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      watcherCount: s.watchers.size,
    })),
  };
}

function all(): SessionRuntime[] {
  return Array.from(sessions.values());
}

function count(): number {
  return sessions.size;
}

export const registry: ISessionRegistry = {
  createSession,
  getSession,
  touchSession,
  closeSession,
  expireIdleSessions,
  startCleanupTimer,
  getSessionStats,
  all,
  count,
};
