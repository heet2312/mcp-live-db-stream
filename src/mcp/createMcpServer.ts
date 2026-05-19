import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { watchMongoCollectionSchema, watchMongoCollectionHandler } from '../tools/watchMongoCollection.js';
import { watchSqlTableSchema, watchSqlTableHandler } from '../tools/watchSqlTable.js';
import { listWatchersHandler } from '../tools/listWatchers.js';
import { stopWatcherHandler } from '../tools/stopWatcher.js';
import { readChangeLogResource, readChangeLogByWatcherResource } from '../resources/changeLog.js';

export function createMcpServer(sessionId: string): McpServer {
  const server = new McpServer({
    name: 'mcp-live-db-stream',
    version: '1.0.0',
  });

  // --- Tools ---

  server.tool(
    'watch_mongo_collection',
    'Subscribe to a MongoDB collection and stream real-time insert/update/delete events. Returns a watcherId you can use to identify the stream.',
    watchMongoCollectionSchema.shape,
    (args) => watchMongoCollectionHandler(args, sessionId, server),
  );

  server.tool(
    'watch_sql_table',
    'Subscribe to a SQL Server table via CDC polling and stream real-time change events. Returns a watcherId you can use to identify the stream.',
    watchSqlTableSchema.shape,
    (args) => watchSqlTableHandler(args, sessionId, server),
  );

  server.tool(
    'list_watchers',
    'List all active watchers for this session.',
    {},
    () => listWatchersHandler(sessionId),
  );

  server.tool(
    'stop_watcher',
    'Stop and clean up a specific watcher by its watcherId.',
    { watcherId: watchSqlTableSchema.shape.watcherId.unwrap() },
    (args) => stopWatcherHandler(args.watcherId, sessionId),
  );

  // --- Resources ---

  server.resource(
    'change-event-log',
    'change://log',
    { description: 'Last N change events captured across all active watchers in this session.', mimeType: 'application/json' },
    (_uri) => readChangeLogResource(sessionId),
  );

  server.resource(
    'change-event-log-by-watcher',
    new ResourceTemplate('change://log/{watcherId}', { list: undefined }),
    { description: 'Change events filtered by watcherId.', mimeType: 'application/json' },
    (_uri, variables) => {
      const watcherId = Array.isArray(variables['watcherId'])
        ? (variables['watcherId'][0] ?? '')
        : (variables['watcherId'] ?? '');
      return readChangeLogByWatcherResource(sessionId, watcherId);
    },
  );

  return server;
}
