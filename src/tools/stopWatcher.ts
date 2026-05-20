import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const stopWatcherSchema = z.object({
  watcherId: z.string().uuid().describe('The watcherId returned when the watcher was created.'),
});
import { registry } from '../state/sessionRegistry.js';
import { metrics } from '../utils/metrics.js';
import { logger } from '../utils/logger.js';

export async function stopWatcherHandler(
  watcherId: string,
  sessionId: string,
): Promise<CallToolResult> {
  try {
    const session = registry.getSession(sessionId);
    if (!session) {
      return { content: [{ type: 'text', text: `Error: session ${sessionId} not found` }], isError: true };
    }

    const watcher = session.watchers.get(watcherId);
    if (!watcher) {
      return { content: [{ type: 'text', text: `Error: watcher ${watcherId} not found in session` }], isError: true };
    }

    const finalEventCount = watcher.eventCount;
    await watcher.stop();
    session.watchers.delete(watcherId);

    metrics.activeWatchers.dec({ source: watcher.source, session_id: sessionId });
    logger.info('Watcher stopped', { watcherId, sessionId, source: watcher.source, finalEventCount });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            watcherId,
            source: watcher.source,
            target: watcher.target,
            finalEventCount,
            message: 'Watcher stopped and cleaned up.',
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
