import client from 'prom-client';
import type { Request, Response } from 'express';

export const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const metrics = {
  activeSessions: new client.Gauge({
    name: 'active_sessions_total',
    help: 'Currently active MCP sessions',
    registers: [register],
  }),

  activeWatchers: new client.Gauge({
    name: 'active_watchers_total',
    help: 'Currently active watchers',
    labelNames: ['source', 'session_id'] as const,
    registers: [register],
  }),

  changeEventsTotal: new client.Counter({
    name: 'change_events_total',
    help: 'Total change events processed',
    labelNames: ['source', 'operation_type', 'watcher_id'] as const,
    registers: [register],
  }),

  watcherErrorsTotal: new client.Counter({
    name: 'watcher_errors_total',
    help: 'Total watcher errors',
    labelNames: ['source', 'error_type'] as const,
    registers: [register],
  }),

  sessionDuration: new client.Histogram({
    name: 'session_duration_seconds',
    help: 'Session duration from create to close',
    buckets: [1, 5, 30, 60, 300, 900, 1800, 3600],
    registers: [register],
  }),

  httpRequestDuration: new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1, 5],
    registers: [register],
  }),
};

export async function metricsMiddleware(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
}
