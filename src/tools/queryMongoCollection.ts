import { z } from 'zod';
import { MongoClient, ServerApiVersion } from 'mongodb';
import type { Document } from 'mongodb';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sanitizeDocument } from '../utils/format.js';

export const queryMongoCollectionSchema = z.object({
  connectionUri: z.string().url().describe('MongoDB connection string (mongodb:// or mongodb+srv://)'),
  database: z.string().min(1).max(64).describe('MongoDB database name'),
  collection: z.string().min(1).max(128).describe('Collection to query'),
  filter: z
    .record(z.unknown())
    .default({})
    .describe('MongoDB query filter (JSON). Use {} to return all documents. Example: {"inventory":{"$lt":10}}'),
  projection: z
    .record(z.unknown())
    .optional()
    .describe('Fields to include or exclude (JSON). Example: {"name":1,"sku":1,"inventory":1,"_id":0}'),
  sort: z
    .record(z.unknown())
    .optional()
    .describe('Sort order (JSON). Example: {"inventory":1} for ascending, -1 for descending.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(20)
    .describe('Maximum number of documents to return (1–1000). Defaults to 20.'),
  tls: z.boolean().optional().describe('Enable TLS/SSL. Auto-enabled for mongodb+srv:// URIs.'),
  tlsAllowInvalidCertificates: z
    .boolean()
    .optional()
    .describe('Disable TLS certificate validation. Use only in development.'),
});

export type QueryMongoCollectionArgs = z.infer<typeof queryMongoCollectionSchema>;

function serializeBson(doc: Document): Record<string, unknown> {
  const replacer = (_key: string, value: unknown): unknown => {
    if (value !== null && typeof value === 'object') {
      // ObjectId, Decimal128, etc. expose toHexString or toString
      if (typeof (value as Record<string, unknown>)['toHexString'] === 'function') {
        return (value as { toHexString(): string }).toHexString();
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
    }
    return value;
  };
  return JSON.parse(JSON.stringify(doc, replacer)) as Record<string, unknown>;
}

export async function queryMongoCollectionHandler(
  args: QueryMongoCollectionArgs,
): Promise<CallToolResult> {
  const clientOptions = {
    serverApi: { version: ServerApiVersion.v1, strict: true },
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    ...(args.tls !== undefined ? { tls: args.tls } : {}),
    ...(args.tlsAllowInvalidCertificates !== undefined
      ? { tlsAllowInvalidCertificates: args.tlsAllowInvalidCertificates }
      : {}),
  };

  const client = new MongoClient(args.connectionUri, clientOptions);
  try {
    await client.connect();
    const col = client.db(args.database).collection<Document>(args.collection);

    const cursor = col.find(args.filter as Document, {
      ...(args.projection !== undefined ? { projection: args.projection as Document } : {}),
    });

    if (args.sort !== undefined) {
      cursor.sort(args.sort as Document);
    }
    cursor.limit(args.limit);

    const docs = await cursor.toArray();
    const sanitized = docs.map(d => sanitizeDocument(serializeBson(d)));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              database: args.database,
              collection: args.collection,
              filter: args.filter,
              count: sanitized.length,
              limit: args.limit,
              documents: sanitized,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
