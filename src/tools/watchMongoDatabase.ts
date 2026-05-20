import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startMongoDatabaseWatcher } from '../streams/mongo.js';
import { registry } from '../state/sessionRegistry.js';
import { config } from '../config.js';
import { metrics } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';
import type { ChangeEvent } from '../types/index.js';

export const watchMongoDatabaseSchema = z.object({
  connectionUri: z.string().url().describe('MongoDB connection string (mongodb:// or mongodb+srv://)'),
  database: z.string().min(1).max(64).describe('MongoDB database to watch'),
  collections: z
    .array(z.string().min(1).max(128))
    .optional()
    .describe(
      'Collections to include. Omit (or pass an empty array) to watch every collection in the database. ' +
      'Example: ["products","orders"] to monitor multiple collections simultaneously.',
    ),
  operationTypes: z
    .array(z.enum(['insert', 'update', 'delete', 'replace']))
    .default(['insert', 'update', 'delete', 'replace'])
    .describe('Change event types to capture. Defaults to all four: insert, update, delete, replace.'),
  pipeline: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      'Additional MongoDB aggregation pipeline stages appended after the built-in operationType/collection filter. ' +
      'Only $match, $project, $addFields, $replaceRoot, and $redact are allowed in change stream pipelines.',
    ),
  tls: z.boolean().optional().describe('Enable TLS/SSL. Auto-enabled for mongodb+srv:// URIs.'),
  tlsAllowInvalidCertificates: z
    .boolean()
    .optional()
    .describe('Disable TLS certificate validation. Use only in development with self-signed certificates.'),
  tlsCAFile: z
    .string()
    .optional()
    .describe('Server-side filesystem path to a PEM CA certificate file for TLS verification.'),
  watcherId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Custom label for this watcher (any string). Auto-generated UUID if omitted.'),
});

export type WatchMongoDatabaseArgs = z.infer<typeof watchMongoDatabaseSchema>;

export async function watchMongoDatabaseHandler(
  args: WatchMongoDatabaseArgs,
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
    const collections = args.collections?.length ? args.collections : undefined;

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
      logger.error('MongoDB database watcher error', { watcherId, sessionId, error: error.message });
    };

    const handle = await startMongoDatabaseWatcher({
      connectionUri: args.connectionUri,
      database: args.database,
      operationTypes: args.operationTypes,
      watcherId,
      sessionId,
      onEvent,
      onError,
      ...(collections !== undefined ? { collections } : {}),
      ...(args.pipeline !== undefined ? { pipeline: args.pipeline as Record<string, unknown>[] } : {}),
      ...(args.tls !== undefined ? { tls: args.tls } : {}),
      ...(args.tlsAllowInvalidCertificates !== undefined
        ? { tlsAllowInvalidCertificates: args.tlsAllowInvalidCertificates }
        : {}),
      ...(args.tlsCAFile !== undefined ? { tlsCAFile: args.tlsCAFile } : {}),
    });

    session.watchers.set(watcherId, handle);
    metrics.activeWatchers.inc({ source: 'mongo', session_id: sessionId });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            watcherId,
            database: args.database,
            collections: collections ?? 'all',
            operationTypes: args.operationTypes,
            hasPipeline: (args.pipeline?.length ?? 0) > 0,
            fullDocumentMode: 'updateLookup',
            message:
              'Watching MongoDB database. Events are appended to change://log and a ' +
              'notifications/resources/updated notification is sent after each one. ' +
              'Call get_change_log to read events. Call stop_watcher to unsubscribe.',
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
