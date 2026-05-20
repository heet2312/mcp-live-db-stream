import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registry } from '../state/sessionRegistry.js';

export const getChangeLogSchema = z.object({
  watcherId: z
    .string()
    .optional()
    .describe('Filter events to a specific watcher ID. Omit to return events from all watchers.'),
  since: z
    .string()
    .optional()
    .describe(
      'Return only events at or after this ISO 8601 timestamp (e.g. "2024-01-15T10:00:00Z"). ' +
      'Use the timestamp of the last event you processed to get only new events.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Number of matching events to skip for pagination. Defaults to 0.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum number of events to return (1–200). Defaults to 50.'),
});

export type GetChangeLogArgs = z.infer<typeof getChangeLogSchema>;

export async function getChangeLogHandler(
  args: GetChangeLogArgs,
  sessionId: string,
): Promise<CallToolResult> {
  try {
    const session = registry.getSession(sessionId);
    if (!session) {
      return { content: [{ type: 'text', text: `Error: session ${sessionId} not found` }], isError: true };
    }

    let events = session.changeLog;

    if (args.watcherId !== undefined) {
      events = events.filter(e => e.watcherId === args.watcherId);
    }

    if (args.since !== undefined) {
      const sinceMs = new Date(args.since).getTime();
      if (isNaN(sinceMs)) {
        return {
          content: [{ type: 'text', text: `Error: invalid "since" timestamp: ${args.since}` }],
          isError: true,
        };
      }
      events = events.filter(e => new Date(e.timestamp).getTime() >= sinceMs);
    }

    const total = events.length;
    const page = events.slice(args.offset, args.offset + args.limit);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              total,
              offset: args.offset,
              limit: args.limit,
              returned: page.length,
              hasMore: args.offset + page.length < total,
              events: page,
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
  }
}
