import { MongoClient, ServerApiVersion } from 'mongodb';
import type { Document, ResumeToken } from 'mongodb';
import type { ChangeEvent, OperationType, WatcherHandle } from '../types/index.js';
import type { SupportedChangeDoc } from '../utils/format.js';
import { formatMongoEvent } from '../utils/format.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

export interface MongoWatchConfig {
  connectionUri: string;
  database: string;
  collection: string;
  operationTypes: OperationType[];
  watcherId: string;
  sessionId: string;
  onEvent: (event: ChangeEvent) => Promise<void>;
  onError: (error: Error) => void;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

export async function startMongoWatcher(cfg: MongoWatchConfig): Promise<WatcherHandle> {
  let stopped = false;
  let resumeToken: ResumeToken | undefined;
  let eventCount = 0;
  let lastEventAt: string | undefined;
  let status: WatcherHandle['status'] = 'active';

  const log = logger.child({ watcherId: cfg.watcherId, sessionId: cfg.sessionId, source: 'mongo' });

  async function runStream(): Promise<void> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (stopped) return;

      const client = new MongoClient(cfg.connectionUri, {
        serverApi: { version: ServerApiVersion.v1, strict: true },
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
      });

      try {
        await client.connect();
        log.info('MongoDB connected', { attempt });

        const col = client.db(cfg.database).collection<Document>(cfg.collection);
        const pipeline = [
          { $match: { operationType: { $in: cfg.operationTypes } } },
        ];

        const streamOptions = resumeToken
          ? { fullDocument: 'updateLookup' as const, resumeAfter: resumeToken }
          : { fullDocument: 'updateLookup' as const };

        const changeStream = col.watch(pipeline, streamOptions);

        try {
          for await (const change of changeStream as AsyncIterable<SupportedChangeDoc>) {
            if (stopped) break;
            resumeToken = changeStream.resumeToken;

            const event = formatMongoEvent(change, cfg.watcherId, cfg.database);
            eventCount++;
            lastEventAt = event.timestamp;

            metrics.changeEventsTotal.inc({
              source: 'mongo',
              operation_type: event.operationType,
              watcher_id: cfg.watcherId,
            });

            await cfg.onEvent(event);
          }
        } finally {
          await changeStream.close().catch(() => undefined);
        }

        if (stopped) return;
        // Stream ended without error — retry
        log.warn('Change stream ended unexpectedly, reconnecting');
      } catch (err) {
        if (stopped) {
          await client.close().catch(() => undefined);
          return;
        }

        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          // Max retries exceeded
          status = 'error';
          metrics.watcherErrorsTotal.inc({ source: 'mongo', error_type: 'max_retries_exceeded' });
          cfg.onError(new Error(`Max reconnect attempts exceeded for watcher ${cfg.watcherId}`));
          await client.close().catch(() => undefined);
          return;
        }

        log.warn('MongoDB change stream error, retrying', {
          err: err instanceof Error ? err.message : String(err),
          attempt,
          retryInMs: delay,
        });
        metrics.watcherErrorsTotal.inc({ source: 'mongo', error_type: 'stream_error' });
        await client.close().catch(() => undefined);
        await sleep(delay);
        continue;
      } finally {
        if (!stopped) {
          await client.close().catch(() => undefined);
        }
      }
    }
  }

  // Start in background
  runStream().catch((err: unknown) => {
    status = 'error';
    cfg.onError(err instanceof Error ? err : new Error(String(err)));
  });

  const handle: WatcherHandle = {
    watcherId: cfg.watcherId,
    sessionId: cfg.sessionId,
    source: 'mongo',
    target: `${cfg.database}.${cfg.collection}`,
    createdAt: new Date().toISOString(),
    get status() { return status; },
    get eventCount() { return eventCount; },
    get lastEventAt() { return lastEventAt; },
    stop: async () => {
      stopped = true;
      status = 'stopped';
    },
  };

  return handle;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
