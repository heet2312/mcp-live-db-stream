import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startMongoWatcher } from '../streams/mongo.js';
import { registry } from '../state/sessionRegistry.js';
import { config } from '../config.js';
import { metrics } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import type { ChangeEvent } from '../types/index.js';

export const watchMongoCollectionSchema = z.object({
  connectionUri: z.string().url().describe('MongoDB connection string (mongodb:// or mongodb+srv://)'),
  database: z.string().min(1).max(64),
  collection: z.string().min(1).max(128),
  operationTypes: z
    .array(z.enum(['insert', 'update', 'delete', 'replace']))
    .default(['insert', 'update', 'delete', 'replace']),
  watcherId: z.string().uuid().optional().describe('Optional custom watcher ID. Auto-generated if omitted.'),
});

export type WatchMongoCollectionArgs = z.infer<typeof watchMongoCollectionSchema>;

export async function watchMongoCollectionHandler(
  args: WatchMongoCollectionArgs,
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

      // Push to change log ring buffer
      s.changeLog.push(event);
      if (s.changeLog.length > config.changeLogMaxSize) {
        s.changeLog.shift();
      }

      metrics.changeEventsTotal.inc({
        source: event.source,
        operation_type: event.operationType,
        watcher_id: event.watcherId,
      });

      // Notify client that the change log resource has been updated
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
      logger.error('MongoDB watcher error', { watcherId, sessionId, error: error.message });
    };

    const handle = await startMongoWatcher({
      connectionUri: args.connectionUri,
      database: args.database,
      collection: args.collection,
      operationTypes: args.operationTypes,
      watcherId,
      sessionId,
      onEvent,
      onError,
    });

    session.watchers.set(watcherId, handle);
    metrics.activeWatchers.inc({ source: 'mongo', session_id: sessionId });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            watcherId,
            target: `${args.database}.${args.collection}`,
            operationTypes: args.operationTypes,
            message: 'Watching MongoDB collection. Send stop_watcher to unsubscribe.',
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
