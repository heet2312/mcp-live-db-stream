import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { watchMongoCollectionSchema, watchMongoCollectionHandler } from '../tools/watchMongoCollection.js';
import { watchMongoDatabaseSchema, watchMongoDatabaseHandler } from '../tools/watchMongoDatabase.js';
import { watchSqlTableSchema, watchSqlTableHandler } from '../tools/watchSqlTable.js';
import { queryMongoCollectionSchema, queryMongoCollectionHandler } from '../tools/queryMongoCollection.js';
import { getChangeLogSchema, getChangeLogHandler } from '../tools/getChangeLog.js';
import { listWatchersHandler } from '../tools/listWatchers.js';
import { stopWatcherSchema, stopWatcherHandler } from '../tools/stopWatcher.js';
import { readChangeLogResource, readChangeLogByWatcherResource } from '../resources/changeLog.js';

export function createMcpServer(sessionId: string): McpServer {
  const server = new McpServer({
    name: 'mcp-live-db-stream',
    version: '1.0.0',
  });

  // --- Tools ---

  server.registerTool(
    'query_mongo_collection',
    {
      description:
        'Query a MongoDB collection to get a point-in-time snapshot of documents matching a filter. ' +
        'Use this BEFORE or ALONGSIDE watch_mongo_collection to read current document state — ' +
        'the watcher only captures future changes, so call this first to check existing inventory ' +
        'levels or find documents that already meet a condition. ' +
        'Returns up to `limit` documents with full field contents.',
      inputSchema: queryMongoCollectionSchema,
    },
    (args) => queryMongoCollectionHandler(args),
  );

  server.registerTool(
    'watch_mongo_collection',
    {
      description:
        'Watch a single MongoDB collection for real-time changes (insert, update, replace, delete). ' +
        'REQUIREMENT: MongoDB must be running as a replica set or Atlas cluster — standalone instances do not support change streams. ' +
        'All updates include the full document via updateLookup, so you always see the complete ' +
        'current state of changed documents — not just the diff. ' +
        'Each captured event is appended to change://log and a notifications/resources/updated ' +
        'notification is sent for change://log after every event. ' +
        'Call get_change_log after each notification to read the new events. ' +
        'Use the `pipeline` param to pre-filter events server-side (e.g. only when inventory < 10). ' +
        'To watch multiple collections at once, use watch_mongo_database instead. ' +
        'If the watcher shows status "retrying", call list_watchers to see lastError for the root cause. ' +
        'Returns a watcherId — use stop_watcher to unsubscribe.',
      inputSchema: watchMongoCollectionSchema,
    },
    (args) => watchMongoCollectionHandler(args, sessionId, server),
  );

  server.registerTool(
    'watch_mongo_database',
    {
      description:
        'Watch an entire MongoDB database (or a named subset of its collections) for real-time changes. ' +
        'REQUIREMENT: MongoDB must be running as a replica set or Atlas cluster — standalone instances do not support change streams. ' +
        'Use this instead of watch_mongo_collection when monitoring multiple collections simultaneously ' +
        '(e.g. products AND orders). All updates include the full document via updateLookup. ' +
        'Each captured event is appended to change://log and a notifications/resources/updated ' +
        'notification is sent after every event. Call get_change_log to read events. ' +
        'If the watcher shows status "retrying", call list_watchers to see lastError for the root cause. ' +
        'Returns a watcherId — use stop_watcher to unsubscribe.',
      inputSchema: watchMongoDatabaseSchema,
    },
    (args) => watchMongoDatabaseHandler(args, sessionId, server),
  );

  server.registerTool(
    'get_change_log',
    {
      description:
        'Read captured change events from the in-session change log. ' +
        'Call this after receiving a notifications/resources/updated notification for change://log, ' +
        'or at any time to inspect recent changes. ' +
        'Filter by watcherId to isolate a specific stream, by `since` timestamp to get only new events ' +
        'since your last read, and paginate with offset/limit for large logs. ' +
        'Each event includes the full document (where available) so you can inspect current field values ' +
        'without a separate lookup. Returns total count, pagination metadata, and the event array.',
      inputSchema: getChangeLogSchema,
    },
    (args) => getChangeLogHandler(args, sessionId),
  );

  server.registerTool(
    'watch_sql_table',
    {
      description:
        'Watch a SQL Server table for real-time changes via CDC polling (insert, update, delete). ' +
        'Each captured event is appended to change://log and a notifications/resources/updated ' +
        'notification is sent after every event — call get_change_log after each notification ' +
        'to inspect the latest row changes. Returns a watcherId to identify this stream.',
      inputSchema: watchSqlTableSchema,
    },
    (args) => watchSqlTableHandler(args, sessionId, server),
  );

  server.registerTool(
    'list_watchers',
    {
      description:
        'List all active watchers for this session. Shows each watcher\'s ID, source, target, ' +
        'status (active/error/stopped), event count, last event timestamp, and whether a ' +
        'MongoDB resume token has been captured (hasResumeToken — when true, the stream will ' +
        'automatically resume from the last processed event after a disconnection).',
    },
    () => listWatchersHandler(sessionId),
  );

  server.registerTool(
    'stop_watcher',
    {
      description: 'Stop and clean up a specific watcher by its watcherId.',
      inputSchema: stopWatcherSchema,
    },
    (args) => stopWatcherHandler(args.watcherId, sessionId),
  );

  // --- Resources ---

  server.registerResource(
    'change-event-log',
    'change://log',
    { description: 'Last N change events captured across all active watchers in this session. Prefer the get_change_log tool for filtered, paginated access.', mimeType: 'application/json' },
    (_uri) => readChangeLogResource(sessionId),
  );

  server.registerResource(
    'change-event-log-by-watcher',
    new ResourceTemplate('change://log/{watcherId}', { list: undefined }),
    { description: 'Change events filtered by watcherId. Prefer the get_change_log tool for paginated access.', mimeType: 'application/json' },
    (_uri, variables) => {
      const watcherId = Array.isArray(variables['watcherId'])
        ? (variables['watcherId'][0] ?? '')
        : (variables['watcherId'] ?? '');
      return readChangeLogByWatcherResource(sessionId, watcherId);
    },
  );

  return server;
}
