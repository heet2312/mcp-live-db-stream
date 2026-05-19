import { v4 as uuidv4 } from 'uuid';
import type { ChangeEvent, OperationType } from '../types/index.js';
import type {
  ChangeStreamInsertDocument,
  ChangeStreamUpdateDocument,
  ChangeStreamReplaceDocument,
  ChangeStreamDeleteDocument,
  Document,
} from 'mongodb';

const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 10;

export function sanitizeDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (value instanceof Buffer || (typeof value === 'object' && value !== null && 'buffer' in value)) {
      continue;
    }
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      result[key] = value.slice(0, MAX_STRING_LENGTH) + '…';
    } else if (Array.isArray(value)) {
      result[key] = value.slice(0, MAX_ARRAY_LENGTH);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeDocument(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

type NsDoc = { ns?: { db?: string; coll?: string } };
type KeyDoc = { documentKey?: Record<string, unknown> };

function extractNs(doc: NsDoc, fallbackDb: string): { database: string; collection: string } {
  return {
    database: doc.ns?.db ?? fallbackDb,
    collection: doc.ns?.coll ?? 'unknown',
  };
}

function serializeKey(doc: KeyDoc): Record<string, unknown> {
  const key = doc.documentKey ?? {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(key)) {
    result[k] = typeof v === 'object' && v !== null && 'toString' in v ? String(v) : v;
  }
  return result;
}

export type SupportedChangeDoc =
  | ChangeStreamInsertDocument<Document>
  | ChangeStreamUpdateDocument<Document>
  | ChangeStreamReplaceDocument<Document>
  | ChangeStreamDeleteDocument<Document>;

export function formatMongoEvent(
  raw: SupportedChangeDoc,
  watcherId: string,
  db: string,
): ChangeEvent {
  const { database, collection } = extractNs(raw as NsDoc, db);
  const documentKey = serializeKey(raw as KeyDoc);

  const base = {
    watcherId,
    eventId: uuidv4(),
    timestamp: new Date().toISOString(),
    source: 'mongo' as const,
    database,
    collection,
    documentKey,
  };

  if (raw.operationType === 'insert') {
    const fullDoc = raw.fullDocument
      ? sanitizeDocument(raw.fullDocument as Record<string, unknown>)
      : undefined;
    return {
      ...base,
      operationType: 'insert',
      ...(fullDoc !== undefined ? { fullDocument: fullDoc } : {}),
    };
  }

  if (raw.operationType === 'update') {
    const fullDoc = raw.fullDocument
      ? sanitizeDocument(raw.fullDocument as Record<string, unknown>)
      : undefined;
    const ud = raw.updateDescription;
    const updatedFields = ud?.updatedFields
      ? sanitizeDocument(ud.updatedFields as Record<string, unknown>)
      : undefined;
    const removedFields = ud?.removedFields ?? undefined;
    const updateDescription =
      updatedFields !== undefined || removedFields !== undefined
        ? {
            ...(updatedFields !== undefined ? { updatedFields } : {}),
            ...(removedFields !== undefined ? { removedFields } : {}),
          }
        : undefined;
    return {
      ...base,
      operationType: 'update',
      ...(fullDoc !== undefined ? { fullDocument: fullDoc } : {}),
      ...(updateDescription !== undefined ? { updateDescription } : {}),
    };
  }

  if (raw.operationType === 'replace') {
    const fullDoc = raw.fullDocument
      ? sanitizeDocument(raw.fullDocument as Record<string, unknown>)
      : undefined;
    return {
      ...base,
      operationType: 'replace',
      ...(fullDoc !== undefined ? { fullDocument: fullDoc } : {}),
    };
  }

  // delete
  return { ...base, operationType: 'delete' };
}

export function formatSqlEvent(
  type: OperationType,
  key: Record<string, unknown>,
  oldRow: unknown,
  newRow: unknown,
  watcherId: string,
  db: string,
  table: string,
): ChangeEvent {
  const parts = table.split('.');
  const collection = parts[1] ?? table;
  const base = {
    watcherId,
    eventId: uuidv4(),
    timestamp: new Date().toISOString(),
    source: 'sql' as const,
    database: db,
    collection,
    documentKey: key,
    operationType: type,
  };

  if (type === 'insert') {
    const fullDoc = newRow ? sanitizeDocument(newRow as Record<string, unknown>) : undefined;
    return { ...base, ...(fullDoc !== undefined ? { fullDocument: fullDoc } : {}) };
  }

  if (type === 'delete') {
    return base;
  }

  // update — compute diff
  const oldObj = (oldRow ?? {}) as Record<string, unknown>;
  const newObj = (newRow ?? {}) as Record<string, unknown>;
  const updatedFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(newObj)) {
    if (JSON.stringify(v) !== JSON.stringify(oldObj[k])) {
      updatedFields[k] = v;
    }
  }
  const updateDescription = Object.keys(updatedFields).length > 0
    ? { updatedFields }
    : undefined;
  return {
    ...base,
    ...(updateDescription !== undefined ? { updateDescription } : {}),
  };
}
