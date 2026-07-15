#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ClaudeStreamClient } = require('../lib/claude-stream-client');
const { CodexAppServerClient } = require('../lib/codex-app-server-client');
const { PiRpcClient } = require('../lib/pi-rpc-client');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_PATH = path.join(ROOT, 'lib', 'local-api-bridge.js');
let MODEL = 'webcoding-protocol-model';
let CONTRACT_TIMEOUT_MS = 45_000;
const MARKER = 'WEBCODING_PROTOCOL_OK';

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveCommand(envValue, defaultName) {
  const requested = String(envValue || '').trim();
  const name = requested || defaultName;
  if (path.isAbsolute(name) && isExecutable(name)) return name;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    path.join(home, '.local', 'bin', name),
    path.join(home, '.volta', 'bin', name),
    path.join(home, '.npm-global', 'bin', name),
    path.join('/usr/local/bin', name),
    path.join('/opt/homebrew/bin', name),
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)),
  ];
  return candidates.find(isExecutable) || name;
}

const CLAUDE = resolveCommand(process.env.CLAUDE_PATH, 'claude');
const CODEX = resolveCommand(process.env.CODEX_PATH, 'codex');
const PI = resolveCommand(process.env.PI_PATH, 'pi');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15_000);
  const intervalMs = Number(options.intervalMs || 25);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${options.label || 'condition'}`);
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitForExit(client, timeoutMs = 5000) {
  const child = client?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeoutMs),
  ]);
}

function cleanEnv(overrides = {}, remove = []) {
  const env = { ...process.env };
  for (const key of remove) delete env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function startMockChatUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch {}
      requests.push({
        method: req.method,
        path: requestUrl.pathname,
        stream: parsed?.stream === true,
        messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : 0,
        toolCount: Array.isArray(parsed?.tools) ? parsed.tools.length : 0,
      });

      if (req.method === 'GET' && requestUrl.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: MODEL, object: 'model' }] }));
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/responses') {
        const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
        const itemId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
        const completedItem = {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: MARKER, annotations: [] }],
        };
        const completedResponse = {
          id: responseId,
          object: 'response',
          status: 'completed',
          model: MODEL,
          output: [completedItem],
          output_text: MARKER,
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        };
        if (parsed?.stream !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(completedResponse));
          return;
        }
        const send = (event, payload) => {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        send('response.created', {
          type: 'response.created',
          response: { id: responseId, object: 'response', status: 'in_progress', model: MODEL, output: [] },
        });
        send('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: itemId,
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [{ type: 'output_text', text: '', annotations: [] }],
          },
        });
        send('response.output_text.delta', {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'WEBCODING_',
        });
        setTimeout(() => {
          if (res.destroyed) return;
          send('response.output_text.delta', {
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            delta: 'PROTOCOL_OK',
          });
          send('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: completedItem,
          });
          send('response.completed', { type: 'response.completed', response: completedResponse });
          res.end();
        }, 15);
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/messages') {
        const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
        const completedMessage = {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: MARKER }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 3 },
        };
        if (parsed?.stream !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(completedMessage));
          return;
        }
        const send = (event, payload) => {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        send('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'WEBCODING_' },
        });
        setTimeout(() => {
          if (res.destroyed) return;
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'PROTOCOL_OK' },
          });
          send('content_block_stop', { type: 'content_block_stop', index: 0 });
          send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 3 },
          });
          send('message_stop', { type: 'message_stop' });
          res.end();
        }, 15);
        return;
      }

      if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      const responseId = `chatcmpl_${crypto.randomUUID().replace(/-/g, '')}`;
      if (parsed?.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: responseId,
          object: 'chat.completion',
          model: MODEL,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: MARKER },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }));
        return;
      }

      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      send({
        id: responseId,
        object: 'chat.completion.chunk',
        model: MODEL,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      send({
        id: responseId,
        object: 'chat.completion.chunk',
        model: MODEL,
        choices: [{ index: 0, delta: { content: 'WEBCODING_' }, finish_reason: null }],
      });
      setTimeout(() => {
        if (res.destroyed) return;
        send({
          id: responseId,
          object: 'chat.completion.chunk',
          model: MODEL,
          choices: [{ index: 0, delta: { content: 'PROTOCOL_OK' }, finish_reason: null }],
        });
        send({
          id: responseId,
          object: 'chat.completion.chunk',
          model: MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        send({
          id: responseId,
          object: 'chat.completion.chunk',
          model: MODEL,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        });
        res.end('data: [DONE]\n\n');
      }, 15);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startBridge(tempRoot, upstreamPort, upstreamProtocol = 'chat-completions', upstreamOverride = null) {
  const runtimePath = path.join(tempRoot, 'bridge-runtime.json');
  const statePath = path.join(tempRoot, 'bridge-state.json');
  const token = `protocol-${crypto.randomUUID()}`;
  const isAnthropic = upstreamProtocol === 'anthropic';
  const endpoint = isAnthropic
    ? 'messages'
    : (upstreamProtocol === 'responses' ? 'responses' : 'chat/completions');
  const upstream = upstreamOverride || {
    name: `Protocol Contract ${upstreamProtocol}`,
    apiKey: 'local-upstream-key',
    apiBase: `http://127.0.0.1:${upstreamPort}/v1/${endpoint}`,
    kind: isAnthropic ? 'anthropic' : 'openai',
    protocol: isAnthropic ? 'messages' : upstreamProtocol,
    defaultModel: MODEL,
  };
  writeJson(runtimePath, {
    version: 2,
    token,
    upstream,
  });
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    cwd: ROOT,
    env: cleanEnv({
      CC_WEB_BRIDGE_RUNTIME_PATH: runtimePath,
      CC_WEB_BRIDGE_STATE_PATH: statePath,
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8000); });
  child.once('error', (error) => { stderr = `${stderr}\n${error.message}`; });
  const state = await waitForCondition(() => {
    if (child.exitCode !== null) throw new Error(stderr.trim() || `Bridge exited ${child.exitCode}`);
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return Number(parsed?.port) > 0 ? parsed : null;
    } catch {
      return null;
    }
  }, { timeoutMs: 10_000, label: 'local API bridge' });
  return {
    child,
    token,
    real: !!upstreamOverride,
    upstreamProtocol,
    openaiBaseUrl: `http://127.0.0.1:${state.port}/openai`,
    anthropicBaseUrl: `http://127.0.0.1:${state.port}/anthropic`,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    return block?.text || block?.content || '';
  }).join('');
}

async function checkPi(tempRoot, bridge) {
  const agentDir = path.join(tempRoot, 'pi-agent');
  const sessionDir = path.join(tempRoot, 'pi-sessions');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  writeJson(path.join(agentDir, 'models.json'), {
    providers: {
      webcoding: {
        baseUrl: bridge.upstreamProtocol === 'anthropic' ? bridge.anthropicBaseUrl : bridge.openaiBaseUrl,
        api: bridge.upstreamProtocol === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
        apiKey: '$WEBCODING_PI_API_KEY',
        models: [{
          id: MODEL,
          name: MODEL,
          reasoning: false,
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 4096,
        }],
      },
    },
  });
  writeJson(path.join(agentDir, 'settings.json'), {
    defaultProjectTrust: 'never',
    enableInstallTelemetry: false,
    defaultThinkingLevel: 'off',
    defaultProvider: 'webcoding',
    defaultModel: MODEL,
  });
  writeJson(path.join(agentDir, 'auth.json'), {});
  const requireToolProbe = bridge.real && process.env.WEBCODING_REAL_TOOL_PROBE === '1';
  if (requireToolProbe) {
    fs.writeFileSync(path.join(tempRoot, 'protocol-probe.txt'), 'protocol tool probe\n');
  }

  const events = [];
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const client = new PiRpcClient({
    command: PI,
    args: [
      '--mode', 'rpc',
      '--session-dir', sessionDir,
      '--session-id', crypto.randomUUID(),
      '--no-approve',
      '--provider', 'webcoding',
      '--model', MODEL,
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
    ],
    env: cleanEnv({
      PI_CODING_AGENT_DIR: agentDir,
      WEBCODING_PI_API_KEY: bridge.token,
      OPENAI_API_KEY: bridge.token,
      ANTHROPIC_API_KEY: bridge.token,
      PI_TELEMETRY: '0',
    }),
    cwd: tempRoot,
    onEvent(event) {
      events.push(event);
      if (event?.type === 'agent_end' && event.willRetry !== true) resolveDone();
      if (event?.type === 'error' && event.error) rejectDone(new Error(String(event.error)));
    },
    onProtocolError: rejectDone,
    onExit(info) {
      if (!info.expected) rejectDone(info.error);
    },
  });
  try {
    await client.start();
    await client.request({
      type: 'prompt',
      message: requireToolProbe
        ? 'Use the read tool exactly once to read protocol-probe.txt, then reply with a short confirmation.'
        : 'Return the protocol marker only.',
    }, { timeoutMs: 15_000 });
    await withTimeout(done, CONTRACT_TIMEOUT_MS, 'Pi agent_end');
    const eventText = events
      .filter((event) => event?.message?.role === 'assistant')
      .map((event) => extractContentText(event.message.content))
      .join('');
    const entriesResponse = await client.request({ type: 'get_entries' }, { timeoutMs: 15_000 });
    const entryText = (entriesResponse.data?.entries || [])
      .filter((entry) => entry?.message?.role === 'assistant')
      .map((entry) => extractContentText(entry.message.content))
      .join('');
    const assistantText = `${eventText}${entryText}`;
    const runtimeError = events.find((event) => event?.message?.errorMessage)?.message?.errorMessage || '';
    if (runtimeError) throw new Error(`Pi runtime error: ${runtimeError}`);
    if (requireToolProbe) {
      assert(events.some((event) => event?.type === 'tool_execution_end'), 'Pi real tool probe did not execute a tool');
    }
    const responseOk = bridge.real ? assistantText.trim().length > 0 : assistantText.includes(MARKER);
    if (!responseOk) {
      const eventSummary = events.slice(-30).map((event) => ({
        type: event?.type || null,
        role: event?.message?.role || null,
        contentTypes: Array.isArray(event?.message?.content)
          ? event.message.content.map((block) => block?.type || typeof block)
          : null,
        error: event?.error || event?.message?.errorMessage || null,
      }));
      throw new Error(`Pi did not receive the streamed marker; text=${assistantText.slice(-240)}; events=${JSON.stringify(eventSummary)}; stderr=${client.stderr.trim().slice(-1200)}`);
    }
  } finally {
    client.dispose();
    await waitForExit(client);
  }
}

async function checkClaude(tempRoot, bridge) {
  const settingsPath = path.join(tempRoot, 'claude-settings.json');
  writeJson(settingsPath, {
    env: {
      ANTHROPIC_API_KEY: bridge.token,
      ANTHROPIC_AUTH_TOKEN: bridge.token,
      ANTHROPIC_BASE_URL: bridge.anthropicBaseUrl,
      ANTHROPIC_MODEL: MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
  const events = [];
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const client = new ClaudeStreamClient({
    command: CLAUDE,
    args: [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--include-hook-events',
      '--replay-user-messages',
      '--permission-mode', 'bypassPermissions',
      '--model', MODEL,
      '--settings', settingsPath,
      '--no-session-persistence',
    ],
    env: cleanEnv({
      ANTHROPIC_API_KEY: bridge.token,
      ANTHROPIC_AUTH_TOKEN: bridge.token,
      ANTHROPIC_BASE_URL: bridge.anthropicBaseUrl,
      ANTHROPIC_MODEL: MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
    }),
    cwd: tempRoot,
    onEvent(event) {
      events.push(event);
      if (event?.type === 'result') {
        if (event.is_error) rejectDone(new Error(String(event.result || 'Claude returned an error')));
        else resolveDone(event);
      }
    },
    onProtocolError: rejectDone,
    onExit(info) {
      if (!info.expected) rejectDone(info.error);
    },
  });
  try {
    await client.start();
    await client.sendUserMessage([{ type: 'text', text: 'Return the protocol marker only.' }]);
    let result;
    try {
      result = await withTimeout(done, CONTRACT_TIMEOUT_MS, 'Claude result');
    } catch (error) {
      const eventSummary = events.slice(-20).map((event) => ({
        type: event?.type || null,
        subtype: event?.subtype || event?.event?.type || null,
        isError: !!event?.is_error,
        error: event?.error || event?.message || event?.status || null,
        attempt: event?.attempt || event?.retry_attempt || null,
        retryInMs: event?.retry_in_ms || event?.retryInMs || null,
        keys: Object.keys(event || {}).slice(0, 20),
      }));
      throw new Error(`${error.message}; events=${JSON.stringify(eventSummary)}; stderr=${client.stderr.trim().slice(-1200)}`);
    }
    const assistantText = events
      .filter((event) => event?.type === 'assistant')
      .map((event) => extractContentText(event.message?.content))
      .join('');
    const combined = `${assistantText}\n${String(result?.result || '')}`;
    assert(
      bridge.real ? combined.trim().length > 0 : combined.includes(MARKER),
      `Claude Code did not receive a streamed response: ${combined.slice(-240) || client.stderr}`,
    );
  } finally {
    client.dispose();
    await waitForExit(client);
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

async function checkCodex(tempRoot, bridge) {
  const codexHome = path.join(tempRoot, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    `model = ${tomlString(MODEL)}`,
    'preferred_auth_method = "apikey"',
    'model_provider = "openai_compat"',
    '',
    '[model_providers.openai_compat]',
    'name = "Protocol Contract Chat"',
    `base_url = ${tomlString(bridge.openaiBaseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join('\n'));

  let text = '';
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const client = new CodexAppServerClient({
    command: CODEX,
    args: [
      'app-server', '--listen', 'stdio://',
      '-c', 'preferred_auth_method="apikey"',
      '-c', 'model_provider="openai_compat"',
      '-c', `model_providers.openai_compat.name=${tomlString('Protocol Contract Chat')}`,
      '-c', `model_providers.openai_compat.base_url=${tomlString(bridge.openaiBaseUrl)}`,
      '-c', 'model_providers.openai_compat.env_key="OPENAI_API_KEY"',
      '-c', 'model_providers.openai_compat.wire_api="responses"',
      '-c', `model=${tomlString(MODEL)}`,
    ],
    env: cleanEnv({
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: bridge.token,
    }, ['OPENAI_ACCESS_TOKEN']),
    cwd: tempRoot,
    clientVersion: 'protocol-contract',
    onNotification(method, params) {
      if (method === 'item/agentMessage/delta' && params?.delta) text += String(params.delta);
      if (method === 'item/completed') {
        const item = params?.item || {};
        if (item.type === 'agentMessage' || item.type === 'agent_message') {
          text += String(item.text || item.content || '');
        }
      }
      if (method === 'error' && !params?.willRetry) {
        rejectDone(new Error(params?.error?.message || params?.message || 'Codex App Server error'));
      }
      if (method === 'turn/completed') {
        const turn = params?.turn || {};
        if (turn.status === 'failed') rejectDone(new Error(turn.error?.message || 'Codex turn failed'));
        else resolveDone(turn);
      }
    },
    onRequest() {
      return {};
    },
    onProtocolError: rejectDone,
    onExit(info) {
      if (!info.expected) rejectDone(info.error);
    },
  });
  try {
    await client.start();
    const threadResult = await client.request('thread/start', {
      cwd: tempRoot,
      model: MODEL,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    }, { timeoutMs: 30_000 });
    const threadId = threadResult?.thread?.id;
    assert(threadId, 'Codex App Server did not return a thread id');
    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Return the protocol marker only.' }],
      cwd: tempRoot,
      model: MODEL,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }, { timeoutMs: 30_000 });
    await withTimeout(done, CONTRACT_TIMEOUT_MS, 'Codex turn/completed');
    assert(
      bridge.real ? text.trim().length > 0 : text.includes(MARKER),
      `Codex did not receive a streamed response: ${text.slice(-240) || client.stderr}`,
    );
  } finally {
    client.dispose();
    await waitForExit(client);
  }
}

function loadRealUpstreamRuntime(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const upstream = parsed?.upstream || Object.values(parsed?.runtimes || {})[0]?.upstream || null;
  if (!upstream?.apiKey || !upstream?.apiBase || !upstream?.defaultModel) {
    throw new Error('Real upstream runtime is missing apiKey, apiBase, or defaultModel');
  }
  const upstreamProtocol = upstream.kind === 'anthropic'
    ? 'anthropic'
    : (upstream.protocol === 'responses' ? 'responses' : 'chat-completions');
  return {
    upstream: {
      name: String(upstream.name || 'Real upstream'),
      apiKey: String(upstream.apiKey),
      apiBase: String(upstream.apiBase),
      kind: upstreamProtocol === 'anthropic' ? 'anthropic' : 'openai',
      protocol: upstreamProtocol === 'anthropic' ? 'messages' : upstreamProtocol,
      defaultModel: String(upstream.defaultModel),
    },
    upstreamProtocol,
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webcoding-protocol-contract-'));
  const selectedAgent = String(process.env.WEBCODING_PROTOCOL_AGENT || 'all').trim().toLowerCase();
  const selectedProtocol = String(process.env.WEBCODING_UPSTREAM_PROTOCOL || 'all').trim().toLowerCase();
  let upstream = null;
  try {
    const realRuntimePath = String(process.env.WEBCODING_REAL_UPSTREAM_RUNTIME || '').trim();
    if (realRuntimePath) {
      const real = loadRealUpstreamRuntime(realRuntimePath);
      MODEL = real.upstream.defaultModel;
      CONTRACT_TIMEOUT_MS = Number(process.env.WEBCODING_REAL_TIMEOUT_MS || 120_000);
      const protocolRoot = path.join(tempRoot, `real-${real.upstreamProtocol}`);
      let realBridge = null;
      try {
        realBridge = await startBridge(
          path.join(protocolRoot, 'bridge'),
          0,
          real.upstreamProtocol,
          real.upstream,
        );
        if (selectedAgent === 'all' || selectedAgent === 'pi') {
          await checkPi(path.join(protocolRoot, 'pi'), realBridge);
          console.log(`ok - Pi RPC real upstream call (${real.upstreamProtocol})`);
        }
        if (selectedAgent === 'all' || selectedAgent === 'claude') {
          await checkClaude(path.join(protocolRoot, 'claude'), realBridge);
          console.log(`ok - Claude Code real upstream call (${real.upstreamProtocol})`);
        }
        if (selectedAgent === 'all' || selectedAgent === 'codex') {
          await checkCodex(path.join(protocolRoot, 'codex'), realBridge);
          console.log(`ok - Codex App Server real upstream call (${real.upstreamProtocol})`);
        }
      } finally {
        await realBridge?.close().catch(() => {});
        fs.rmSync(protocolRoot, { recursive: true, force: true });
      }
      return;
    }

    upstream = await startMockChatUpstream();
    const protocols = selectedProtocol === 'all'
      ? ['chat-completions', 'responses', 'anthropic']
      : [selectedProtocol];
    const expectedPaths = {
      'chat-completions': '/v1/chat/completions',
      responses: '/v1/responses',
      anthropic: '/v1/messages',
    };

    for (const upstreamProtocol of protocols) {
      assert(expectedPaths[upstreamProtocol], `Unknown upstream protocol: ${upstreamProtocol}`);
      let bridge = null;
      const protocolRoot = path.join(tempRoot, upstreamProtocol);
      try {
        bridge = await startBridge(path.join(protocolRoot, 'bridge'), upstream.port, upstreamProtocol);
        let requestStart;
        let newRequests;
        if (selectedAgent === 'all' || selectedAgent === 'pi') {
          requestStart = upstream.requests.length;
          await checkPi(path.join(protocolRoot, 'pi'), bridge);
          newRequests = upstream.requests.slice(requestStart);
          assert(newRequests.some((request) => request.path === expectedPaths[upstreamProtocol] && request.stream), `Pi did not reach ${upstreamProtocol} as a stream`);
          console.log(`ok - Pi RPC real protocol call (${upstreamProtocol})`);
        }
        if (selectedAgent === 'all' || selectedAgent === 'claude') {
          requestStart = upstream.requests.length;
          try {
            await checkClaude(path.join(protocolRoot, 'claude'), bridge);
          } catch (error) {
            const requestSummary = upstream.requests.slice(requestStart);
            throw new Error(`${error.message}; upstream=${JSON.stringify(requestSummary)}`);
          }
          newRequests = upstream.requests.slice(requestStart);
          assert(newRequests.some((request) => request.path === expectedPaths[upstreamProtocol] && request.stream), `Claude Code did not reach ${upstreamProtocol} as a stream`);
          console.log(`ok - Claude Code real protocol call (${upstreamProtocol})`);
        }
        if (selectedAgent === 'all' || selectedAgent === 'codex') {
          requestStart = upstream.requests.length;
          await checkCodex(path.join(protocolRoot, 'codex'), bridge);
          newRequests = upstream.requests.slice(requestStart);
          assert(newRequests.some((request) => request.path === expectedPaths[upstreamProtocol] && request.stream), `Codex did not reach ${upstreamProtocol} as a stream`);
          console.log(`ok - Codex App Server real protocol call (${upstreamProtocol})`);
        }
      } finally {
        await bridge?.close().catch(() => {});
        fs.rmSync(protocolRoot, { recursive: true, force: true });
      }
    }
  } finally {
    await upstream?.close().catch(() => {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Protocol contract failed: ${error.message}`);
  process.exitCode = 1;
});
