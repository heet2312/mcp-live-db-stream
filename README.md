# mcp-live-db-stream

Production-grade Streamable HTTP MCP server that streams **MongoDB change events** and **SQL Server CDC** to AI agents (Claude Desktop, Cursor, Windsurf) in real-time via Server-Sent Events.

---

## Architecture

```
MCP Client (Claude Desktop / Cursor / Windsurf)
     │
     │  POST /mcp  ──── initialize, tool calls
     │  GET  /mcp  ──── open SSE stream (Last-Event-Id resumability)
     │  DELETE /mcp ─── close session
     ▼
Express HTTP Server (port 3000)
     │
     ├── SessionRegistry (per-session state, idle TTL cleanup)
     │       │
     │       ├── McpServer (tools + resources, per-session)
     │       └── StreamableHTTPServerTransport (SSE, EventStore)
     │
     ├── MongoChangeStreamManager ─── resumeAfter, backpressure, reconnect
     │       │  onEvent()
     │       └──────────────────── session.changeLog (ring buffer)
     │                                    │
     ├── SqlCDCPoller (interval) ──────────┘
     │       │  onEvent()          server.notification()
     │       └──────────────────── notifications/resources/updated
     │                                    │
     └── SSE stream ◄───────────────────────── change://log resource
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 22+ | `.nvmrc` provided |
| MongoDB | Must be a **replica set** — change streams require oplog |
| SQL Server | Must have **CDC enabled** on the target database |

**Enable MongoDB replica set (local dev):**
```
rs.initiate()
```

**Enable SQL Server CDC:**
```sql
EXEC sys.sp_cdc_enable_db;
EXEC sys.sp_cdc_enable_table @source_schema='dbo', @source_name='users', @role_name=NULL;
```

---

## Quick Start

```bash
git clone https://github.com/your-org/mcp-live-db-stream
cd mcp-live-db-stream
npm install
cp .env.example .env
# Edit .env as needed
npm run dev
```

Server listens on `http://localhost:3000`.

---

## Docker Quick Start

```bash
docker compose up --build -d
# Server: http://localhost:3000
# Prometheus: http://localhost:9090
```

---

## Claude Desktop Config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "live-db-stream": {
      "url": "http://localhost:3000/mcp",
      "transport": "http"
    }
  }
}
```

---

## Tools

### `watch_mongo_collection`

Subscribe to a MongoDB collection and stream real-time change events.

**Input:**
```json
{
  "connectionUri": "mongodb://localhost:27017/?replicaSet=rs0",
  "database": "myapp",
  "collection": "users",
  "operationTypes": ["insert", "update", "delete", "replace"],
  "watcherId": "optional-custom-uuid"
}
```

**Output:**
```json
{
  "watcherId": "550e8400-e29b-41d4-a716-446655440000",
  "target": "myapp.users",
  "operationTypes": ["insert", "update", "delete", "replace"],
  "message": "Watching MongoDB collection. Send stop_watcher to unsubscribe."
}
```

---

### `watch_sql_table`

Subscribe to a SQL Server table via CDC polling.

**Input:**
```json
{
  "server": "localhost",
  "database": "myapp",
  "username": "sa",
  "password": "Password123!",
  "table": "dbo.users",
  "pollIntervalMs": 2000
}
```

**Output:**
```json
{
  "watcherId": "550e8400-e29b-41d4-a716-446655440001",
  "target": "dbo.users",
  "pollIntervalMs": 2000,
  "message": "Watching SQL Server table via CDC polling. Send stop_watcher to unsubscribe."
}
```

---

### `list_watchers`

List all active watchers in this session.

**Input:** `{}` (no arguments)

**Output:** Array of watcher objects with status, eventCount, lastEventAt.

---

### `stop_watcher`

Stop and clean up a watcher.

**Input:**
```json
{ "watcherId": "550e8400-e29b-41d4-a716-446655440000" }
```

---

## Resources

### `change://log`

Returns the last N change events (ring buffer, configurable via `CHANGE_LOG_MAX_SIZE`).

The server sends a `notifications/resources/updated` notification on every new event, so MCP clients can re-read this resource in real-time.

### `change://log/{watcherId}`

Returns change events filtered by a specific `watcherId`.

---

## Example Prompt

> "Watch my `users` collection and tell me when any new user signs up. Alert me with their email and the timestamp."

Claude will:
1. Call `watch_mongo_collection` with your connection string
2. Listen for `insert` events on `notifications/resources/updated`
3. Read `change://log` to get the new events
4. Report back with the user's email and timestamp

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | Winston log level |
| `NODE_ENV` | `development` | `production` enables JSON logging |
| `SESSION_TTL_MS` | `3600000` | Session idle TTL (1 hour) |
| `CLEANUP_INTERVAL_MS` | `60000` | Session cleanup interval (1 min) |
| `MAX_WATCHERS_PER_SESSION` | `10` | Max concurrent watchers per session |
| `CHANGE_LOG_MAX_SIZE` | `100` | Change log ring buffer size |
| `EVENT_MAX_AGE_MS` | `300000` | SSE event store max age (5 min) |
| `EVENT_MAX_COUNT` | `1000` | SSE event store max count |
| `CORS_ORIGINS` | `*` | Comma-separated origins, or `*` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `MAX_CDC_ROWS` | `10000` | SQL CDC row cap per poll |

---

## Prometheus + Grafana

The server exposes Prometheus metrics at `GET /metrics`.

**Metrics:**
- `active_sessions_total` — live session count
- `active_watchers_total{source, session_id}` — live watcher count
- `change_events_total{source, operation_type, watcher_id}` — events processed
- `watcher_errors_total{source, error_type}` — watcher errors
- `session_duration_seconds` — session lifetime histogram
- `http_request_duration_seconds{method, route, status}` — request latency

A Prometheus scrape config is included in `prometheus.yml`. To add Grafana, point it at `http://prometheus:9090`.

---

## Production Deployment Notes

1. **MongoDB** must be a **replica set** — standalone instances do not support change streams.
2. **SQL Server CDC** must be enabled at the database level AND on each target table.
3. Set `NODE_ENV=production` for JSON-structured logs.
4. Set `CORS_ORIGINS` to your specific client origins instead of `*`.
5. The server maintains per-session in-memory state. For horizontal scaling, sessions must be sticky (same instance handles all requests for a session) OR implement a shared `EventStore` backed by Redis.

---

## Utility Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check |
| `GET /sessions` | Session stats |
| `GET /metrics` | Prometheus metrics |

---

## License

MIT
