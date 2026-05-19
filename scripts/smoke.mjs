#!/usr/bin/env node
/**
 * Smoke test for mcp-live-db-stream
 * Requires the server to be running on http://localhost:3000
 */

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}: ${detail}`);
  failed++;
}

async function check(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

// MCP requires Accept: application/json, text/event-stream on all POST requests
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

/** Parse the first JSON-RPC message from an SSE or JSON response */
async function parseResponse(res) {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    // Parse SSE: find first "data: ..." line
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        return JSON.parse(line.slice(6).trim());
      }
    }
    throw new Error('No data line found in SSE response');
  }
  return JSON.parse(text);
}

// ── Step 1: Initialize (POST /mcp without session header) ────────────────────
console.log('\n[1] MCP Initialize');
let sessionId;

await check('POST /mcp returns 200 and Mcp-Session-Id', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.1' },
      },
    }),
  });

  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);

  const sid = res.headers.get('mcp-session-id');
  if (!sid) throw new Error('Missing Mcp-Session-Id response header');
  sessionId = sid;

  const body = await parseResponse(res);
  if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  if (!body.result?.serverInfo) throw new Error('Missing result.serverInfo in response');
});

if (!sessionId) {
  console.error('\nAbort: no session ID — cannot continue');
  process.exit(1);
}

// ── Step 2: Send initialized notification ────────────────────────────────────
console.log('\n[2] MCP Initialized notification');

await check('POST /mcp with initialized notification returns 200', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });
  if (res.status !== 200 && res.status !== 202) throw new Error(`Expected 200/202, got ${res.status}`);
});

// ── Step 3: List tools ────────────────────────────────────────────────────────
console.log('\n[3] tools/list');

await check('Returns all 4 tools', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  });

  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  const body = await parseResponse(res);
  const tools = body.result?.tools ?? [];
  const names = tools.map(t => t.name);

  const expected = ['watch_mongo_collection', 'watch_sql_table', 'list_watchers', 'stop_watcher'];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
  }
});

// ── Step 4: Health check ──────────────────────────────────────────────────────
console.log('\n[4] GET /health');

await check('Returns { ok: true }', async () => {
  const res = await fetch(`${BASE}/health`);
  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(`Expected ok: true, got ${JSON.stringify(body)}`);
});

// ── Step 5: Sessions endpoint ─────────────────────────────────────────────────
console.log('\n[5] GET /sessions');

await check('Lists our session', async () => {
  const res = await fetch(`${BASE}/sessions`);
  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  const body = await res.json();
  const ids = (body.sessions ?? []).map(s => s.sessionId);
  if (!ids.includes(sessionId)) throw new Error(`Session ${sessionId} not found in /sessions`);
});

// ── Step 6: Delete session ────────────────────────────────────────────────────
console.log('\n[6] DELETE /mcp');

await check('Returns { ok: true }', async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'DELETE',
    headers: { 'mcp-session-id': sessionId },
  });
  if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(`Expected ok: true, got ${JSON.stringify(body)}`);
});

// ── Step 7: Verify session is gone ────────────────────────────────────────────
console.log('\n[7] Session count after delete');

await check('Session removed from /sessions', async () => {
  const res = await fetch(`${BASE}/sessions`);
  const body = await res.json();
  const ids = (body.sessions ?? []).map(s => s.sessionId);
  if (ids.includes(sessionId)) throw new Error(`Session ${sessionId} still present after DELETE`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
