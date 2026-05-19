export type DbSource = 'mongo' | 'sql';
export type OperationType = 'insert' | 'update' | 'delete' | 'replace';

export interface ChangeEvent {
  watcherId: string;
  eventId: string;
  timestamp: string;
  source: DbSource;
  database: string;
  collection: string;
  operationType: OperationType;
  documentKey: Record<string, unknown>;
  fullDocument?: Record<string, unknown>;
  updateDescription?: {
    updatedFields?: Record<string, unknown>;
    removedFields?: string[];
  };
}

export interface WatcherConfig {
  watcherId: string;
  sessionId: string;
  source: DbSource;
  target: string;
  createdAt: string;
}

export interface WatcherHandle extends WatcherConfig {
  status: 'active' | 'error' | 'stopped';
  eventCount: number;
  lastEventAt: string | undefined;
  stop: () => Promise<void>;
}

export interface SessionRuntime {
  sessionId: string;
  transport: import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport;
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
  watchers: Map<string, WatcherHandle>;
  changeLog: ChangeEvent[];
  createdAt: Date;
  lastActiveAt: Date;
}

export interface AppConfig {
  port: number;
  logLevel: string;
  sessionTtlMs: number;
  cleanupIntervalMs: number;
  maxWatchersPerSession: number;
  changeLogMaxSize: number;
  eventMaxAgeMs: number;
  eventMaxCount: number;
  corsOrigins: string[];
  rateLimit: { windowMs: number; max: number };
}

export interface ISessionRegistry {
  createSession: (
    sessionId: string,
    transport: import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport,
    server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer
  ) => SessionRuntime;
  getSession: (sessionId: string) => SessionRuntime | undefined;
  touchSession: (sessionId: string) => void;
  closeSession: (sessionId: string) => Promise<void>;
  expireIdleSessions: (ttlMs: number) => Promise<void>;
  startCleanupTimer: (intervalMs: number) => ReturnType<typeof setInterval>;
  getSessionStats: () => {
    count: number;
    sessions: Array<{
      sessionId: string;
      createdAt: Date;
      lastActiveAt: Date;
      watcherCount: number;
    }>;
  };
  all: () => SessionRuntime[];
  count: () => number;
}
