import type { EventStore, StreamId, EventId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';

interface StoredEvent {
  eventId: EventId;
  streamId: StreamId;
  message: JSONRPCMessage;
  timestamp: number;
}

class InMemoryEventStore implements EventStore {
  private readonly streamEvents = new Map<StreamId, StoredEvent[]>();
  private readonly eventIndex = new Map<EventId, StoredEvent>();
  private readonly sequences = new Map<StreamId, number>();

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const seq = (this.sequences.get(streamId) ?? 0) + 1;
    this.sequences.set(streamId, seq);
    const eventId: EventId = `${Date.now()}-${seq}`;
    const event: StoredEvent = { eventId, streamId, message, timestamp: Date.now() };

    if (!this.streamEvents.has(streamId)) {
      this.streamEvents.set(streamId, []);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.streamEvents.get(streamId)!.push(event);
    this.eventIndex.set(eventId, event);
    this.prune(streamId);
    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(this.eventIndex.get(eventId)?.streamId);
  }

  replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const entry = this.eventIndex.get(lastEventId);
    if (!entry) {
      return Promise.reject(new Error(`Event ${lastEventId} not found in store`));
    }
    const { streamId } = entry;
    const events = this.streamEvents.get(streamId) ?? [];
    let found = false;

    const replay = async (): Promise<StreamId> => {
      for (const ev of events) {
        if (found) {
          await send(ev.eventId, ev.message);
        } else if (ev.eventId === lastEventId) {
          found = true;
        }
      }
      return streamId;
    };
    return replay();
  }

  private prune(streamId: StreamId): void {
    const events = this.streamEvents.get(streamId);
    if (!events) return;
    const now = Date.now();
    const cutoffTime = now - config.eventMaxAgeMs;

    // Remove stale events
    const fresh = events.filter(e => e.timestamp >= cutoffTime);
    // Cap by count
    const capped = fresh.length > config.eventMaxCount
      ? fresh.slice(fresh.length - config.eventMaxCount)
      : fresh;

    this.streamEvents.set(streamId, capped);
    // Remove from index all events no longer in list
    const kept = new Set(capped.map(e => e.eventId));
    for (const [id, ev] of this.eventIndex) {
      if (ev.streamId === streamId && !kept.has(id)) {
        this.eventIndex.delete(id);
      }
    }
  }
}

export function createEventStore(): EventStore {
  return new InMemoryEventStore();
}
