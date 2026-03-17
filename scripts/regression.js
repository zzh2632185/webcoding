#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const REPO_DIR = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(REPO_DIR, 'server.js');
const MOCK_CLAUDE = path.join(REPO_DIR, 'scripts', 'mock-claude.js');
const MOCK_CODEX = path.join(REPO_DIR, 'scripts', 'mock-codex.js');
const WS_AUTH_TIMEOUT_MS = 3000;
const WS_CONNECT_TIMEOUT_MS = 10000;

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate, { timeoutMs = 4000, intervalMs = 60, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runSqliteScript(dbPath, script) {
  const result = spawnSync('sqlite3', [dbPath, script], { encoding: 'utf8' });
  if (result.status !== 0) {
    const preview = String(script || '').trim().slice(0, 160);
    throw new Error(result.stderr || `sqlite3 failed: ${preview}`);
  }
  return result.stdout.trim();
}

function runSqliteStatements(dbPath, statements) {
  return runSqliteScript(
    dbPath,
    (Array.isArray(statements) ? statements : [statements])
      .filter(Boolean)
      .join('\n'),
  );
}

function sql(dbPath, statement) {
  return runSqliteScript(dbPath, statement);
}

function sqlQuote(value) {
  return `'${String(value).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

const SQL_CREATE_LOGS_TABLE = `
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    level TEXT NOT NULL,
    target TEXT NOT NULL,
    message TEXT,
    module_path TEXT,
    file TEXT,
    line INTEGER,
    thread_id TEXT,
    process_uuid TEXT,
    estimated_bytes INTEGER NOT NULL DEFAULT 0
  );
`;

function buildInsertThreadSql(threadId, rolloutPath) {
  return `
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version)
    VALUES (${sqlQuote(threadId)}, ${sqlQuote(rolloutPath)}, 1, 2, 'exec', 'OpenAI', '/tmp/project-b', 'Codex import prompt', '{}', 'never', '0.114.0');
  `;
}

function buildInsertLogSql(threadId) {
  return `INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (1, 0, 'INFO', 'test', ${sqlQuote(threadId)});`;
}

function probePort(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function waitChildExit(child, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve();
    };
    child.once('exit', onExit);
  });
}

function ensureMessageWaiters(ws) {
  if (!ws.__ccMessageWaiters) ws.__ccMessageWaiters = new Set();
  return ws.__ccMessageWaiters;
}

function ensureConsumedMessageIndexes(ws) {
  if (!ws.__ccConsumedMessageIndexes) ws.__ccConsumedMessageIndexes = new Set();
  return ws.__ccConsumedMessageIndexes;
}

function notifyMessageWaiters(ws, msg, msgIndex) {
  const waiters = ensureMessageWaiters(ws);
  for (const waiter of Array.from(waiters)) {
    let matched = false;
    try {
      matched = !!waiter.predicate(msg);
    } catch (error) {
      waiters.delete(waiter);
      waiter.reject(error);
      continue;
    }
    if (!matched) continue;
    waiters.delete(waiter);
    waiter.resolve(msg, msgIndex);
  }
}

function rejectMessageWaiters(ws, error) {
  const waiters = ensureMessageWaiters(ws);
  for (const waiter of Array.from(waiters)) {
    waiters.delete(waiter);
    waiter.reject(error);
  }
}

async function waitForPort(port, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probePort(port)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function startServer(env) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: REPO_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitForPort(env.PORT, 10000);
  return { child, stdout: () => stdout, stderr: () => stderr, env };
}

async function stopServer(handle) {
  const child = handle?.child || handle;
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch {}
    await waitChildExit(child, 1200);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await waitChildExit(child, 800);
  }
}

async function withServer(env, fn) {
  const handle = await startServer(env);

  try {
    await fn(handle);
  } catch (err) {
    const stdoutTail = handle.stdout().slice(-1200);
    const stderrTail = handle.stderr().slice(-1200);
    if (stdoutTail || stderrTail) {
      err.message = `${err.message}\n--- server stdout tail ---\n${stdoutTail}\n--- server stderr tail ---\n${stderrTail}`;
    }
    throw err;
  } finally {
    await stopServer(handle);
  }
}

function connectWsOnce(port, password, timeoutMs = WS_AUTH_TIMEOUT_MS, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
    const messages = [];
    ensureMessageWaiters(ws);
    ensureConsumedMessageIndexes(ws);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      reject(new Error('Timed out waiting for WebSocket auth_result'));
    }, timeoutMs);
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', password }));
    });
    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(String(buf));
      } catch (err) {
        done(() => reject(err));
        return;
      }
      messages.push(msg);
      notifyMessageWaiters(ws, msg, messages.length - 1);
      if (msg.type === 'auth_result' && msg.success) done(() => resolve({ ws, messages, token: msg.token }));
      if (msg.type === 'auth_result' && !msg.success) done(() => reject(new Error('Auth failed')));
    });
    ws.on('error', (err) => {
      rejectMessageWaiters(ws, err);
      done(() => reject(err));
    });
    ws.on('close', () => {
      rejectMessageWaiters(ws, new Error('WebSocket closed'));
      if (!settled) done(() => reject(new Error('WebSocket closed before auth_result')));
    });
  });
}

async function connectWs(port, password, timeoutMs = WS_CONNECT_TIMEOUT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const remaining = Math.max(300, deadline - Date.now());
    try {
      return await connectWsOnce(port, password, Math.min(3000, remaining), options);
    } catch (err) {
      lastError = err;
      if (/Auth failed/i.test(String(err && err.message))) throw err;
      await sleep(120);
    }
  }
  throw lastError || new Error('Timed out waiting for WebSocket auth_result');
}

function openWsOnce(port, timeoutMs = WS_AUTH_TIMEOUT_MS, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
    const messages = [];
    ensureMessageWaiters(ws);
    ensureConsumedMessageIndexes(ws);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      reject(new Error('Timed out waiting for WebSocket open'));
    }, timeoutMs);
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ws.on('open', () => done(() => resolve({ ws, messages })));
    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(String(buf));
      } catch (err) {
        done(() => reject(err));
        return;
      }
      messages.push(msg);
      notifyMessageWaiters(ws, msg, messages.length - 1);
    });
    ws.on('error', (err) => {
      rejectMessageWaiters(ws, err);
      done(() => reject(err));
    });
    ws.on('close', () => {
      rejectMessageWaiters(ws, new Error('WebSocket closed'));
      if (!settled) done(() => reject(new Error('WebSocket closed before open')));
    });
  });
}

async function openWs(port, timeoutMs = WS_CONNECT_TIMEOUT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const remaining = Math.max(300, deadline - Date.now());
    try {
      return await openWsOnce(port, Math.min(3000, remaining), options);
    } catch (err) {
      lastError = err;
      await sleep(120);
    }
  }
  throw lastError || new Error('Timed out waiting for WebSocket open');
}

function closeWs(ws, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    ws.once('close', () => {
      clearTimeout(timer);
      finish();
    });
    try {
      if (ws.readyState === WebSocket.CLOSING) return;
      ws.close();
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

async function uploadAttachment(port, token, { filename, mime, data }) {
  const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mime,
      'X-Filename': encodeURIComponent(filename),
    },
    body: data,
  });
  const payload = await response.json();
  assert(response.ok && payload.ok, `Attachment upload failed: ${payload.message || response.status}`);
  return payload.attachment;
}

async function uploadAttachmentExpectFailure(port, token, { filename, mime, data }, expectedStatus) {
  const headers = {
    'Content-Type': mime,
    'X-Filename': encodeURIComponent(filename),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
    method: 'POST',
    headers,
    body: data,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(`Attachment failure response was not JSON: ${err.message}`);
  }
  assert(response.status === expectedStatus, `Expected attachment upload to fail with ${expectedStatus}, got ${response.status}`);
  assert(payload && payload.ok === false, 'Attachment failure response should return ok=false');
  return { response, payload };
}

function nextMessage(messages, ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const stackLines = (new Error().stack || '').split('\n').map((line) => line.trim());
    const caller = stackLines[2] || 'unknown-caller';
    const consumedIndexes = ensureConsumedMessageIndexes(ws);
    for (let i = 0; i < messages.length; i++) {
      if (consumedIndexes.has(i)) continue;
      if (!predicate(messages[i])) continue;
      consumedIndexes.add(i);
      resolve(messages[i]);
      return;
    }
    const waiters = ensureMessageWaiters(ws);
    let timeout = null;
    const waiter = {
      predicate,
      resolve: (msg, msgIndex) => {
        if (timeout) clearTimeout(timeout);
        if (Number.isInteger(msgIndex)) consumedIndexes.add(msgIndex);
        resolve(msg);
      },
      reject: (error) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      },
    };
    waiters.add(waiter);
    timeout = setTimeout(() => {
      waiters.delete(waiter);
      const tailTypes = messages.slice(-12).map((msg) => msg && msg.type).filter(Boolean).join(', ');
      reject(new Error(`Timed out waiting for expected WebSocket message (${caller}) tail=[${tailTypes}]`));
    }, timeoutMs);
  });
}

function wsSendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function typeMatcher(type, predicate = null) {
  return (msg) => msg.type === type && (!predicate || predicate(msg));
}

function buildAgentMessagePayload({ text, sessionId, mode, agent, attachments }) {
  return {
    type: 'message',
    text,
    sessionId,
    mode,
    agent,
    ...(attachments ? { attachments } : {}),
  };
}

function createScenarioClient(messages, ws) {
  return {
    send(payload) {
      wsSendJson(ws, payload);
    },
    waitFor(predicate, timeoutMs) {
      return nextMessage(messages, ws, predicate, timeoutMs);
    },
    waitForType(type, predicate = null, timeoutMs) {
      return nextMessage(messages, ws, typeMatcher(type, predicate), timeoutMs);
    },
    async sendAndWait(payload, predicate, timeoutMs) {
      wsSendJson(ws, payload);
      return nextMessage(messages, ws, predicate, timeoutMs);
    },
    async sendAndWaitType(payload, type, predicate = null, timeoutMs) {
      wsSendJson(ws, payload);
      return nextMessage(messages, ws, typeMatcher(type, predicate), timeoutMs);
    },
  };
}

async function saveConfigAndWait(client, saveType, config, responseType) {
  return client.sendAndWaitType(
    { type: saveType, config },
    responseType,
  );
}

function createTestRunner() {
  const results = [];
  return {
    async run(name, fn) {
      const startedAt = Date.now();
      try {
        await fn();
        const durationMs = Date.now() - startedAt;
        results.push({ name, ok: true, durationMs });
        console.log(`ok - ${name} (${durationMs}ms)`);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        results.push({ name, ok: false, error, durationMs });
        console.error(`not ok - ${name} (${durationMs}ms)`);
        console.error(error.stack || error.message);
      }
    },
    finish() {
      const failed = results.filter((item) => !item.ok);
      if (failed.length > 0) {
        const summary = failed.map((item, index) => `${index + 1}. ${item.name}: ${item.error.message}`).join('\n');
        throw new Error(`Regression failed: ${failed.length}/${results.length} case(s)\n${summary}`);
      }
      console.log(`Regression checks passed (${results.length} cases).`);
    },
  };
}

async function connectAuthedClient(port, password, options = {}) {
  const { ws, messages, token } = await connectWs(port, password, WS_CONNECT_TIMEOUT_MS, options);
  const client = createScenarioClient(messages, ws);
  await client.waitForType('session_list');
  return { ws, messages, token, client };
}

async function withAuthedClient(port, password, fn, options = {}) {
  const connection = await connectAuthedClient(port, password, options);
  try {
    return await fn(connection);
  } finally {
    await closeWs(connection.ws);
  }
}

function findProcessLogLine(logsDir, sessionId, eventName) {
  const processLogPath = path.join(logsDir, 'process.log');
  if (!fs.existsSync(processLogPath)) return '';
  return fs.readFileSync(processLogPath, 'utf8')
    .trim()
    .split('\n')
    .find((line) => line.includes(`"event":"${eventName}"`) && line.includes(sessionId.slice(0, 8))) || '';
}

function readProcessLog(logsDir) {
  const processLogPath = path.join(logsDir, 'process.log');
  if (!fs.existsSync(processLogPath)) return '';
  return fs.readFileSync(processLogPath, 'utf8');
}

function createExpiredAttachmentFixture(sessionsDir) {
  const attachmentsDir = path.join(sessionsDir, '_attachments');
  mkdirp(attachmentsDir);
  const attachmentId = 'expired-attachment-fixture';
  const sessionId = 'expired-attachment-session';
  const dataPath = path.join(attachmentsDir, `${attachmentId}.png`);
  const metaPath = path.join(attachmentsDir, `${attachmentId}.json`);
  const now = Date.now();
  const createdAt = new Date(now - (8 * 24 * 60 * 60 * 1000)).toISOString();
  const expiresAt = new Date(now - (2 * 60 * 60 * 1000)).toISOString();
  fs.writeFileSync(
    dataPath,
    Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex'),
  );
  fs.writeFileSync(metaPath, JSON.stringify({
    id: attachmentId,
    kind: 'image',
    filename: 'expired-fixture.png',
    mime: 'image/png',
    size: 67,
    createdAt,
    expiresAt,
    path: dataPath,
  }, null, 2));
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    title: 'Expired Attachment Fixture',
    created: createdAt,
    updated: createdAt,
    agent: 'codex',
    claudeSessionId: null,
    codexThreadId: null,
    model: null,
    permissionMode: 'yolo',
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: [{
      role: 'user',
      content: 'expired attachment fixture',
      attachments: [{
        id: attachmentId,
        kind: 'image',
        filename: 'expired-fixture.png',
        mime: 'image/png',
        size: 67,
        createdAt,
        expiresAt,
        storageState: 'available',
      }],
      timestamp: createdAt,
    }],
    cwd: '/tmp/expired-attachment-space',
  }, null, 2));
  return { sessionId, attachmentId, dataPath, metaPath };
}

function createFakeClaudeHistory(homeDir) {
  const projectDir = path.join(homeDir, '.claude', 'projects', 'tmp-project');
  mkdirp(projectDir);
  const sessionId = 'claude-import-test';
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'user',
      cwd: '/tmp/project-a',
      timestamp: '2026-03-12T00:00:00.000Z',
      message: { content: 'Claude import prompt' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-12T00:00:02.000Z',
      message: { content: [{ type: 'text', text: 'Claude import answer' }] },
    }),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return { sessionId, projectDir: 'tmp-project', filePath };
}

function writeFakeCodexModelsCache(homeDir) {
  const modelsCachePath = path.join(homeDir, '.codex', 'models_cache.json');
  mkdirp(path.dirname(modelsCachePath));
  fs.writeFileSync(modelsCachePath, JSON.stringify({
    fetched_at: '2026-03-12T00:00:00.000Z',
    client_version: '0.114.0',
    models: [
      {
        slug: 'custom-regression-model',
        display_name: 'custom-regression-model',
        description: 'Regression-only Codex model.',
        visibility: 'list',
        supported_in_api: true,
        priority: 0,
      },
      {
        slug: 'gpt-5.3-codex',
        display_name: 'gpt-5.3-codex',
        description: 'Latest frontier agentic coding model.',
        visibility: 'list',
        supported_in_api: true,
        priority: 1,
      },
    ],
  }, null, 2));
}

function writeFakeCodexRollout(homeDir, threadId) {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '03', '12');
  mkdirp(sessionsDir);
  const rolloutPath = path.join(sessionsDir, 'rollout-2026-03-12T00-00-00-codex-import-thread.jsonl');
  const rolloutLines = [
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project-b', cli_version: '0.114.0', source: 'exec' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md wrapper should be ignored' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Codex import prompt' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Codex import answer' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 } },
      },
    }),
  ];
  fs.writeFileSync(rolloutPath, `${rolloutLines.join('\n')}\n`);
  return rolloutPath;
}

function writeFakeCodexStateDb(homeDir, threadId, rolloutPath) {
  const stateDb = path.join(homeDir, '.codex', 'state_5.sqlite');
  mkdirp(path.dirname(stateDb));
  runSqliteStatements(stateDb, [
    'PRAGMA journal_mode = WAL;',
    `
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT '',
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'enabled'
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS stage1_outputs (
        thread_id TEXT PRIMARY KEY,
        source_updated_at INTEGER NOT NULL,
        raw_memory TEXT NOT NULL,
        rollout_summary TEXT NOT NULL,
        generated_at INTEGER NOT NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS thread_dynamic_tools (
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        PRIMARY KEY(thread_id, position)
      );
    `,
    SQL_CREATE_LOGS_TABLE,
    buildInsertThreadSql(threadId, rolloutPath),
    buildInsertLogSql(threadId),
  ]);
  return stateDb;
}

function writeFakeCodexLogsDb(homeDir, threadId) {
  const logsDb = path.join(homeDir, '.codex', 'logs_1.sqlite');
  mkdirp(path.dirname(logsDb));
  runSqliteStatements(logsDb, [
    SQL_CREATE_LOGS_TABLE,
    buildInsertLogSql(threadId),
  ]);
  return logsDb;
}

function buildFakeCodexFixture(homeDir, threadId) {
  writeFakeCodexModelsCache(homeDir);
  const rolloutPath = writeFakeCodexRollout(homeDir, threadId);
  const stateDb = writeFakeCodexStateDb(homeDir, threadId, rolloutPath);
  const logsDb = writeFakeCodexLogsDb(homeDir, threadId);
  return { threadId, rolloutPath, stateDb, logsDb };
}

function createFakeCodexHistory(homeDir) {
  return buildFakeCodexFixture(homeDir, 'codex-import-thread');
}

async function runAuthRegressionCase({ port, password }) {
  const wrongAuth = await openWs(port);
  try {
    wrongAuth.ws.send(JSON.stringify({ type: 'auth', password: 'totally-wrong-password' }));
    const wrongResult = await nextMessage(wrongAuth.messages, wrongAuth.ws, typeMatcher('auth_result', (msg) => msg.success === false));
    assert(/认证失败/.test(wrongResult.error || ''), 'Wrong password should fail authentication');
  } finally {
    await closeWs(wrongAuth.ws);
  }

  const emptyAuth = await openWs(port);
  try {
    emptyAuth.ws.send(JSON.stringify({ type: 'auth', password: '' }));
    const emptyResult = await nextMessage(emptyAuth.messages, emptyAuth.ws, typeMatcher('auth_result', (msg) => msg.success === false));
    assert(/认证失败/.test(emptyResult.error || ''), 'Empty password should fail authentication');
  } finally {
    await closeWs(emptyAuth.ws);
  }

  const repeatedAuth = await openWs(port);
  try {
    repeatedAuth.ws.send(JSON.stringify({ type: 'auth', password }));
    const firstSuccess = await nextMessage(repeatedAuth.messages, repeatedAuth.ws, typeMatcher('auth_result', (msg) => msg.success === true));
    assert(typeof firstSuccess.token === 'string' && firstSuccess.token.length > 0, 'Successful auth should return a token');
    await nextMessage(repeatedAuth.messages, repeatedAuth.ws, typeMatcher('session_list'));

    repeatedAuth.ws.send(JSON.stringify({ type: 'auth', token: firstSuccess.token }));
    const secondSuccess = await nextMessage(repeatedAuth.messages, repeatedAuth.ws, typeMatcher('auth_result', (msg) => msg.success === true));
    assert(secondSuccess.token === firstSuccess.token, 'Repeated auth with token should preserve the same token');
    await nextMessage(repeatedAuth.messages, repeatedAuth.ws, typeMatcher('session_list'));
  } finally {
    await closeWs(repeatedAuth.ws);
  }
}

async function runRuntimeErrorRegressionCase({ port, password, logsDir }) {
  await withAuthedClient(port, password, async ({ client }) => {
    const erroredSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex auth error', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex auth error',
    );
    const runtimeError = await client.waitForType('error', (msg) => /Codex 鉴权失败/.test(msg.message || ''), 8000);
    assert(/Codex 鉴权失败/.test(runtimeError.message || ''), 'Codex auth stderr should be mapped to a friendly auth error');
    await client.waitForType('done', (msg) => msg.sessionId === erroredSession.sessionId, 8000);
    const processCompleteLine = findProcessLogLine(logsDir, erroredSession.sessionId, 'process_complete');
    assert(processCompleteLine && processCompleteLine.includes('"exitCode":1'), 'Non-zero CLI exit should be recorded in process_complete log');
  });
}

async function runAttachmentBoundaryRegressionCase({ port, password }) {
  await withAuthedClient(port, password, async ({ token }) => {
    try {
      const oversizedUpload = await uploadAttachmentExpectFailure(
        port,
        token,
        {
          filename: 'too-large.png',
          mime: 'image/png',
          data: Buffer.alloc(10 * 1024 * 1024 + 1, 0),
        },
        413,
      );
      assert(/10MB/.test(oversizedUpload.payload.message || ''), 'Oversized attachment should be rejected with size limit message');
    } catch (error) {
      assert(/fetch failed|socket hang up|ECONNRESET/i.test(error.message || ''), 'Oversized attachment should be rejected or connection aborted by the server');
    }

    const invalidTypeUpload = await uploadAttachmentExpectFailure(
      port,
      token,
      {
        filename: 'not-an-image.txt',
        mime: 'text/plain',
        data: Buffer.from('plain text is not a supported image'),
      },
      400,
    );
    assert(/仅支持/.test(invalidTypeUpload.payload.message || ''), 'Unsupported attachment mime type should be rejected');
  });
}

async function runWebSocketGuardRegressionCase({ port }) {
  const socket = await openWs(port);
  try {
    socket.ws.send(JSON.stringify({ type: 'message', text: 'unauthenticated hello', agent: 'codex', mode: 'yolo' }));
    const unauthenticatedError = await nextMessage(
      socket.messages,
      socket.ws,
      typeMatcher('error', (msg) => /Not authenticated/.test(msg.message || '')),
    );
    assert(/Not authenticated/.test(unauthenticatedError.message || ''), 'Unauthenticated WebSocket message should be rejected');

    socket.ws.send('not-json-at-all');
    const invalidJsonError = await nextMessage(
      socket.messages,
      socket.ws,
      typeMatcher('error', (msg) => /Invalid JSON/.test(msg.message || '')),
    );
    assert(/Invalid JSON/.test(invalidJsonError.message || ''), 'Malformed WebSocket payload should return Invalid JSON');
  } finally {
    await closeWs(socket.ws);
  }
}

async function runExpiredAttachmentCleanupRegressionCase({ port, password, expiredAttachmentFixture }) {
  await withAuthedClient(port, password, async ({ client }) => {
    await waitForCondition(
      () => !fs.existsSync(expiredAttachmentFixture.metaPath) && !fs.existsSync(expiredAttachmentFixture.dataPath),
      { timeoutMs: 3000, label: 'expired attachment cleanup on startup' },
    );

    client.send({ type: 'load_session', sessionId: expiredAttachmentFixture.sessionId });
    const expiredSession = await client.waitForType(
      'session_info',
      (msg) => msg.sessionId === expiredAttachmentFixture.sessionId,
      5000,
    );
    const expiredAttachment = expiredSession.messages?.[0]?.attachments?.[0] || null;
    assert(expiredAttachment && expiredAttachment.id === expiredAttachmentFixture.attachmentId, 'Expired attachment session should still expose the original attachment id');
    assert(expiredAttachment.storageState === 'expired', 'Expired attachment should be marked as expired when the session is loaded');

    client.send(buildAgentMessagePayload({
      text: 'retry expired attachment',
      sessionId: expiredAttachmentFixture.sessionId,
      mode: 'yolo',
      agent: 'codex',
      attachments: [{ id: expiredAttachmentFixture.attachmentId }],
    }));
    const expiredAttachmentError = await client.waitForType(
      'error',
      (msg) => /图片附件已过期或不可用/.test(msg.message || ''),
      5000,
    );
    assert(/图片附件已过期或不可用/.test(expiredAttachmentError.message || ''), 'Sending an expired attachment reference should be rejected');
  });
}

async function runConcurrentSessionsRegressionCase({ port, password }) {
  let connectionA = null;
  let connectionB = null;
  let connectionC = null;
  try {
    connectionA = await connectAuthedClient(port, password);
    connectionB = await connectAuthedClient(port, password);

    const sessionA = await connectionA.client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex slow stream alpha', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex slow stream alpha',
    );
    await connectionA.client.waitForType('text_delta', (msg) => /slow-start:alpha/.test(msg.text || ''), 5000);

    const sessionB = await connectionB.client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex slow stream beta', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex slow stream beta',
    );
    await connectionB.client.waitForType('text_delta', (msg) => /slow-start:beta/.test(msg.text || ''), 5000);

    const concurrentList = await connectionA.client.sendAndWaitType(
      { type: 'list_sessions' },
      'session_list',
      (msg) => msg.sessions.some((session) => session.id === sessionA.sessionId && session.isRunning)
        && msg.sessions.some((session) => session.id === sessionB.sessionId && session.isRunning),
      5000,
    );
    assert(concurrentList.sessions.some((session) => session.id === sessionA.sessionId && session.isRunning), 'Session alpha should be running concurrently');
    assert(concurrentList.sessions.some((session) => session.id === sessionB.sessionId && session.isRunning), 'Session beta should be running concurrently');

    connectionC = await connectAuthedClient(port, password);
    connectionC.client.send({ type: 'load_session', sessionId: sessionA.sessionId });
    const loadedSessionA = await connectionC.client.waitForType(
      'session_info',
      (msg) => msg.sessionId === sessionA.sessionId && msg.isRunning === true,
      5000,
    );
    assert(loadedSessionA.isRunning === true, 'Loading a running session from another client should keep isRunning=true');
    const resumedSessionA = await connectionC.client.waitForType(
      'resume_generating',
      (msg) => msg.sessionId === sessionA.sessionId && /slow-start:alpha/.test(msg.text || ''),
      5000,
    );
    assert(/slow-start:alpha/.test(resumedSessionA.text || ''), 'Second client should receive current stream snapshot for active session');

    await closeWs(connectionA.ws);
    await connectionC.client.waitForType('done', (msg) => msg.sessionId === sessionA.sessionId, 10000);
    await connectionB.client.waitForType('done', (msg) => msg.sessionId === sessionB.sessionId, 10000);
  } finally {
    if (connectionA) await closeWs(connectionA.ws);
    if (connectionB) await closeWs(connectionB.ws);
    if (connectionC) await closeWs(connectionC.ws);
  }
}

async function runReconnectResumeRegressionCase({ port, password }) {
  let originalConnection = null;
  let resumedConnection = null;
  try {
    originalConnection = await connectAuthedClient(port, password);
    const reconnectSession = await originalConnection.client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex slow stream reconnect', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex slow stream reconnect',
    );
    await originalConnection.client.waitForType('text_delta', (msg) => /slow-start:reconnect/.test(msg.text || ''), 5000);

    await closeWs(originalConnection.ws);
    await waitForCondition(
      () => originalConnection.ws.readyState === WebSocket.CLOSED,
      { timeoutMs: 2000, label: 'client websocket close before reconnect' },
    );

    resumedConnection = await connectAuthedClient(port, password);
    resumedConnection.client.send({ type: 'load_session', sessionId: reconnectSession.sessionId });
    const loadedReconnectSession = await resumedConnection.client.waitForType(
      'session_info',
      (msg) => msg.sessionId === reconnectSession.sessionId && msg.isRunning === true,
      5000,
    );
    assert(loadedReconnectSession.isRunning === true, 'Reconnected client should see session still running');
    const resumedStream = await resumedConnection.client.waitForType(
      'resume_generating',
      (msg) => msg.sessionId === reconnectSession.sessionId && /slow-start:reconnect/.test(msg.text || ''),
      5000,
    );
    assert(/slow-start:reconnect/.test(resumedStream.text || ''), 'Reconnected client should recover existing streamed text');
    await resumedConnection.client.waitForType('text_delta', (msg) => /slow-mid:reconnect|slow-end:reconnect/.test(msg.text || ''), 5000);
    await resumedConnection.client.waitForType('done', (msg) => msg.sessionId === reconnectSession.sessionId, 10000);
  } finally {
    if (originalConnection) await closeWs(originalConnection.ws);
    if (resumedConnection) await closeWs(resumedConnection.ws);
  }
}

async function runServerRestartRecoveryRegressionCase({ port, password, logsDir, serverHandle, serverEnv }) {
  let initialConnection = null;
  let restartedHandle = null;
  let recoveredConnection = null;
  try {
    initialConnection = await connectAuthedClient(port, password);
    const restartSession = await initialConnection.client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex slow stream restart', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex slow stream restart',
    );
    await initialConnection.client.waitForType('text_delta', (msg) => /slow-start:restart/.test(msg.text || ''), 5000);

    await stopServer(serverHandle);
    await waitForCondition(
      () => initialConnection.ws.readyState !== WebSocket.OPEN,
      { timeoutMs: 3000, label: 'websocket close after server restart' },
    );

    restartedHandle = await startServer(serverEnv);
    serverHandle.child = restartedHandle.child;
    serverHandle.stdout = restartedHandle.stdout;
    serverHandle.stderr = restartedHandle.stderr;
    serverHandle.env = restartedHandle.env;
    recoveredConnection = await connectAuthedClient(port, password);
    const recoveredList = await recoveredConnection.client.sendAndWaitType(
      { type: 'list_sessions' },
      'session_list',
      (msg) => msg.sessions.some((session) => session.id === restartSession.sessionId && session.isRunning),
      5000,
    );
    assert(recoveredList.sessions.some((session) => session.id === restartSession.sessionId && session.isRunning), 'Recovered server should mark interrupted session as running');

    recoveredConnection.client.send({ type: 'load_session', sessionId: restartSession.sessionId });
    const loadedRestartSession = await recoveredConnection.client.waitForType(
      'session_info',
      (msg) => msg.sessionId === restartSession.sessionId && msg.isRunning === true,
      5000,
    );
    assert(loadedRestartSession.isRunning === true, 'Recovered session should still be attachable as running');
    const resumedRestartStream = await recoveredConnection.client.waitForType(
      'resume_generating',
      (msg) => msg.sessionId === restartSession.sessionId && /slow-start:restart/.test(msg.text || ''),
      5000,
    );
    assert(/slow-start:restart/.test(resumedRestartStream.text || ''), 'Recovered server should replay streamed text snapshot');
    const recoveryLine = findProcessLogLine(logsDir, restartSession.sessionId, 'recovery_alive');
    assert(recoveryLine, 'Recovered server should log recovery_alive for the resumed process');
    await recoveredConnection.client.waitForType('text_delta', (msg) => /slow-mid:restart|slow-end:restart/.test(msg.text || ''), 6000);
    await recoveredConnection.client.waitForType('done', (msg) => msg.sessionId === restartSession.sessionId, 10000);
  } finally {
    if (initialConnection) await closeWs(initialConnection.ws);
    if (recoveredConnection) await closeWs(recoveredConnection.ws);
  }
}

async function runNotificationFailureRegressionCase({ port, password, logsDir }) {
  await withAuthedClient(port, password, async ({ client }) => {
    await saveConfigAndWait(
      client,
      'save_notify_config',
      {
        provider: 'telegram',
        pushplus: { token: '' },
        telegram: { botToken: 'definitely-invalid-telegram-token', chatId: '123456' },
        serverchan: { sendKey: '' },
        feishu: { webhook: '' },
        qqbot: { qmsgKey: '' },
      },
      'notify_config',
    );
    await client.waitForType('system_message', (msg) => /通知配置已保存/.test(msg.message || ''), 5000);

    client.send({ type: 'test_notify' });
    const notifyResult = await client.waitForType('notify_test_result', null, 15000);
    assert(notifyResult.success === false, 'Invalid notification config should produce a failed notify_test_result');
    assert(/发送失败/.test(notifyResult.message || ''), 'Failed notification attempt should surface failure details to the client');

    await waitForCondition(() => {
      const processLog = readProcessLog(logsDir);
      return (
        (processLog.includes('"event":"notify_response"') || processLog.includes('"event":"notify_error"'))
        && processLog.includes('"provider":"telegram"')
      );
    }, { timeoutMs: 15000, intervalMs: 200, label: 'notification failure log' });

    const postNotifyList = await client.sendAndWaitType({ type: 'list_sessions' }, 'session_list', null, 5000);
    assert(Array.isArray(postNotifyList.sessions), 'Server should remain responsive after failed notification send');
  });
}

async function runAuthLockRegressionCase({ port, password }) {
  const ip = '203.0.113.25';
  const wsOptions = { headers: { 'x-forwarded-for': ip } };

  for (let attempt = 1; attempt <= 4; attempt++) {
    const socket = await openWs(port, WS_CONNECT_TIMEOUT_MS, wsOptions);
    try {
      socket.ws.send(JSON.stringify({ type: 'auth', password: `wrong-password-${attempt}` }));
      const authResult = await nextMessage(socket.messages, socket.ws, typeMatcher('auth_result', (msg) => msg.success === false), 5000);
      assert(/认证失败/.test(authResult.error || ''), `Auth attempt ${attempt} should fail without locking yet`);
    } finally {
      await closeWs(socket.ws);
    }
  }

  const lockedSocket = await openWs(port, WS_CONNECT_TIMEOUT_MS, wsOptions);
  try {
    lockedSocket.ws.send(JSON.stringify({ type: 'auth', password: 'still-wrong' }));
    const lockedResult = await nextMessage(lockedSocket.messages, lockedSocket.ws, typeMatcher('auth_result', (msg) => msg.success === false), 5000);
    assert(/登录失败次数过多/.test(lockedResult.error || ''), 'Fifth failed auth attempt should lock the client IP');
  } finally {
    await closeWs(lockedSocket.ws);
  }

  const blockedValidSocket = await openWs(port, WS_CONNECT_TIMEOUT_MS, wsOptions);
  try {
    blockedValidSocket.ws.send(JSON.stringify({ type: 'auth', password }));
    const blockedResult = await nextMessage(blockedValidSocket.messages, blockedValidSocket.ws, typeMatcher('auth_result', (msg) => msg.success === false), 5000);
    assert(/登录失败次数过多/.test(blockedResult.error || ''), 'Locked client IP should reject even a correct password during the lock window');
  } finally {
    await closeWs(blockedValidSocket.ws);
  }
}

async function runHappyPathRegressionCase({ port, password, tempRoot, configDir, sessionsDir, logsDir, codexFixture, tinyPng }) {
  await withAuthedClient(port, password, async ({ client, token }) => {
    const modelConfigMsg = await saveConfigAndWait(
      client,
      'save_model_config',
      {
        mode: 'custom',
        activeTemplate: 'Regression Unified API',
        templates: [{
          name: 'Regression Unified API',
          apiKey: 'sk-regression',
          apiBase: 'https://example.com/v1',
          upstreamType: 'openai',
          defaultModel: 'custom-regression-model',
          opusModel: 'claude-opus-4-6',
          sonnetModel: 'claude-sonnet-4-6',
          haikuModel: 'claude-haiku-4-5',
        }],
      },
      'model_config',
    );
    assert(modelConfigMsg.config.mode === 'custom', 'Unified API config mode save/load failed');
    assert(modelConfigMsg.config.activeTemplate === 'Regression Unified API', 'Unified API active template save/load failed');
    assert(Array.isArray(modelConfigMsg.config.templates) && modelConfigMsg.config.templates[0]?.apiKey.includes('****'), 'Unified API key should be masked');

    const codexConfigMsg = await saveConfigAndWait(
      client,
      'save_codex_config',
      {
        mode: 'unified',
        enableSearch: true,
      },
      'codex_config',
    );
    assert(codexConfigMsg.config.mode === 'unified', 'Codex unified mode save/load failed');
    assert(codexConfigMsg.config.supportsSearch === false, 'Codex config should expose unsupported search capability');
    assert(codexConfigMsg.config.enableSearch === false, 'Codex config should ignore unsupported search toggle');

    const codexSession = await client.sendAndWaitType(
      { type: 'new_session', agent: 'codex', cwd: '/tmp/codex-space', mode: 'plan' },
      'session_info',
      (msg) => msg.agent === 'codex' && msg.cwd === '/tmp/codex-space',
    );
    assert(codexSession.mode === 'plan', 'Codex new_session should follow requested mode');
    assert(codexSession.model === null, 'Codex new_session should not inject a default model');

    const codexModelList = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }),
      'model_list',
      (msg) => msg.agent === 'codex',
    );
    assert(Array.isArray(codexModelList.entries) && codexModelList.entries.some((entry) => entry.value === 'custom-regression-model'), 'Codex /model should return real model entries from Codex cache');
    const codexModelChanged = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model custom-regression-model', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }),
      'model_changed',
      (msg) => msg.model === 'custom-regression-model',
    );
    assert(codexModelChanged.model === 'custom-regression-model', 'Codex /model should accept real Codex model names from fetched list');

    const codexAttachment = await uploadAttachment(port, token, {
      filename: 'codex-test.png',
      mime: 'image/png',
      data: tinyPng,
    });
    const firstMessageSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'first codex prompt', attachments: [codexAttachment], mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'first codex prompt',
    );
    assert(firstMessageSession.agent === 'codex', 'First-message path created wrong agent');
    const runningSessionList = await client.waitForType(
      'session_list',
      (msg) => msg.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning),
    );
    assert(runningSessionList.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning), 'Running Codex session should be marked as isRunning');
    await client.waitForType('done', (msg) => msg.sessionId === firstMessageSession.sessionId);
    const spawnLine = findProcessLogLine(logsDir, firstMessageSession.sessionId, 'process_spawn');
    assert(spawnLine && !spawnLine.includes('--search') && spawnLine.includes('--image'), 'Codex exec should attach images and not append unsupported --search flag');
    const runtimeToml = fs.readFileSync(path.join(configDir, 'codex-runtime-home', 'config.toml'), 'utf8');
    assert(runtimeToml.includes('preferred_auth_method = "apikey"'), 'Codex unified runtime should write isolated runtime auth mode');
    assert(runtimeToml.includes('name = "Regression Unified API"'), 'Codex unified runtime should point at the active unified API template');
    assert(/base_url = "http:\/\/127\.0\.0\.1:\d+\/openai"/.test(runtimeToml), 'Codex unified runtime should route through the local bridge base_url');

    client.send(buildAgentMessagePayload({ text: '/compact', sessionId: firstMessageSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await client.waitForType('system_message', (msg) => /正在执行 Codex \/compact/.test(msg.message || ''));
    await client.waitForType('done', (msg) => msg.sessionId === firstMessageSession.sessionId);
    const compactDoneMsg = await client.waitForType('system_message', (msg) => /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(compactDoneMsg.message || ''), 'Codex /compact should complete with Codex-specific status message');

    const autoCompactCwd = path.join(tempRoot, 'codex-auto-compact');
    mkdirp(autoCompactCwd);
    const autoCompactSession = await client.sendAndWaitType(
      { type: 'new_session', agent: 'codex', cwd: autoCompactCwd, mode: 'yolo' },
      'session_info',
      (msg) => msg.agent === 'codex' && msg.cwd === autoCompactCwd,
    );
    client.send(buildAgentMessagePayload({ text: 'warm up auto compact', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await client.waitForType('done', (msg) => msg.sessionId === autoCompactSession.sessionId);
    client.send(buildAgentMessagePayload({ text: 'trigger codex context limit', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    const autoCompactStart = await client.waitForType('system_message', (msg) => /正在按 Codex \/compact 自动压缩/.test(msg.message || ''));
    assert(/Codex \/compact/.test(autoCompactStart.message || ''), 'Codex auto /compact should announce auto compact start');
    const autoCompactDone = await client.waitForType('system_message', (msg) => /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(autoCompactDone.message || ''), 'Codex auto /compact should finish compact step');
    const autoCompactResume = await client.waitForType('system_message', (msg) => /按 Codex 压缩计划继续执行/.test(msg.message || ''));
    assert(/继续执行/.test(autoCompactResume.message || ''), 'Codex auto /compact should announce retry');
    const autoCompactRetryText = await client.waitForType('text_delta', (msg) => /trigger codex context limit/.test(msg.text || ''), 8000);
    assert(/trigger codex context limit/.test(autoCompactRetryText.text || ''), 'Codex auto /compact should replay the failed prompt after compact');

    const claudeOneMCwd = path.join(tempRoot, 'claude-1m-space');
    mkdirp(claudeOneMCwd);
    const claudeModelSession = await client.sendAndWaitType(
      { type: 'new_session', agent: 'claude', cwd: claudeOneMCwd, mode: 'yolo' },
      'session_info',
      (msg) => msg.agent === 'claude' && msg.cwd === claudeOneMCwd,
    );
    const claudeModelList = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model', sessionId: claudeModelSession.sessionId, mode: 'yolo', agent: 'claude' }),
      'model_list',
      (msg) => msg.agent === 'claude' && msg.current === 'default',
    );
    assert(Array.isArray(claudeModelList.entries) && claudeModelList.entries.some((entry) => entry.alias === 'sonnet[1m]'), 'Claude /model should expose Sonnet 1M option');
    assert(claudeModelList.entries.some((entry) => entry.alias === 'opus[1m]'), 'Claude /model should expose Opus 1M option');
    const claudeModelChanged = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model sonnet[1m]', sessionId: claudeModelSession.sessionId, mode: 'yolo', agent: 'claude' }),
      'model_changed',
      (msg) => msg.model === 'sonnet[1m]',
    );
    assert(claudeModelChanged.model === 'sonnet[1m]', 'Claude /model should accept Sonnet 1M alias');
    client.send(buildAgentMessagePayload({ text: 'use sonnet 1m', sessionId: claudeModelSession.sessionId, mode: 'yolo', agent: 'claude' }));
    await client.waitForType('done', (msg) => msg.sessionId === claudeModelSession.sessionId);
    const claudeOneMSpawnLine = findProcessLogLine(logsDir, claudeModelSession.sessionId, 'process_spawn');
    assert(claudeOneMSpawnLine && claudeOneMSpawnLine.includes('claude-sonnet-4-6[1m]'), 'Claude /model Sonnet 1M should pass the real 1M model value to CLI');
    const storedClaudeOneMSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeModelSession.sessionId}.json`), 'utf8'));
    assert(storedClaudeOneMSession.model === 'claude-sonnet-4-6[1m]', 'Claude /model should persist the real 1M model value');

    const claudeAttachment = await uploadAttachment(port, token, {
      filename: 'claude-test.png',
      mime: 'image/png',
      data: tinyPng,
    });
    const claudeImageSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'describe attachment', attachments: [claudeAttachment], mode: 'yolo', agent: 'claude' }),
      'session_info',
      (msg) => msg.agent === 'claude' && msg.title === 'describe attachment',
    );
    await client.waitForType('done', (msg) => msg.sessionId === claudeImageSession.sessionId);
    const claudeSpawnLine = findProcessLogLine(logsDir, claudeImageSession.sessionId, 'process_spawn');
    assert(claudeSpawnLine && claudeSpawnLine.includes('--input-format stream-json'), 'Claude image message should switch stdin to stream-json');
    const storedClaudeSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(Array.isArray(storedClaudeSession.messages?.[0]?.attachments) && storedClaudeSession.messages[0].attachments.length === 1, 'Claude message should persist attachment metadata');

    const nativeSessions = await client.sendAndWaitType(
      { type: 'list_native_sessions' },
      'native_sessions',
    );
    assert(nativeSessions.groups?.length > 0, 'Claude native session listing failed');
    const firstClaude = nativeSessions.groups[0].sessions[0];
    const importedClaude = await client.sendAndWaitType(
      { type: 'import_native_session', sessionId: firstClaude.sessionId, projectDir: nativeSessions.groups[0].dir },
      'session_info',
      (msg) => msg.agent === 'claude' && msg.title === 'Claude import prompt',
    );
    assert(importedClaude.messages?.[0]?.content === 'Claude import prompt', 'Claude import parsed wrong first message');

    const codexSessions = await client.sendAndWaitType(
      { type: 'list_codex_sessions' },
      'codex_sessions',
    );
    const importedCodexItem = codexSessions.sessions.find((item) => item.threadId === codexFixture.threadId);
    assert(importedCodexItem, 'Codex session listing failed');

    const importedCodex = await client.sendAndWaitType(
      { type: 'import_codex_session', threadId: importedCodexItem.threadId, rolloutPath: importedCodexItem.rolloutPath },
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'Codex import prompt',
    );
    assert(importedCodex.messages?.[0]?.content === 'Codex import prompt', 'Codex import kept wrapper instructions');
    assert(importedCodex.totalUsage?.inputTokens === 20, 'Codex import usage parse failed');

    const importedSessionId = importedCodex.sessionId;
    client.send({ type: 'delete_session', sessionId: importedSessionId });
    await client.waitForType(
      'session_list',
      (msg) => !msg.sessions.some((s) => s.id === importedSessionId),
    );

    const importedSessionPath = path.join(sessionsDir, `${importedSessionId}.json`);
    await waitForCondition(() => !fs.existsSync(importedSessionPath), { label: 'Codex session JSON deletion' });
    await waitForCondition(() => !fs.existsSync(codexFixture.rolloutPath), { label: 'Codex rollout deletion' });
    await waitForCondition(
      () => sql(codexFixture.stateDb, `select count(*) from threads where id=${sqlQuote(codexFixture.threadId)}`) === '0',
      { label: 'Codex thread row deletion' },
    );
  });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-regression-'));
  try {
    const configDir = path.join(tempRoot, 'config');
    const sessionsDir = path.join(tempRoot, 'sessions');
    const logsDir = path.join(tempRoot, 'logs');
    const homeDir = path.join(tempRoot, 'home');
    mkdirp(configDir);
    mkdirp(sessionsDir);
    mkdirp(logsDir);
    mkdirp(homeDir);

    fs.writeFileSync(path.join(configDir, 'notify.json'), JSON.stringify({
      provider: 'off',
      pushplus: { token: '' },
      telegram: { botToken: '', chatId: '' },
      serverchan: { sendKey: '' },
      feishu: { webhook: '' },
      qqbot: { qmsgKey: '' },
    }, null, 2));

    createFakeClaudeHistory(homeDir);
    const codexFixture = createFakeCodexHistory(homeDir);
    const expiredAttachmentFixture = createExpiredAttachmentFixture(sessionsDir);

    const port = await getFreePort();
    const password = 'Regression!234';
    const tinyPng = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082',
      'hex',
    );

    const serverEnv = {
      PORT: String(port),
      CC_WEB_PASSWORD: password,
      CC_WEB_CONFIG_DIR: configDir,
      CC_WEB_SESSIONS_DIR: sessionsDir,
      CC_WEB_LOGS_DIR: logsDir,
      HOME: homeDir,
      CLAUDE_PATH: MOCK_CLAUDE,
      CODEX_PATH: MOCK_CODEX,
    };

    await withServer(serverEnv, async (serverHandle) => {
      const ctx = {
        port,
        password,
        tempRoot,
        configDir,
        sessionsDir,
        logsDir,
        homeDir,
        codexFixture,
        expiredAttachmentFixture,
        tinyPng,
        serverEnv,
        serverHandle,
      };
      const runner = createTestRunner();
      await runner.run('auth failures and repeated auth', () => runAuthRegressionCase(ctx));
      await runner.run('runtime error mapping', () => runRuntimeErrorRegressionCase(ctx));
      await runner.run('attachment boundary handling', () => runAttachmentBoundaryRegressionCase(ctx));
      await runner.run('expired attachment cleanup', () => runExpiredAttachmentCleanupRegressionCase(ctx));
      await runner.run('websocket guard rails', () => runWebSocketGuardRegressionCase(ctx));
      await runner.run('concurrent sessions and multi-client attachment', () => runConcurrentSessionsRegressionCase(ctx));
      await runner.run('websocket reconnect resume', () => runReconnectResumeRegressionCase(ctx));
      await runner.run('happy path regression flow', () => runHappyPathRegressionCase(ctx));
      await runner.run('server restart recovery', () => runServerRestartRecoveryRegressionCase(ctx));
      await runner.run('notification failure handling', () => runNotificationFailureRegressionCase(ctx));
      await runner.run('auth lock window', () => runAuthLockRegressionCase(ctx));
      runner.finish();
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
