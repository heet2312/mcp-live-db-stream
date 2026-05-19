import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AppConfig, ISessionRegistry } from '../types/index.js';
import { createMcpServer } from '../mcp/createMcpServer.js';
import { createEventStore } from '../state/eventStore.js';
import { metricsMiddleware, metrics } from '../utils/metrics.js';
import { childLogger } from '../utils/logger.js';

export function createApp(reg: ISessionRegistry, cfg: AppConfig): express.Application {
  const app = express();

  // Security headers
  app.use(helmet());

  // CORS
  const corsOrigins = cfg.corsOrigins.includes('*') ? '*' : cfg.corsOrigins;
  app.use(cors({ origin: corsOrigins }));

  // Body parser
  app.use(express.json({ limit: '1mb' }));

  // Request ID middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? uuidv4();
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);
    const log = childLogger(requestId);
    log.info('HTTP request', { method: req.method, path: req.path });
    next();
  });

  // Rate limiting
  app.use(rateLimit({
    windowMs: cfg.rateLimit.windowMs,
    max: cfg.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  // Request duration tracking
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      metrics.httpRequestDuration.observe(
        { method: req.method, route: req.path, status: String(res.statusCode) },
        (Date.now() - start) / 1000,
      );
    });
    next();
  });

  // ─── MCP Routes ───────────────────────────────────────────────────────────

  // POST /mcp — initialize or continue session
  app.post('/mcp', (req: Request, res: Response) => {
    void (async () => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        // Existing session
        const session = reg.getSession(sessionId);
        if (!session) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          });
          return;
        }
        reg.touchSession(sessionId);
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // New session
      const newSessionId = uuidv4();
      const eventStore = createEventStore();
      const mcpServer = createMcpServer(newSessionId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        eventStore,
      });

      reg.createSession(newSessionId, transport, mcpServer);

      // Cast needed: exactOptionalPropertyTypes causes structural incompatibility with SDK's Transport interface
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
    })().catch((err: unknown) => {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
        id: null,
      });
    });
  });

  // GET /mcp — open SSE stream
  app.get('/mcp', (req: Request, res: Response) => {
    void (async () => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Mcp-Session-Id header required' },
          id: null,
        });
        return;
      }

      const session = reg.getSession(sessionId);
      if (!session) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }

      reg.touchSession(sessionId);
      await session.transport.handleRequest(req, res);
    })().catch((err: unknown) => {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
        id: null,
      });
    });
  });

  // DELETE /mcp — close session
  app.delete('/mcp', (req: Request, res: Response) => {
    void (async () => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Mcp-Session-Id header required' },
          id: null,
        });
        return;
      }

      await reg.closeSession(sessionId);
      res.status(200).json({ ok: true });
    })().catch((err: unknown) => {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
        id: null,
      });
    });
  });

  // ─── Utility Routes ───────────────────────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      activeSessions: reg.count(),
      mode: 'stateful',
      sdk: '1.x',
      version: '1.0.0',
      uptime: process.uptime(),
    });
  });

  app.get('/sessions', (_req: Request, res: Response) => {
    res.status(200).json(reg.getSessionStats());
  });

  app.get('/metrics', (_req: Request, res: Response) => {
    void metricsMiddleware(_req, res);
  });

  return app;
}
