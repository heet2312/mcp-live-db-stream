import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startSqlWatcher } from '../streams/sqlserver.js';
import { registry } from '../state/sessionRegistry.js';
import { config } from '../config.js';
import { metrics } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import type { ChangeEvent } from '../types/index.js';

export const watchSqlTableSchema = z.object({
  server: z.string().min(1),
  database: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  table: z.string().regex(/^\w+\.\w+$/, 'Must be schema.tablename format'),
  pollIntervalMs: z.number().int().min(500).max(60000).default(2000),
  watcherId: z.string().uuid().optional(),
});

export type WatchSqlTableArgs = z.infer<typeof watchSqlTableSchema>;

export async function watchSqlTableHandler(
  args: WatchSqlTableArgs,
  sessionId: string,
  server: McpServer,
): Promise<CallToolResult> {
  try {
    const session = registry.getSession(sessionId);
    if (!session) {
      return { content: [{ type: 'text', text: `Error: session ${sessionId} not found` }], isError: true };
    }

    if (session.watchers.size >= config.maxWatchersPerSession) {
      return {
        content: [{ type: 'text', text: `Error: max watchers per session (${config.maxWatchersPerSession}) exceeded` }],
        isError: true,
      };
    }

    const watcherId = args.watcherId ?? uuidv4();

    const onEvent = async (event: ChangeEvent): Promise<void> => {
      const s = registry.getSession(sessionId);
      if (!s) return;

      s.changeLog.push(event);
      if (s.changeLog.length > config.changeLogMaxSize) {
        s.changeLog.shift();
      }

      metrics.changeEventsTotal.inc({
        source: event.source,
        operation_type: event.operationType,
        watcher_id: event.watcherId,
      });

      try {
        await server.server.notification({
          method: 'notifications/resources/updated',
          params: { uri: 'change://log' },
        });
      } catch {
        // client may have disconnected
      }
    };

    const onError = (error: Error): void => {
      logger.error('SQL watcher error', { watcherId, sessionId, error: error.message });
    };

    const handle = await startSqlWatcher({
      server: args.server,
      database: args.database,
      username: args.username,
      password: args.password,
      table: args.table,
      pollIntervalMs: args.pollIntervalMs,
      watcherId,
      sessionId,
      onEvent,
      onError,
    });

    session.watchers.set(watcherId, handle);
    metrics.activeWatchers.inc({ source: 'sql', session_id: sessionId });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            watcherId,
            target: args.table,
            pollIntervalMs: args.pollIntervalMs,
            message: 'Watching SQL Server table via CDC polling. Send stop_watcher to unsubscribe.',
          }, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
