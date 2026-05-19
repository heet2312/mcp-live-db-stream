import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { registry } from '../state/sessionRegistry.js';

export function readChangeLogResource(sessionId: string): ReadResourceResult {
  const session = registry.getSession(sessionId);
  const events = session?.changeLog ?? [];
  return {
    contents: [
      {
        uri: 'change://log',
        mimeType: 'application/json',
        text: JSON.stringify(events, null, 2),
      },
    ],
  };
}

export function readChangeLogByWatcherResource(
  sessionId: string,
  watcherId: string,
): ReadResourceResult {
  const session = registry.getSession(sessionId);
  const events = (session?.changeLog ?? []).filter(e => e.watcherId === watcherId);
  return {
    contents: [
      {
        uri: `change://log/${watcherId}`,
        mimeType: 'application/json',
        text: JSON.stringify(events, null, 2),
      },
    ],
  };
}
