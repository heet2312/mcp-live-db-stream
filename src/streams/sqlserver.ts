import sql from 'mssql';
import { createHash } from 'crypto';
import type { ChangeEvent, OperationType, WatcherHandle } from '../types/index.js';
import { formatSqlEvent } from '../utils/format.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';

export interface SqlWatchConfig {
  server: string;
  database: string;
  username: string;
  password: string;
  table: string;
  pollIntervalMs: number;
  watcherId: string;
  sessionId: string;
  onEvent: (event: ChangeEvent) => Promise<void>;
  onError: (error: Error) => void;
}

const MAX_CDC_ROWS = parseInt(process.env['MAX_CDC_ROWS'] ?? '10000', 10);
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

type Row = Record<string, unknown>;

function hashRow(row: Row): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

async function getPrimaryKeys(pool: sql.ConnectionPool, schema: string, tableName: string): Promise<string[]> {
  const result = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, tableName)
    .query<{ COLUMN_NAME: string }>(`
      SELECT KCU.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS TC
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS KCU
        ON TC.CONSTRAINT_NAME = KCU.CONSTRAINT_NAME
        AND TC.TABLE_SCHEMA = KCU.TABLE_SCHEMA
        AND TC.TABLE_NAME = KCU.TABLE_NAME
      WHERE TC.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND TC.TABLE_SCHEMA = @schema
        AND TC.TABLE_NAME = @table
      ORDER BY KCU.ORDINAL_POSITION
    `);
  return result.recordset.map(r => r.COLUMN_NAME);
}

function buildRowKey(row: Row, pkColumns: string[]): string {
  return pkColumns.map(col => String(row[col] ?? '')).join('::');
}

function buildKeyObject(row: Row, pkColumns: string[]): Record<string, unknown> {
  const key: Record<string, unknown> = {};
  for (const col of pkColumns) {
    key[col] = row[col];
  }
  return key;
}

export async function startSqlWatcher(cfg: SqlWatchConfig): Promise<WatcherHandle> {
  let stopped = false;
  let eventCount = 0;
  let lastEventAt: string | undefined;
  let status: WatcherHandle['status'] = 'active';
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const log = logger.child({ watcherId: cfg.watcherId, sessionId: cfg.sessionId, source: 'sql' });

  const parts = cfg.table.split('.');
  const schemaName = parts[0] ?? 'dbo';
  const tableName = parts[1] ?? cfg.table;
  const quotedTable = `[${schemaName}].[${tableName}]`;

  const poolConfig: sql.config = {
    server: cfg.server,
    database: cfg.database,
    user: cfg.username,
    password: cfg.password,
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
  };

  async function connectWithRetry(): Promise<sql.ConnectionPool> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const pool = new sql.ConnectionPool(poolConfig);
        await pool.connect();
        log.info('SQL Server connected', { attempt });
        return pool;
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw err;
        log.warn('SQL Server connection error, retrying', {
          err: err instanceof Error ? err.message : String(err),
          attempt,
          retryInMs: delay,
        });
        metrics.watcherErrorsTotal.inc({ source: 'sql', error_type: 'connection_error' });
        await sleep(delay);
      }
    }
    throw new Error('Max connection retries exceeded');
  }

  let pool: sql.ConnectionPool;
  let pkColumns: string[];
  let snapshot: Map<string, { hash: string; row: Row }>;

  try {
    pool = await connectWithRetry();
    pkColumns = await getPrimaryKeys(pool, schemaName, tableName);
    if (pkColumns.length === 0) {
      pkColumns = ['id']; // fallback
      log.warn('No primary key found, falling back to "id" column', { table: cfg.table });
    }

    // Initial snapshot
    const initResult = await pool.request().query<Row>(`SELECT TOP ${MAX_CDC_ROWS} * FROM ${quotedTable}`);
    snapshot = new Map();
    for (const row of initResult.recordset) {
      const rowKey = buildRowKey(row, pkColumns);
      snapshot.set(rowKey, { hash: hashRow(row), row });
    }

    if (initResult.recordset.length >= MAX_CDC_ROWS) {
      log.warn('Table exceeds MAX_CDC_ROWS, tracking limited to first rows', {
        table: cfg.table,
        maxRows: MAX_CDC_ROWS,
      });
    }

    log.info('Initial snapshot taken', { rowCount: snapshot.size });
  } catch (err) {
    status = 'error';
    const error = err instanceof Error ? err : new Error(String(err));
    cfg.onError(error);
    return buildHandle();
  }

  async function poll(): Promise<void> {
    if (stopped) return;
    try {
      const result = await pool.request().query<Row>(`SELECT TOP ${MAX_CDC_ROWS} * FROM ${quotedTable}`);
      const current = new Map<string, { hash: string; row: Row }>();
      for (const row of result.recordset) {
        const rowKey = buildRowKey(row, pkColumns);
        current.set(rowKey, { hash: hashRow(row), row });
      }

      const events: Array<{ type: OperationType; key: Record<string, unknown>; oldRow: Row | undefined; newRow: Row | undefined }> = [];

      // Inserts and updates
      for (const [rowKey, { hash, row }] of current) {
        const prev = snapshot.get(rowKey);
        if (!prev) {
          events.push({ type: 'insert', key: buildKeyObject(row, pkColumns), oldRow: undefined, newRow: row });
        } else if (prev.hash !== hash) {
          events.push({ type: 'update', key: buildKeyObject(row, pkColumns), oldRow: prev.row, newRow: row });
        }
      }

      // Deletes
      for (const [rowKey, { row }] of snapshot) {
        if (!current.has(rowKey)) {
          events.push({ type: 'delete', key: buildKeyObject(row, pkColumns), oldRow: row, newRow: undefined });
        }
      }

      snapshot = current;

      for (const ev of events) {
        const changeEvent = formatSqlEvent(
          ev.type,
          ev.key,
          ev.oldRow,
          ev.newRow,
          cfg.watcherId,
          cfg.database,
          cfg.table,
        );
        eventCount++;
        lastEventAt = changeEvent.timestamp;
        metrics.changeEventsTotal.inc({
          source: 'sql',
          operation_type: ev.type,
          watcher_id: cfg.watcherId,
        });
        await cfg.onEvent(changeEvent);
      }
    } catch (err) {
      if (stopped) return;
      log.error('SQL poll error', { err: err instanceof Error ? err.message : String(err) });
      metrics.watcherErrorsTotal.inc({ source: 'sql', error_type: 'poll_error' });
      cfg.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  pollTimer = setInterval(() => {
    poll().catch((err: unknown) =>
      log.error('Unhandled poll error', { err }),
    );
  }, Math.max(500, cfg.pollIntervalMs));

  function buildHandle(): WatcherHandle {
    return {
      watcherId: cfg.watcherId,
      sessionId: cfg.sessionId,
      source: 'sql',
      target: cfg.table,
      createdAt: new Date().toISOString(),
      get status() { return status; },
      get eventCount() { return eventCount; },
      get lastEventAt() { return lastEventAt; },
      stop: async () => {
        stopped = true;
        status = 'stopped';
        if (pollTimer !== undefined) {
          clearInterval(pollTimer);
          pollTimer = undefined;
        }
        try {
          await pool.close();
        } catch {
          // ignore
        }
      },
    };
  }

  return buildHandle();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
