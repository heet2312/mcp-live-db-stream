import { MongoClient, ServerApiVersion } from 'mongodb';
import type { Document, ResumeToken, ChangeStream } from 'mongodb';
import type { ChangeEvent, OperationType, WatcherHandle } from '../types/index.js';
import type { SupportedChangeDoc } from '../utils/format.js';
import { formatMongoEvent } from '../utils/format.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

interface BaseCfg {
  connectionUri: string;
  database: string;
  tls?: boolean;
  tlsAllowInvalidCertificates?: boolean;
  tlsCAFile?: string;
  operationTypes: OperationType[];
  pipeline?: Document[];
  watcherId: string;
  sessionId: string;
  onEvent: (event: ChangeEvent) => Promise<void>;
  onError: (error: Error) => void;
}

export interface MongoWatchConfig extends BaseCfg {
  collection: string;
}

export interface MongoDatabaseWatchConfig extends BaseCfg {
  collections?: string[];
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

type StreamState = {
  stopped: boolean;
  resumeToken: ResumeToken | undefined;
  eventCount: number;
  lastEventAt: string | undefined;
  lastError: string | undefined;
  status: WatcherHandle['status'];
  currentStream: ChangeStream | undefined;
};

type OpenStream = (client: MongoClient, resumeToken: ResumeToken | undefined) => ChangeStream;

function buildClient(cfg: BaseCfg): MongoClient {
  return new MongoClient(cfg.connectionUri, {
    serverApi: { version: ServerApiVersion.v1, strict: true },
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    ...(cfg.tls !== undefined ? { tls: cfg.tls } : {}),
    ...(cfg.tlsAllowInvalidCertificates !== undefined ? { tlsAllowInvalidCertificates: cfg.tlsAllowInvalidCertificates } : {}),
    ...(cfg.tlsCAFile !== undefined ? { tlsCAFile: cfg.tlsCAFile } : {}),
  });
}

function buildStreamOptions(resumeToken: ResumeToken | undefined) {
  return resumeToken
    ? { fullDocument: 'updateLookup' as const, resumeAfter: resumeToken }
    : { fullDocument: 'updateLookup' as const };
}

async function runMongoStream(
  cfg: BaseCfg,
  target: string,
  openStream: OpenStream,
  state: StreamState,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (state.stopped) return;

    const client = buildClient(cfg);
    try {
      await client.connect();
      state.status = 'active';
      state.lastError = undefined;
      log.info('MongoDB connected', { attempt, target });

      const changeStream = openStream(client, state.resumeToken);
      state.currentStream = changeStream;

      try {
        for await (const change of changeStream as AsyncIterable<SupportedChangeDoc>) {
          if (state.stopped) break;
          state.resumeToken = changeStream.resumeToken as ResumeToken;

          const event = formatMongoEvent(change, cfg.watcherId, cfg.database);
          state.eventCount++;
          state.lastEventAt = event.timestamp;

          metrics.changeEventsTotal.inc({
            source: 'mongo',
            operation_type: event.operationType,
            watcher_id: cfg.watcherId,
          });

          await cfg.onEvent(event);
        }
      } finally {
        state.currentStream = undefined;
        await changeStream.close().catch(() => undefined);
      }

      if (state.stopped) return;
      log.warn('Change stream ended unexpectedly, reconnecting', { target });
    } catch (err) {
      if (state.stopped) return;

      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        state.status = 'error';
        metrics.watcherErrorsTotal.inc({ source: 'mongo', error_type: 'max_retries_exceeded' });
        cfg.onError(new Error(`Max reconnect attempts exceeded for watcher ${cfg.watcherId}`));
        return;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      state.lastError = errMsg;
      state.status = 'retrying';
      log.warn('MongoDB change stream error, retrying', {
        err: errMsg,
        attempt,
        retryInMs: delay,
        target,
      });
      metrics.watcherErrorsTotal.inc({ source: 'mongo', error_type: 'stream_error' });
      await sleep(delay);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function buildHandle(cfg: BaseCfg, target: string, state: StreamState): WatcherHandle {
  return {
    watcherId: cfg.watcherId,
    sessionId: cfg.sessionId,
    source: 'mongo',
    target,
    createdAt: new Date().toISOString(),
    get status() { return state.status; },
    get eventCount() { return state.eventCount; },
    get lastEventAt() { return state.lastEventAt; },
    get lastError() { return state.lastError; },
    get hasResumeToken() { return state.resumeToken !== undefined; },
    stop: async () => {
      state.stopped = true;
      state.status = 'stopped';
      if (state.currentStream) {
        await state.currentStream.close().catch(() => undefined);
      }
    },
  };
}

export async function startMongoWatcher(cfg: MongoWatchConfig): Promise<WatcherHandle> {
  const state: StreamState = {
    stopped: false,
    resumeToken: undefined,
    eventCount: 0,
    lastEventAt: undefined,
    lastError: undefined,
    status: 'active',
    currentStream: undefined,
  };
  const target = `${cfg.database}.${cfg.collection}`;
  const log = logger.child({ watcherId: cfg.watcherId, sessionId: cfg.sessionId, source: 'mongo' });

  const builtPipeline: Document[] = [
    { $match: { operationType: { $in: cfg.operationTypes } } },
    ...(cfg.pipeline ?? []),
  ];

  const openStream: OpenStream = (client, resumeToken) =>
    client.db(cfg.database).collection<Document>(cfg.collection).watch(builtPipeline, buildStreamOptions(resumeToken));

  runMongoStream(cfg, target, openStream, state, log).catch((err: unknown) => {
    state.status = 'error';
    cfg.onError(err instanceof Error ? err : new Error(String(err)));
  });

  return buildHandle(cfg, target, state);
}

export async function startMongoDatabaseWatcher(cfg: MongoDatabaseWatchConfig): Promise<WatcherHandle> {
  const state: StreamState = {
    stopped: false,
    resumeToken: undefined,
    eventCount: 0,
    lastEventAt: undefined,
    lastError: undefined,
    status: 'active',
    currentStream: undefined,
  };
  const collectionLabel = cfg.collections?.length ? cfg.collections.join(',') : '*';
  const target = `${cfg.database}.[${collectionLabel}]`;
  const log = logger.child({ watcherId: cfg.watcherId, sessionId: cfg.sessionId, source: 'mongo' });

  const matchStage: Document = { operationType: { $in: cfg.operationTypes } };
  if (cfg.collections?.length) {
    matchStage['ns.coll'] = { $in: cfg.collections };
  }
  const builtPipeline: Document[] = [
    { $match: matchStage },
    ...(cfg.pipeline ?? []),
  ];

  const openStream: OpenStream = (client, resumeToken) =>
    client.db(cfg.database).watch(builtPipeline, buildStreamOptions(resumeToken));

  runMongoStream(cfg, target, openStream, state, log).catch((err: unknown) => {
    state.status = 'error';
    cfg.onError(err instanceof Error ? err : new Error(String(err)));
  });

  return buildHandle(cfg, target, state);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
