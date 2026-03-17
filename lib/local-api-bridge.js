#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const runtimePath = process.env.CC_WEB_BRIDGE_RUNTIME_PATH || '';
const statePath = process.env.CC_WEB_BRIDGE_STATE_PATH || '';

if (!runtimePath || !statePath) {
  console.error('Missing bridge runtime/state path');
  process.exit(1);
}

const ANTHROPIC_SDK_VERSION = '0.74.0';
const UPSTREAM_TIMEOUT_MS = 600000;

let idCounter = 0;
function uniqueId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(port) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  }, null, 2));
}

function loadRuntime() {
  const runtime = readJson(runtimePath);
  if (!runtime || !runtime.token || !runtime.upstream?.apiKey || !runtime.upstream?.apiBase) {
    return null;
  }
  if (!runtime.upstream.kind) runtime.upstream.kind = 'openai';
  return runtime;
}

function jsonResponse(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function sseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function extractToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  return apiKey || '';
}

function ensureAuthorized(req, res, runtime) {
  const token = extractToken(req);
  if (!token || token !== runtime.token) {
    jsonResponse(res, 401, {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid bridge token',
      },
    });
    return false;
  }
  return true;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function buildUpstreamUrl(apiBase, endpoint) {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  const normalized = String(endpoint || '').trim().replace(/^\/+/, '');
  if (!base) throw new Error('Missing upstream apiBase');
  if (/\/v\d+(?:\.\d+)?$/i.test(base)) return new URL(`${base}/${normalized}`);
  return new URL(`${base}/v1/${normalized}`);
}

function upstreamKind(runtime) {
  return runtime?.upstream?.kind === 'anthropic' ? 'anthropic' : 'openai';
}

function requestJson(url, options = {}, body = '', timeoutMs = UPSTREAM_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, options, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({
          statusCode: res.statusCode || 500,
          headers: res.headers,
          text,
          json,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Upstream request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

function stainlessOs() {
  const platform = String(process.platform || '').toLowerCase();
  if (platform === 'darwin') return 'MacOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  if (platform === 'android') return 'Android';
  if (platform === 'freebsd') return 'FreeBSD';
  if (platform === 'openbsd') return 'OpenBSD';
  return platform ? `Other:${platform}` : 'Unknown';
}

function stainlessArch() {
  const arch = String(process.arch || '').toLowerCase();
  if (arch === 'x32') return 'x32';
  if (arch === 'x64' || arch === 'x86_64') return 'x64';
  if (arch === 'arm') return 'arm';
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  return arch ? `other:${arch}` : 'unknown';
}

function buildAnthropicHeaders(runtime, options = {}) {
  const {
    accept = 'application/json',
    contentType = null,
    anthropicVersion = '2023-06-01',
    retryCount = '0',
    timeoutMs = 600000,
    incomingHeaders = null,
    extra = {},
  } = options;
  const headers = {
    Accept: accept,
    'User-Agent': String(incomingHeaders?.['user-agent'] || `Anthropic/JS ${ANTHROPIC_SDK_VERSION}`),
    'X-Stainless-Retry-Count': String(incomingHeaders?.['x-stainless-retry-count'] || retryCount),
    'X-Stainless-Timeout': String(
      incomingHeaders?.['x-stainless-timeout']
      || Math.max(1, Math.trunc(Number(timeoutMs || 600000) / 1000))
    ),
    'X-Stainless-Lang': String(incomingHeaders?.['x-stainless-lang'] || 'js'),
    'X-Stainless-Package-Version': String(incomingHeaders?.['x-stainless-package-version'] || ANTHROPIC_SDK_VERSION),
    'X-Stainless-OS': String(incomingHeaders?.['x-stainless-os'] || stainlessOs()),
    'X-Stainless-Arch': String(incomingHeaders?.['x-stainless-arch'] || stainlessArch()),
    'X-Stainless-Runtime': String(incomingHeaders?.['x-stainless-runtime'] || 'node'),
    'X-Stainless-Runtime-Version': String(incomingHeaders?.['x-stainless-runtime-version'] || process.version),
    'X-Api-Key': runtime.upstream.apiKey,
    'anthropic-version': anthropicVersion,
    ...extra,
  };
  if (contentType) headers['content-type'] = contentType;
  return headers;
}

function anthropicSystemToInstructions(system) {
  if (!Array.isArray(system)) return '';
  return system
    .map((item) => item?.text || '')
    .filter(Boolean)
    .join('\n\n');
}

function openAiSystemToAnthropicSystem(body) {
  const chunks = [];
  if (typeof body?.instructions === 'string' && body.instructions.trim()) {
    chunks.push(body.instructions.trim());
  }
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (item?.type !== 'message') continue;
    if (item.role !== 'developer' && item.role !== 'system') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === 'input_text' || content?.type === 'output_text' || content?.type === 'text') {
        if (content.text) chunks.push(content.text);
      }
    }
  }
  return chunks.map((text) => ({ type: 'text', text }));
}

function openAiImageToAnthropic(block) {
  const url = String(block?.image_url || '').trim();
  if (!url) return null;
  const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataMatch) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataMatch[1],
        data: dataMatch[2],
      },
    };
  }
  return {
    type: 'image',
    source: {
      type: 'url',
      url,
    },
  };
}

function openAiContentToAnthropic(block) {
  if (!block) return null;
  if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
    return { type: 'text', text: block.text || '' };
  }
  if (block.type === 'input_image') return openAiImageToAnthropic(block);
  return null;
}

function pushAnthropicMessage(messages, role, block) {
  if (!block) return;
  const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
  const last = messages[messages.length - 1];
  if (last && last.role === normalizedRole) {
    last.content.push(block);
    return;
  }
  messages.push({ role: normalizedRole, content: [block] });
}

function translateOpenAiInputToAnthropicMessages(body) {
  const messages = [];
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (!item) continue;
    if (item.type === 'message') {
      if (item.role === 'developer' || item.role === 'system') continue;
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      for (const content of Array.isArray(item.content) ? item.content : []) {
        const block = openAiContentToAnthropic(content);
        if (block) pushAnthropicMessage(messages, role, block);
      }
      continue;
    }
    if (item.type === 'function_call') {
      pushAnthropicMessage(messages, 'assistant', {
        type: 'tool_use',
        id: item.call_id || item.id || uniqueId('call'),
        name: item.name || 'tool',
        input: (() => {
          try { return JSON.parse(item.arguments || '{}'); } catch { return {}; }
        })(),
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      pushAnthropicMessage(messages, 'user', {
        type: 'tool_result',
        tool_use_id: item.call_id || '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        is_error: !!item.is_error,
      });
    }
  }
  return messages;
}

function translateOpenAiToolsToAnthropic(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter((tool) => tool && (tool.name || tool.type === 'function'))
    .map((tool) => ({
      name: tool.name || tool.function?.name || 'tool',
      description: tool.description || tool.function?.description || '',
      input_schema: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} },
    }));
}

function translateOpenAiToolChoiceToAnthropic(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'none') return undefined;
  if (typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.name) {
    return { type: 'tool', name: toolChoice.name };
  }
  return undefined;
}

function translateAnthropicToolChoiceToOpenAi(toolChoice) {
  if (!toolChoice) return 'auto';
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', name: toolChoice.name };
  }
  return 'auto';
}

function translateOpenAiRequestToAnthropic(body, runtime) {
  const payload = {
    model: runtime.upstream.defaultModel || body.model || '',
    system: openAiSystemToAnthropicSystem(body),
    messages: translateOpenAiInputToAnthropicMessages(body),
    max_tokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : 32000,
    stream: false,
  };
  const tools = translateOpenAiToolsToAnthropic(body.tools);
  if (tools?.length) {
    payload.tools = tools;
    const tc = translateOpenAiToolChoiceToAnthropic(body.tool_choice);
    if (tc) payload.tool_choice = tc;
  }
  return payload;
}

function anthropicToolResultToString(block) {
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((item) => {
      if (typeof item === 'string') return item;
      if (item?.type === 'text') return item.text || '';
      return JSON.stringify(item);
    }).join('\n');
  }
  return '';
}

function anthropicImageToOpenAi(block) {
  const source = block?.source || {};
  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type || 'image/png';
    return { type: 'input_image', image_url: `data:${mediaType};base64,${source.data}` };
  }
  if (source.type === 'url' && source.url) {
    return { type: 'input_image', image_url: source.url };
  }
  return null;
}

function anthropicContentToOpenAi(role, block) {
  if (!block) return null;
  if (block.type === 'text') {
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text || '' };
  }
  if (block.type === 'thinking' && role === 'assistant') {
    return { type: 'output_text', text: block.thinking || '' };
  }
  if (block.type === 'image' && role !== 'assistant') return anthropicImageToOpenAi(block);
  return null;
}

function translateAnthropicMessages(messages) {
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(message?.content)
      ? message.content
      : [{ type: 'text', text: String(message?.content || '') }];
    let pending = [];
    const flushPending = () => {
      if (!pending.length) return;
      input.push({ type: 'message', role, content: pending });
      pending = [];
    };
    for (const block of blocks) {
      if (role === 'assistant' && block?.type === 'tool_use') {
        flushPending();
        input.push({
          type: 'function_call',
          call_id: block.id || uniqueId('call'),
          name: block.name || 'tool',
          arguments: JSON.stringify(block.input || {}),
        });
        continue;
      }
      if (role === 'user' && block?.type === 'tool_result') {
        flushPending();
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id || '',
          output: anthropicToolResultToString(block),
        });
        continue;
      }
      const converted = anthropicContentToOpenAi(role, block);
      if (converted) pending.push(converted);
    }
    flushPending();
  }
  return input;
}

function translateAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
      strict: false,
    }));
}

function translateAnthropicRequest(body, runtime) {
  const payload = {
    model: runtime.upstream.defaultModel || body.model || '',
    input: translateAnthropicMessages(body.messages),
    stream: false,
    store: false,
  };
  const instructions = anthropicSystemToInstructions(body.system);
  if (instructions) payload.instructions = instructions;
  const tools = translateAnthropicTools(body.tools);
  if (tools?.length) {
    payload.tools = tools;
    payload.tool_choice = translateAnthropicToolChoiceToOpenAi(body.tool_choice);
  }
  if (typeof body.max_tokens === 'number') payload.max_output_tokens = body.max_tokens;
  const effort = body?.output_config?.effort;
  if (effort) payload.reasoning = { effort };
  return payload;
}

function normalizeToolArguments(input) {
  if (input === null || input === undefined) return '{}';
  if (typeof input === 'string') {
    const trimmed = input.trim();
    return trimmed || '{}';
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '{}';
  }
}

function collectOpenAiBlocks(response) {
  const blocks = [];
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (!item) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!part) continue;
        if (part.type === 'output_text' || part.type === 'text') {
          const text = String(part.text || '');
          if (text) blocks.push({ kind: 'text', text });
        }
      }
      continue;
    }
    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((s) => s?.text || '').filter(Boolean).join('\n')
        : '';
      if (summary) blocks.push({ kind: 'thinking', thinking: summary });
      continue;
    }
    if (item.type === 'function_call') {
      blocks.push({
        kind: 'tool_use',
        id: item.call_id || item.id || uniqueId('call'),
        name: item.name || 'tool',
        input: normalizeToolArguments(item.arguments),
      });
    }
  }
  if (!blocks.length && typeof response?.output_text === 'string' && response.output_text) {
    blocks.push({ kind: 'text', text: response.output_text });
  }
  return blocks;
}

function collectAnthropicBlocks(response) {
  const blocks = [];
  for (const block of Array.isArray(response?.content) ? response.content : []) {
    if (!block) continue;
    if (block.type === 'thinking') {
      const text = String(block.thinking || '');
      if (text) blocks.push({ kind: 'thinking', thinking: text });
      continue;
    }
    if (block.type === 'text') {
      const text = String(block.text || '');
      if (text) blocks.push({ kind: 'text', text });
      continue;
    }
    if (block.type === 'tool_use') {
      blocks.push({
        kind: 'tool_use',
        id: block.id || uniqueId('call'),
        name: block.name || 'tool',
        input: normalizeToolArguments(block.input),
      });
    }
  }
  return blocks;
}

function sendOpenAiSseFromBlocks(res, blocks, model, usage = {}) {
  sseStart(res);
  const responseId = uniqueId('resp');
  sseEvent(res, 'response.created', {
    type: 'response.created',
    response: {
      id: responseId,
      model,
      output: [],
    },
  });

  const output = [];
  let outputIndex = 0;

  for (const block of blocks) {
    if (block.kind === 'thinking') {
      const item = {
        id: uniqueId('rs'),
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: block.thinking }],
      };
      sseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item,
      });
      sseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item,
      });
      output.push(item);
      outputIndex += 1;
      continue;
    }

    if (block.kind === 'text') {
      const item = {
        id: uniqueId('msg'),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '' }],
      };
      sseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item,
      });
      sseEvent(res, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        output_index: outputIndex,
        content_index: 0,
        delta: block.text,
      });
      item.content[0].text = block.text;
      sseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item,
      });
      output.push(item);
      outputIndex += 1;
      continue;
    }

    if (block.kind === 'tool_use') {
      const blockId = block.id || uniqueId('call');
      const item = {
        type: 'function_call',
        id: blockId,
        call_id: blockId,
        name: block.name || 'tool',
        arguments: '',
      };
      sseEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item,
      });
      sseEvent(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: outputIndex,
        delta: block.input || '{}',
      });
      item.arguments = block.input || '{}';
      sseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item,
      });
      output.push(item);
      outputIndex += 1;
    }
  }

  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  sseEvent(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: responseId,
      model,
      output,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    },
  });
  res.end();
}

function sendAnthropicResponse(res, responseJson, model) {
  const blocks = collectOpenAiBlocks(responseJson);
  const stopReason = blocks.some((block) => block.kind === 'tool_use') ? 'tool_use' : 'end_turn';
  const usage = responseJson?.usage || {};
  sseStart(res);
  sseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: uniqueId('msg'),
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens || 0, output_tokens: 0 },
    },
  });

  let index = 0;
  for (const block of blocks) {
    if (block.kind === 'thinking') {
      sseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      });
      sseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
      index += 1;
      continue;
    }

    if (block.kind === 'text') {
      sseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      sseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
      index += 1;
      continue;
    }

    if (block.kind === 'tool_use') {
      sseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id || uniqueId('toolu'),
          name: block.name || 'tool',
          input: {},
        },
      });
      sseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: block.input || '{}' },
      });
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
  }

  sseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: usage.output_tokens || 0,
    },
  });
  sseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function handleAnthropicMessages(req, res, runtime) {
  const rawBody = await readRequestBody(req);
  let body = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    jsonResponse(res, 400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Invalid JSON body',
      },
    });
    return;
  }

  if (upstreamKind(runtime) === 'anthropic') {
    body.model = runtime.upstream.defaultModel || body.model || '';
    const upstreamUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'messages');
    const client = upstreamUrl.protocol === 'https:' ? https : http;
    const headers = buildAnthropicHeaders(runtime, {
      incomingHeaders: req.headers,
      anthropicVersion: req.headers['anthropic-version'] || '2023-06-01',
      contentType: 'application/json',
      accept: req.headers.accept || 'text/event-stream',
    });
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    const upstreamReq = client.request(upstreamUrl, { method: 'POST', headers }, (upstreamRes) => {
      const responseHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers || {})) {
        if (!value) continue;
        if (['connection', 'keep-alive', 'content-length', 'transfer-encoding'].includes(String(key).toLowerCase())) continue;
        responseHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', (error) => {
      jsonResponse(res, 502, {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream request failed: ${error.message}`,
        },
      });
    });
    upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstreamReq.destroy(new Error('Upstream request timed out')));
    upstreamReq.write(JSON.stringify(body));
    upstreamReq.end();
    return;
  }

  const upstreamPayload = translateAnthropicRequest(body || {}, runtime);
  const upstreamUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'responses');
  let upstreamResponse;
  try {
    upstreamResponse = await requestJson(upstreamUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.upstream.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    }, JSON.stringify(upstreamPayload));
  } catch (error) {
    jsonResponse(res, 502, {
      type: 'error',
      error: {
        type: 'api_error',
        message: `Upstream request failed: ${error.message}`,
      },
    });
    return;
  }

  if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300 || !upstreamResponse.json) {
    jsonResponse(res, upstreamResponse.statusCode || 502, {
      type: 'error',
      error: {
        type: 'api_error',
        message: upstreamResponse.text || 'Upstream returned an invalid response',
      },
    });
    return;
  }

  sendAnthropicResponse(res, upstreamResponse.json, upstreamPayload.model);
}

async function proxyOpenAiModels(res, runtime) {
  const upstreamUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'models');
  let upstreamResponse;
  try {
    upstreamResponse = await requestJson(upstreamUrl, {
      method: 'GET',
      headers: upstreamKind(runtime) === 'anthropic'
        ? buildAnthropicHeaders(runtime, {
            accept: 'application/json',
            anthropicVersion: '2023-06-01',
          })
        : {
            authorization: `Bearer ${runtime.upstream.apiKey}`,
            accept: 'application/json',
          },
    });
  } catch (error) {
    jsonResponse(res, 502, { error: { message: `Upstream request failed: ${error.message}` } });
    return;
  }
  res.writeHead(upstreamResponse.statusCode || 502, {
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(upstreamResponse.text || '{}');
}

async function proxyOpenAiResponse(req, res, runtime) {
  if (upstreamKind(runtime) === 'anthropic') {
    const rawBody = await readRequestBody(req);
    let body = null;
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {
      jsonResponse(res, 400, { error: { message: 'Invalid JSON body' } });
      return;
    }
    const upstreamPayload = translateOpenAiRequestToAnthropic(body || {}, runtime);
    const upstreamUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'messages');
    let upstreamResponse;
    try {
      upstreamResponse = await requestJson(upstreamUrl, {
        method: 'POST',
        headers: buildAnthropicHeaders(runtime, {
          anthropicVersion: '2023-06-01',
          contentType: 'application/json',
          accept: 'application/json',
          incomingHeaders: req.headers,
        }),
      }, JSON.stringify(upstreamPayload));
    } catch (error) {
      jsonResponse(res, 502, { error: { message: `Upstream request failed: ${error.message}` } });
      return;
    }
    if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300 || !upstreamResponse.json) {
      jsonResponse(res, upstreamResponse.statusCode || 502, { error: { message: upstreamResponse.text || 'Upstream returned an invalid response' } });
      return;
    }
    sendOpenAiSseFromBlocks(res, collectAnthropicBlocks(upstreamResponse.json), upstreamPayload.model, upstreamResponse.json.usage || {});
    return;
  }

  const rawBody = await readRequestBody(req);
  const upstreamUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'responses');
  const client = upstreamUrl.protocol === 'https:' ? https : http;
  const headers = {
    authorization: `Bearer ${runtime.upstream.apiKey}`,
    'content-type': req.headers['content-type'] || 'application/json',
  };
  if (req.headers.accept) headers.accept = req.headers.accept;
  if (req.headers['x-codex-beta-features']) headers['x-codex-beta-features'] = req.headers['x-codex-beta-features'];
  if (req.headers['x-codex-turn-metadata']) headers['x-codex-turn-metadata'] = req.headers['x-codex-turn-metadata'];
  if (req.headers.session_id) headers.session_id = req.headers.session_id;
  if (rawBody) headers['content-length'] = Buffer.byteLength(rawBody);

  const upstreamReq = client.request(upstreamUrl, {
    method: req.method,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers || {})) {
      if (!value) continue;
      if (['connection', 'keep-alive', 'content-length', 'transfer-encoding'].includes(String(key).toLowerCase())) continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (error) => {
    jsonResponse(res, 502, { error: { message: `Upstream request failed: ${error.message}` } });
  });
  upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstreamReq.destroy(new Error('Upstream request timed out')));

  if (rawBody) upstreamReq.write(rawBody);
  upstreamReq.end();
}

function cleanupState() {
  try { fs.unlinkSync(statePath); } catch {}
}
process.on('exit', cleanupState);
process.on('SIGINT', () => { cleanupState(); process.exit(0); });
process.on('SIGTERM', () => { cleanupState(); process.exit(0); });

const server = http.createServer(async (req, res) => {
  const runtime = loadRuntime();
  if (!runtime) {
    jsonResponse(res, 503, { error: { message: 'Bridge runtime is not configured' } });
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/openai/v1/models')) {
      if (!ensureAuthorized(req, res, runtime)) return;
      await proxyOpenAiModels(res, runtime);
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/anthropic/v1/models')) {
      if (!ensureAuthorized(req, res, runtime)) return;
      await proxyOpenAiModels(res, runtime);
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/openai/responses')) {
      if (!ensureAuthorized(req, res, runtime)) return;
      await proxyOpenAiResponse(req, res, runtime);
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/anthropic/v1/messages')) {
      if (!ensureAuthorized(req, res, runtime)) return;
      await handleAnthropicMessages(req, res, runtime);
      return;
    }

    jsonResponse(res, 404, { error: { message: 'Not found' } });
  } catch (error) {
    jsonResponse(res, 500, {
      error: {
        message: error.message || 'Bridge internal error',
      },
    });
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  writeState(typeof addr === 'object' && addr ? addr.port : 0);
});
