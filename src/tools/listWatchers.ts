import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registry } from '../state/sessionRegistry.js';

export async function listWatchersHandler(sessionId: string): Promise<CallToolResult> {
  try {
    const session = registry.getSession(sessionId);
    if (!session) {
      return { content: [{ type: 'text', text: `Error: session ${sessionId} not found` }], isError: true };
    }

    const watchers = Array.from(session.watchers.values()).map(w => ({
      watcherId: w.watcherId,
      source: w.source,
      target: w.target,
      status: w.status,
      eventCount: w.eventCount,
      createdAt: w.createdAt,
      lastEventAt: w.lastEventAt,
      hasResumeToken: w.hasResumeToken,
      ...(w.lastError !== undefined ? { lastError: w.lastError } : {}),
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(watchers, null, 2),
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
