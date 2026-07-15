#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { buildVersionedEndpointUrl, detectConfiguredEndpoint } = require('./api-endpoint');

const runtimePath = process.env.CC_WEB_BRIDGE_RUNTIME_PATH || '';
const statePath = process.env.CC_WEB_BRIDGE_STATE_PATH || '';
const debugLogPath = process.env.CC_WEB_BRIDGE_DEBUG_LOG || '';

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

function getScriptFingerprint() {
  try {
    const stat = fs.statSync(__filename);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeUpstream(upstream) {
  if (!upstream || typeof upstream !== 'object') return null;
  const apiKey = String(upstream.apiKey || '');
  const apiBase = String(upstream.apiBase || '').trim();
  if (!apiKey || !apiBase) return null;
  return {
    name: String(upstream.name || '').trim() || 'AI Provider',
    apiKey,
    apiBase,
    kind: upstream.kind === 'anthropic' ? 'anthropic' : 'openai',
    protocol: upstream.kind === 'anthropic'
      ? 'messages'
      : (upstream.protocol === 'responses' || upstream.protocol === 'chat-completions'
          ? upstream.protocol
          : 'auto'),
    defaultModel: String(upstream.defaultModel || '').trim(),
  };
}

function writeState(port) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    pid: process.pid,
    port,
    scriptFingerprint: getScriptFingerprint(),
    startedAt: new Date().toISOString(),
  }, null, 2));
}

function loadRuntime(requestToken = '') {
  const runtime = readJson(runtimePath);
  if (!runtime) return null;

  if (runtime.runtimes && typeof runtime.runtimes === 'object' && !Array.isArray(runtime.runtimes)) {
    const normalizedToken = String(requestToken || runtime.token || '').trim();
    const entries = [];
    for (const [key, value] of Object.entries(runtime.runtimes)) {
      if (!value || typeof value !== 'object') continue;
      const token = String(value.token || key).trim();
      const upstream = normalizeUpstream(value.upstream || value);
      if (!token || !upstream) continue;
      entries.push({ token, upstream });
    }
    if (!entries.length) return null;
    if (normalizedToken) {
      return entries.find((entry) => entry.token === normalizedToken) || null;
    }
    return entries.find((entry) => entry.token === String(runtime.token || '').trim()) || entries[0];
  }

  const upstream = normalizeUpstream(runtime.upstream);
  const token = String(runtime.token || '').trim();
  if (!token || !upstream) return null;
  return { token, upstream };
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'default' || normalized === 'auto' || normalized === 'inherit') return '';
  return normalized;
}

function resolveRequestModel(runtime, body) {
  return String(runtime?.upstream?.defaultModel || body?.model || '').trim();
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

function ensureAuthorized(req, res, runtime, tokenOverride = '') {
  const token = String(tokenOverride || extractToken(req) || '').trim();
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

function appendDebugLog(entry) {
  if (!debugLogPath) return;
  try {
    fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
    fs.appendFileSync(debugLogPath, `${JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    })}\n`);
  } catch {}
}

function buildUpstreamUrl(apiBase, endpoint) {
  if (!String(apiBase || '').trim()) throw new Error('Missing upstream apiBase');
  return new URL(buildVersionedEndpointUrl(apiBase, endpoint));
}

function configuredOpenAiEndpoint(runtime) {
  const endpoint = detectConfiguredEndpoint(runtime?.upstream?.apiBase);
  if (endpoint === 'chat/completions' || endpoint === 'responses') return endpoint;
  if (runtime?.upstream?.protocol === 'chat-completions') return 'chat/completions';
  if (runtime?.upstream?.protocol === 'responses') return 'responses';
  return '';
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

function proxyResponseHeaders(headers = {}) {
  const forwarded = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!value) continue;
    const lower = String(key || '').toLowerCase();
    if (['connection', 'keep-alive', 'content-length'].includes(lower)) continue;
    forwarded[key] = value;
  }
  return forwarded;
}

function requestStream(url, options = {}, body = '', timeoutMs = UPSTREAM_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, options, (res) => {
      resolve({ req, res });
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
  if (typeof system === 'string') return system.trim();
  if (!Array.isArray(system)) return '';
  return system
    .map((item) => (typeof item === 'string' ? item : item?.text) || '')
    .filter(Boolean)
    .join('\n\n');
}

function isOpenAiMessageItem(item) {
  return !!item && (
    item.type === 'message'
    || (!item.type && typeof item.role === 'string' && Object.prototype.hasOwnProperty.call(item, 'content'))
  );
}

function openAiMessageContentBlocks(item) {
  if (Array.isArray(item?.content)) return item.content;
  if (typeof item?.content !== 'string') return [];
  return [{
    type: item.role === 'assistant' ? 'output_text' : 'input_text',
    text: item.content,
  }];
}

function openAiSystemToAnthropicSystem(body) {
  const chunks = [];
  if (typeof body?.instructions === 'string' && body.instructions.trim()) {
    chunks.push(body.instructions.trim());
  }
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (!isOpenAiMessageItem(item)) continue;
    if (item.role !== 'developer' && item.role !== 'system') continue;
    for (const content of openAiMessageContentBlocks(item)) {
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
  if (typeof body?.input === 'string' && body.input) {
    messages.push({ role: 'user', content: [{ type: 'text', text: body.input }] });
  }
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (!item) continue;
    if (isOpenAiMessageItem(item)) {
      if (item.role === 'developer' || item.role === 'system') continue;
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      for (const content of openAiMessageContentBlocks(item)) {
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
  const resolvedModel = resolveRequestModel(runtime, body);
  const requestEffort = normalizeReasoningEffort(body?.output_config?.effort);
  const payload = {
    model: resolvedModel,
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
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  if (typeof body.top_p === 'number') payload.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences;
  if (requestEffort) payload.reasoning = { effort: requestEffort };
  return payload;
}

function openAiContentToChatCompletionPart(block) {
  if (!block) return null;
  if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
    return { type: 'text', text: block.text || '' };
  }
  if (block.type === 'input_image') {
    return {
      type: 'image_url',
      image_url: {
        url: block.image_url || '',
      },
    };
  }
  return null;
}

function normalizeChatCompletionContent(parts) {
  const normalized = Array.isArray(parts) ? parts.filter(Boolean) : [];
  if (!normalized.length) return '';
  if (normalized.every((part) => part.type === 'text')) {
    return normalized.map((part) => part.text || '').join('');
  }
  return normalized;
}

function extractOpenAiSystemChunks(body) {
  const chunks = [];
  if (typeof body?.instructions === 'string' && body.instructions.trim()) {
    chunks.push(body.instructions.trim());
  }
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (!isOpenAiMessageItem(item)) continue;
    if (item.role !== 'developer' && item.role !== 'system') continue;
    for (const content of openAiMessageContentBlocks(item)) {
      if ((content?.type === 'input_text' || content?.type === 'output_text' || content?.type === 'text') && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks;
}

function extractOpenAiReasoningText(item) {
  const summary = Array.isArray(item?.summary)
    ? item.summary.map((part) => part?.text || '').filter(Boolean).join('\n\n')
    : '';
  if (summary) return summary;
  return Array.isArray(item?.content)
    ? item.content.map((part) => part?.text || '').filter(Boolean).join('\n\n')
    : '';
}

function translateResponsesInputToChatCompletionsMessages(body) {
  const messages = [];
  const ensureAssistantMessage = () => {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') return last;
    const message = { role: 'assistant', content: '' };
    messages.push(message);
    return message;
  };
  const appendAssistantContent = (message, content) => {
    if (content === '' || content === null || content === undefined) return;
    if (!message.content || (Array.isArray(message.content) && message.content.length === 0)) {
      message.content = content;
      return;
    }
    if (typeof message.content === 'string' && typeof content === 'string') {
      message.content += content;
      return;
    }
    const currentParts = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: String(message.content) }];
    const nextParts = Array.isArray(content)
      ? content
      : [{ type: 'text', text: String(content) }];
    message.content = [...currentParts, ...nextParts];
  };
  if (typeof body?.input === 'string' && body.input) {
    messages.push({ role: 'user', content: body.input });
  }
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (!item) continue;
    if (isOpenAiMessageItem(item)) {
      if (item.role === 'developer' || item.role === 'system') continue;
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      const parts = [];
      for (const content of openAiMessageContentBlocks(item)) {
        const converted = openAiContentToChatCompletionPart(content);
        if (converted) parts.push(converted);
      }
      const content = normalizeChatCompletionContent(parts);
      if (role === 'assistant') {
        appendAssistantContent(ensureAssistantMessage(), content);
      } else {
        messages.push({ role, content });
      }
      continue;
    }
    if (item.type === 'reasoning') {
      const reasoning = extractOpenAiReasoningText(item);
      if (reasoning) {
        const message = ensureAssistantMessage();
        message.reasoning_content = message.reasoning_content
          ? `${message.reasoning_content}\n\n${reasoning}`
          : reasoning;
      }
      continue;
    }
    if (item.type === 'function_call') {
      const callId = item.call_id || item.id || uniqueId('call');
      const message = ensureAssistantMessage();
      if (!Array.isArray(message.tool_calls)) message.tool_calls = [];
      message.tool_calls.push({
        id: callId,
        type: 'function',
        function: {
          name: item.name || 'tool',
          arguments: normalizeToolArguments(item.arguments),
        },
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
    }
  }
  return messages;
}

function translateResponsesToolsToChatCompletions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const converted = tools
    .map((tool) => {
      const name = tool?.function?.name || tool?.name || '';
      if (!name) return null;
      return {
        type: 'function',
        function: {
          name,
          description: tool?.function?.description || tool?.description || '',
          parameters: tool?.function?.parameters || tool?.parameters || { type: 'object', properties: {} },
        },
      };
    })
    .filter(Boolean);
  return converted.length ? converted : undefined;
}

function translateResponsesToolChoiceToChatCompletions(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    const name = toolChoice.function?.name || toolChoice.name || '';
    if (name) {
      return {
        type: 'function',
        function: { name },
      };
    }
  }
  return undefined;
}

function translateResponsesRequestToChatCompletions(body, runtime, options = {}) {
  const systemChunks = extractOpenAiSystemChunks(body);
  const messages = translateResponsesInputToChatCompletionsMessages(body);
  if (systemChunks.length) {
    messages.unshift({
      role: 'system',
      content: systemChunks.join('\n\n'),
    });
  }

  const payload = {
    model: resolveRequestModel(runtime, body),
    messages,
    stream: options.stream === true,
  };
  if (typeof body?.max_output_tokens === 'number') payload.max_tokens = body.max_output_tokens;
  if (typeof body?.temperature === 'number') payload.temperature = body.temperature;
  if (typeof body?.top_p === 'number') payload.top_p = body.top_p;
  if (typeof body?.stop === 'string' || Array.isArray(body?.stop)) payload.stop = body.stop;
  if (typeof body?.parallel_tool_calls === 'boolean') payload.parallel_tool_calls = body.parallel_tool_calls;
  const tools = translateResponsesToolsToChatCompletions(body?.tools);
  if (tools?.length) payload.tools = tools;
  const toolChoice = translateResponsesToolChoiceToChatCompletions(body?.tool_choice);
  if (toolChoice !== undefined) payload.tool_choice = toolChoice;
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

function chatCompletionContentToOpenAiParts(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'output_text', text: content }] : [];
  }
  const parts = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (!item) continue;
    if (typeof item === 'string') {
      if (item) parts.push({ type: 'output_text', text: item });
      continue;
    }
    if (item.type === 'text' && item.text) {
      parts.push({ type: 'output_text', text: item.text });
    }
  }
  return parts;
}

function numberOrZero(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function normalizeChatCompletionUsage(usage) {
  const inputTokens = numberOrZero(usage?.input_tokens, usage?.prompt_tokens);
  const outputTokens = numberOrZero(usage?.output_tokens, usage?.completion_tokens);
  const totalTokens = numberOrZero(usage?.total_tokens, inputTokens + outputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function chatCompletionsToOpenAiResponse(responseJson, model) {
  const choice = Array.isArray(responseJson?.choices) ? responseJson.choices[0] : null;
  const message = choice?.message || {};
  const output = [];
  const reasoning = String(
    message.reasoning_content
    || message.reasoning
    || message.thinking
    || '',
  );
  if (reasoning) {
    output.push({
      id: uniqueId('rs'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }
  const content = chatCompletionContentToOpenAiParts(message.content);
  if (content.length) {
    output.push({
      type: 'message',
      role: 'assistant',
      content,
    });
  }
  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const callId = toolCall?.id || uniqueId('call');
    output.push({
      type: 'function_call',
      id: callId,
      call_id: callId,
      name: toolCall?.function?.name || 'tool',
      arguments: normalizeToolArguments(toolCall?.function?.arguments),
    });
  }
  return {
    id: responseJson?.id || uniqueId('resp'),
    model: responseJson?.model || model || '',
    output,
    output_text: content.map((item) => item.text || '').join(''),
    usage: normalizeChatCompletionUsage(responseJson?.usage || {}),
  };
}

function extractUpstreamError(response) {
  const error = response?.json?.error || null;
  const rawMessage = String(error?.message || response?.json?.message || response?.text || '');
  let nestedMessage = '';
  try {
    const parsed = rawMessage ? JSON.parse(rawMessage) : null;
    nestedMessage = String(parsed?.error?.message || parsed?.message || '');
  } catch {}
  return {
    code: String(error?.code || '').toLowerCase(),
    type: String(error?.type || '').toLowerCase(),
    message: `${rawMessage} ${nestedMessage}`.trim().toLowerCase(),
  };
}

function requestHasResponsesInput(body) {
  if (typeof body?.input === 'string') return body.input.trim().length > 0;
  return Array.isArray(body?.input) && body.input.length > 0;
}

function requestHasChatMessages(body) {
  return Array.isArray(body?.messages) && body.messages.length > 0;
}

function errorRequiresField(message, field) {
  const escaped = String(field || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return false;
  const qualifier = '(?:missing|required|expected|empty|must\\s+(?:provide|include|contain)|should\\s+(?:provide|include|contain)|unknown|unsupported|not\\s+supported)';
  return new RegExp(`${qualifier}[^.]{0,80}\\b${escaped}\\b|\\b${escaped}\\b[^.]{0,80}${qualifier}`, 'i').test(message);
}

function endpointUnavailableStatus(status) {
  return [404, 405, 415, 501].includes(Number(status || 0));
}

function shouldFallbackToChatCompletions(response, upstreamPayload = null) {
  if (!response || (response.statusCode >= 200 && response.statusCode < 300)) return false;
  const status = Number(response.statusCode || 0);
  if (![400, 404, 405, 415, 422, 500, 501, 502, 504].includes(status)) return false;
  const err = extractUpstreamError(response);
  return (
    endpointUnavailableStatus(status)
    || err.code.includes('bad_response_status_code')
    || err.code.includes('convert_request_failed')
    || err.code.includes('not_implemented')
    || err.type.includes('not_implemented')
    || err.type.includes('bad_response_status_code')
    || err.message.includes('not implemented')
    || err.message.includes('unsupported')
    || err.message.includes('responses')
    || err.message.includes('openai_error')
    || (requestHasResponsesInput(upstreamPayload) && errorRequiresField(err.message, 'messages'))
  );
}

function shouldFallbackToResponses(response, chatPayload = null) {
  if (!response || (response.statusCode >= 200 && response.statusCode < 300)) return false;
  const status = Number(response.statusCode || 0);
  if (![400, 404, 405, 415, 422, 500, 501, 502, 504].includes(status)) return false;
  const err = extractUpstreamError(response);
  return (
    endpointUnavailableStatus(status)
    || err.code.includes('bad_response_status_code')
    || err.code.includes('convert_request_failed')
    || err.code.includes('not_implemented')
    || err.type.includes('not_implemented')
    || err.type.includes('bad_response_status_code')
    || err.message.includes('not implemented')
    || err.message.includes('/responses')
    || err.message.includes('responses api')
    || err.message.includes('chat/completions')
    || err.message.includes('openai_error')
    || (requestHasChatMessages(chatPayload) && errorRequiresField(err.message, 'input'))
    || (requestHasChatMessages(chatPayload) && errorRequiresField(err.message, 'messages'))
  );
}

async function requestOpenAiCompatibleResponsesOnly(upstreamPayload, runtime) {
  appendDebugLog({
    phase: 'upstream_request',
    endpoint: 'responses',
    upstreamKind: upstreamKind(runtime),
    model: upstreamPayload.model || '',
    toolCount: Array.isArray(upstreamPayload.tools) ? upstreamPayload.tools.length : 0,
    toolChoice: upstreamPayload.tool_choice ?? null,
    inputCount: Array.isArray(upstreamPayload.input) ? upstreamPayload.input.length : 0,
    body: upstreamPayload,
  });
  const baseHeaders = {
    authorization: `Bearer ${runtime.upstream.apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const responsesUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'responses');
  const responsesBody = JSON.stringify(upstreamPayload);
  const upstreamResponse = await requestJson(responsesUrl, {
    method: 'POST',
    headers: baseHeaders,
  }, responsesBody);
  appendDebugLog({
    phase: 'upstream_response',
    endpoint: 'responses',
    statusCode: upstreamResponse.statusCode,
    body: upstreamResponse.json || upstreamResponse.text || null,
  });
  if (upstreamResponse.statusCode >= 200 && upstreamResponse.statusCode < 300 && upstreamResponse.json) {
    return { ok: true, responseJson: upstreamResponse.json };
  }
  return { ok: false, upstreamResponse };
}

async function requestOpenAiCompatibleResponse(payload, runtime) {
  const upstreamPayload = {
    ...(payload || {}),
    stream: false,
  };
  if (configuredOpenAiEndpoint(runtime) === 'chat/completions') {
    const chatResult = await requestOpenAiCompatibleChatFallback(upstreamPayload, runtime, {
      endpointLabel: 'chat_completions_primary',
    });
    if (chatResult.ok || !shouldFallbackToResponses(chatResult.upstreamResponse, chatResult.chatPayload)) {
      return chatResult;
    }
    return requestOpenAiCompatibleResponsesOnly(upstreamPayload, runtime);
  }

  const responseResult = await requestOpenAiCompatibleResponsesOnly(upstreamPayload, runtime);
  if (responseResult.ok || !shouldFallbackToChatCompletions(responseResult.upstreamResponse, upstreamPayload)) {
    return responseResult;
  }

  return requestOpenAiCompatibleChatFallback(upstreamPayload, runtime);
}

async function requestOpenAiCompatibleChatFallback(upstreamPayload, runtime, options = {}) {
  const chatPayload = translateResponsesRequestToChatCompletions(upstreamPayload, runtime);
  const baseHeaders = {
    authorization: `Bearer ${runtime.upstream.apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const chatUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'chat/completions');
  const endpointLabel = String(options.endpointLabel || 'chat_completions_fallback');
  appendDebugLog({
    phase: 'upstream_request',
    endpoint: endpointLabel,
    upstreamKind: upstreamKind(runtime),
    model: chatPayload.model || '',
    toolCount: Array.isArray(chatPayload.tools) ? chatPayload.tools.length : 0,
    toolChoice: chatPayload.tool_choice ?? null,
    messageCount: Array.isArray(chatPayload.messages) ? chatPayload.messages.length : 0,
    body: chatPayload,
  });
  const chatResponse = await requestJson(chatUrl, {
    method: 'POST',
    headers: baseHeaders,
  }, JSON.stringify(chatPayload));
  appendDebugLog({
    phase: 'upstream_response',
    endpoint: endpointLabel,
    statusCode: chatResponse.statusCode,
    body: chatResponse.json || chatResponse.text || null,
  });
  if (chatResponse.statusCode >= 200 && chatResponse.statusCode < 300 && chatResponse.json) {
    return {
      ok: true,
      responseJson: chatCompletionsToOpenAiResponse(chatResponse.json, chatPayload.model),
      chatPayload,
    };
  }
  return { ok: false, upstreamResponse: chatResponse, chatPayload };
}

async function collectUpstreamStreamResponse(upstreamRes) {
  let text = '';
  upstreamRes.setEncoding('utf8');
  for await (const chunk of upstreamRes) text += chunk;
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {
    statusCode: upstreamRes.statusCode || 502,
    headers: upstreamRes.headers || {},
    text,
    json,
  };
}

function createSsePayloadParser(onPayload, onDone = () => {}) {
  let buffer = '';

  const parseBlock = (block) => {
    const trimmed = String(block || '').trim();
    if (!trimmed) return;
    const dataLines = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const raw = dataLines.length ? dataLines.join('\n').trim() : trimmed;
    if (!raw) return;
    if (raw === '[DONE]') {
      onDone();
      return;
    }
    try {
      onPayload(JSON.parse(raw));
    } catch {
      if (dataLines.length) throw new Error('Upstream returned malformed SSE JSON');
    }
  };

  const drain = (flush = false) => {
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      parseBlock(block);
    }
    if (flush && buffer.trim()) {
      const remaining = buffer;
      buffer = '';
      parseBlock(remaining);
    }
  };

  return {
    push(chunk) {
      buffer += String(chunk || '');
      drain(false);
    },
    end() {
      drain(true);
    },
  };
}

function chatDeltaText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text' || part?.type === 'output_text') return part.text || '';
    return '';
  }).join('');
}

function chatDeltaReasoning(delta) {
  for (const value of [delta?.reasoning_content, delta?.reasoning, delta?.thinking]) {
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      const text = value.text || value.content || value.thinking || '';
      if (typeof text === 'string' && text) return text;
    }
  }
  return '';
}

async function streamChatCompletionsAsOpenAiResponses(upstreamResult, downstreamReq, res, initialModel) {
  let model = String(initialModel || '');
  const responseId = uniqueId('resp');
  const output = [];
  const toolSlots = new Map();
  let reasoningSlot = null;
  let textSlot = null;
  let finishReason = '';
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let downstreamClosed = false;
  let finished = false;

  const abortUpstream = () => {
    if (finished) return;
    downstreamClosed = true;
    try { upstreamResult.req.destroy(); } catch {}
    try { upstreamResult.res.destroy(); } catch {}
  };
  downstreamReq.once('aborted', abortUpstream);
  res.once('close', abortUpstream);

  sseStart(res);
  sseEvent(res, 'response.created', {
    type: 'response.created',
    response: {
      id: responseId,
      object: 'response',
      created_at: Math.trunc(Date.now() / 1000),
      status: 'in_progress',
      model,
      output: [],
    },
  });

  const addOutputItem = (item) => {
    const outputIndex = output.length;
    output.push(item);
    sseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item,
    });
    return outputIndex;
  };

  const ensureReasoningSlot = () => {
    if (reasoningSlot) return reasoningSlot;
    const item = {
      id: uniqueId('rs'),
      type: 'reasoning',
      summary: [],
    };
    reasoningSlot = {
      item,
      outputIndex: addOutputItem(item),
      text: '',
    };
    return reasoningSlot;
  };

  const ensureTextSlot = () => {
    if (textSlot) return textSlot;
    const item = {
      id: uniqueId('msg'),
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    };
    textSlot = {
      item,
      outputIndex: addOutputItem(item),
      text: '',
    };
    return textSlot;
  };

  const ensureToolSlot = (toolIndex, toolDelta = {}) => {
    let slot = toolSlots.get(toolIndex);
    if (!slot) {
      slot = {
        upstreamId: '',
        name: '',
        arguments: '',
        item: null,
        outputIndex: -1,
      };
      toolSlots.set(toolIndex, slot);
    }
    if (toolDelta.id) slot.upstreamId = String(toolDelta.id);
    if (toolDelta.function?.name) slot.name += String(toolDelta.function.name);
    if (!slot.item && (slot.name || toolDelta.function?.arguments !== undefined)) {
      const callId = slot.upstreamId || uniqueId('call');
      slot.item = {
        id: uniqueId('fc'),
        type: 'function_call',
        status: 'in_progress',
        call_id: callId,
        name: slot.name || 'tool',
        arguments: '',
      };
      slot.outputIndex = addOutputItem(slot.item);
    }
    return slot;
  };

  const consumePayload = (payload) => {
    if (payload?.error) {
      throw new Error(payload.error.message || payload.error.code || 'Upstream stream error');
    }
    if (payload?.model) model = String(payload.model);
    if (payload?.usage) usage = normalizeChatCompletionUsage(payload.usage);
    for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
      const delta = choice?.delta || choice?.message || {};
      const reasoning = chatDeltaReasoning(delta);
      if (reasoning) {
        const slot = ensureReasoningSlot();
        slot.text += reasoning;
        sseEvent(res, 'response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          output_index: slot.outputIndex,
          summary_index: 0,
          delta: reasoning,
        });
      }

      const content = chatDeltaText(delta.content);
      if (content) {
        const slot = ensureTextSlot();
        slot.text += content;
        sseEvent(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          output_index: slot.outputIndex,
          content_index: 0,
          delta: content,
        });
      }

      for (const toolDelta of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const toolIndex = Number.isInteger(toolDelta?.index) ? toolDelta.index : toolSlots.size;
        const slot = ensureToolSlot(toolIndex, toolDelta);
        const argumentDelta = typeof toolDelta?.function?.arguments === 'string'
          ? toolDelta.function.arguments
          : '';
        if (argumentDelta) {
          slot.arguments += argumentDelta;
          if (!slot.item) ensureToolSlot(toolIndex, { function: { arguments: argumentDelta } });
          sseEvent(res, 'response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            output_index: slot.outputIndex,
            delta: argumentDelta,
          });
        }
      }
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
    }
  };

  const parser = createSsePayloadParser(consumePayload);
  upstreamResult.res.setEncoding('utf8');
  try {
    for await (const chunk of upstreamResult.res) {
      if (downstreamClosed) break;
      parser.push(chunk);
    }
    if (downstreamClosed) return;
    parser.end();

    if (reasoningSlot) {
      reasoningSlot.item.summary = [{ type: 'summary_text', text: reasoningSlot.text }];
      sseEvent(res, 'response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        output_index: reasoningSlot.outputIndex,
        summary_index: 0,
        text: reasoningSlot.text,
      });
      sseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: reasoningSlot.outputIndex,
        item: reasoningSlot.item,
      });
    }

    if (textSlot) {
      textSlot.item.status = 'completed';
      textSlot.item.content[0].text = textSlot.text;
      sseEvent(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        output_index: textSlot.outputIndex,
        content_index: 0,
        text: textSlot.text,
      });
      sseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: textSlot.outputIndex,
        item: textSlot.item,
      });
    }

    for (const [toolIndex, existingSlot] of [...toolSlots.entries()].sort((a, b) => a[0] - b[0])) {
      const slot = existingSlot.item ? existingSlot : ensureToolSlot(toolIndex, { function: { arguments: '' } });
      slot.item.status = 'completed';
      slot.item.name = slot.name || slot.item.name || 'tool';
      slot.item.arguments = slot.arguments || '{}';
      sseEvent(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: slot.outputIndex,
        arguments: slot.item.arguments,
      });
      sseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: slot.outputIndex,
        item: slot.item,
      });
    }

    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    const terminalResponse = {
      id: responseId,
      object: 'response',
      created_at: Math.trunc(Date.now() / 1000),
      status,
      model,
      output,
      usage,
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    };
    sseEvent(res, status === 'incomplete' ? 'response.incomplete' : 'response.completed', {
      type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      response: terminalResponse,
    });
    finished = true;
    res.end();
  } catch (error) {
    if (downstreamClosed) return;
    appendDebugLog({
      phase: 'upstream_stream_error',
      endpoint: 'chat_completions_stream',
      message: error.message || String(error),
    });
    sseEvent(res, 'error', {
      type: 'error',
      code: 'bridge_stream_error',
      message: error.message || 'Upstream stream failed',
    });
    finished = true;
    res.end();
  } finally {
    downstreamReq.off('aborted', abortUpstream);
    res.off('close', abortUpstream);
  }
}

async function proxyChatCompletionsAsOpenAiResponses(body, req, res, runtime, options = {}) {
  const chatPayload = translateResponsesRequestToChatCompletions(body, runtime, { stream: true });
  const endpointLabel = String(options.endpointLabel || 'chat_completions_stream');
  appendDebugLog({
    phase: 'upstream_request',
    endpoint: endpointLabel,
    upstreamKind: upstreamKind(runtime),
    model: chatPayload.model || '',
    toolCount: Array.isArray(chatPayload.tools) ? chatPayload.tools.length : 0,
    toolChoice: chatPayload.tool_choice ?? null,
    messageCount: Array.isArray(chatPayload.messages) ? chatPayload.messages.length : 0,
    body: chatPayload,
  });
  const chatUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'chat/completions');
  const upstreamResult = await requestStream(chatUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.upstream.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
  }, JSON.stringify(chatPayload));

  if (upstreamResult.res.statusCode < 200 || upstreamResult.res.statusCode >= 300) {
    const upstreamResponse = await collectUpstreamStreamResponse(upstreamResult.res);
    appendDebugLog({
      phase: 'upstream_response',
      endpoint: endpointLabel,
      statusCode: upstreamResponse.statusCode,
      body: upstreamResponse.json || upstreamResponse.text || null,
    });
    return { ok: false, upstreamResponse, chatPayload };
  }

  await streamChatCompletionsAsOpenAiResponses(upstreamResult, req, res, chatPayload.model);
  return { ok: true, streamed: true, chatPayload };
}

async function streamChatCompletionsAsAnthropicMessages(upstreamResult, downstreamReq, res, initialModel) {
  let model = String(initialModel || '');
  const messageId = uniqueId('msg');
  const toolSlots = new Map();
  let reasoningSlot = null;
  let textSlot = null;
  let nextBlockIndex = 0;
  let finishReason = '';
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let downstreamClosed = false;
  let finished = false;

  const abortUpstream = () => {
    if (finished) return;
    downstreamClosed = true;
    try { upstreamResult.req.destroy(); } catch {}
    try { upstreamResult.res.destroy(); } catch {}
  };
  downstreamReq.once('aborted', abortUpstream);
  res.once('close', abortUpstream);

  sseStart(res);
  sseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const ensureReasoningSlot = () => {
    if (reasoningSlot) return reasoningSlot;
    reasoningSlot = { index: nextBlockIndex++, text: '' };
    sseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: reasoningSlot.index,
      content_block: { type: 'thinking', thinking: '' },
    });
    return reasoningSlot;
  };

  const ensureTextSlot = () => {
    if (textSlot) return textSlot;
    textSlot = { index: nextBlockIndex++, text: '' };
    sseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: textSlot.index,
      content_block: { type: 'text', text: '' },
    });
    return textSlot;
  };

  const ensureToolSlot = (toolIndex, toolDelta = {}) => {
    let slot = toolSlots.get(toolIndex);
    if (!slot) {
      slot = {
        index: -1,
        upstreamId: '',
        name: '',
        arguments: '',
        started: false,
      };
      toolSlots.set(toolIndex, slot);
    }
    if (toolDelta.id) slot.upstreamId = String(toolDelta.id);
    if (toolDelta.function?.name) slot.name += String(toolDelta.function.name);
    if (!slot.started && (slot.name || toolDelta.function?.arguments !== undefined)) {
      slot.started = true;
      slot.index = nextBlockIndex++;
      sseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: slot.index,
        content_block: {
          type: 'tool_use',
          id: slot.upstreamId || uniqueId('toolu'),
          name: slot.name || 'tool',
          input: {},
        },
      });
    }
    return slot;
  };

  const consumePayload = (payload) => {
    if (payload?.error) {
      throw new Error(payload.error.message || payload.error.code || 'Upstream stream error');
    }
    if (payload?.model) model = String(payload.model);
    if (payload?.usage) usage = normalizeChatCompletionUsage(payload.usage);
    for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
      const delta = choice?.delta || choice?.message || {};
      const reasoning = chatDeltaReasoning(delta);
      if (reasoning) {
        const slot = ensureReasoningSlot();
        slot.text += reasoning;
        sseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: slot.index,
          delta: { type: 'thinking_delta', thinking: reasoning },
        });
      }

      const content = chatDeltaText(delta.content);
      if (content) {
        const slot = ensureTextSlot();
        slot.text += content;
        sseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: slot.index,
          delta: { type: 'text_delta', text: content },
        });
      }

      for (const toolDelta of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const toolIndex = Number.isInteger(toolDelta?.index) ? toolDelta.index : toolSlots.size;
        const slot = ensureToolSlot(toolIndex, toolDelta);
        const argumentDelta = typeof toolDelta?.function?.arguments === 'string'
          ? toolDelta.function.arguments
          : '';
        if (argumentDelta) {
          slot.arguments += argumentDelta;
          if (!slot.started) ensureToolSlot(toolIndex, { function: { arguments: argumentDelta } });
          sseEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: slot.index,
            delta: { type: 'input_json_delta', partial_json: argumentDelta },
          });
        }
      }
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
    }
  };

  const parser = createSsePayloadParser(consumePayload);
  upstreamResult.res.setEncoding('utf8');
  try {
    for await (const chunk of upstreamResult.res) {
      if (downstreamClosed) break;
      parser.push(chunk);
    }
    if (downstreamClosed) return;
    parser.end();

    if (reasoningSlot) {
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: reasoningSlot.index });
    }
    if (textSlot) {
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: textSlot.index });
    }
    for (const [toolIndex, existingSlot] of [...toolSlots.entries()].sort((a, b) => a[0] - b[0])) {
      const slot = existingSlot.started
        ? existingSlot
        : ensureToolSlot(toolIndex, { function: { arguments: '' } });
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: slot.index });
    }

    const stopReason = toolSlots.size
      ? 'tool_use'
      : (finishReason === 'length' ? 'max_tokens' : 'end_turn');
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
    finished = true;
    res.end();
  } catch (error) {
    if (downstreamClosed) return;
    appendDebugLog({
      phase: 'upstream_stream_error',
      endpoint: 'chat_completions_anthropic_stream',
      message: error.message || String(error),
    });
    sseEvent(res, 'error', {
      type: 'error',
      error: {
        type: 'api_error',
        message: error.message || 'Upstream stream failed',
      },
    });
    finished = true;
    res.end();
  } finally {
    downstreamReq.off('aborted', abortUpstream);
    res.off('close', abortUpstream);
  }
}

async function proxyChatCompletionsAsAnthropicMessages(body, req, res, runtime) {
  const responsesPayload = translateAnthropicRequest(body || {}, runtime);
  const chatPayload = translateResponsesRequestToChatCompletions(responsesPayload, runtime, { stream: true });
  appendDebugLog({
    phase: 'upstream_request',
    endpoint: 'chat_completions_anthropic_stream',
    upstreamKind: upstreamKind(runtime),
    model: chatPayload.model || '',
    toolCount: Array.isArray(chatPayload.tools) ? chatPayload.tools.length : 0,
    toolChoice: chatPayload.tool_choice ?? null,
    messageCount: Array.isArray(chatPayload.messages) ? chatPayload.messages.length : 0,
    body: chatPayload,
  });
  const chatUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'chat/completions');
  const upstreamResult = await requestStream(chatUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.upstream.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
  }, JSON.stringify(chatPayload));

  if (upstreamResult.res.statusCode < 200 || upstreamResult.res.statusCode >= 300) {
    const upstreamResponse = await collectUpstreamStreamResponse(upstreamResult.res);
    appendDebugLog({
      phase: 'upstream_response',
      endpoint: 'chat_completions_anthropic_stream',
      statusCode: upstreamResponse.statusCode,
      body: upstreamResponse.json || upstreamResponse.text || null,
    });
    return { ok: false, upstreamResponse, chatPayload, responsesPayload };
  }

  await streamChatCompletionsAsAnthropicMessages(upstreamResult, req, res, chatPayload.model);
  return { ok: true, streamed: true, chatPayload, responsesPayload };
}

async function streamOpenAiResponsesAsAnthropicMessages(upstreamResult, downstreamReq, res, initialModel) {
  let model = String(initialModel || '');
  const messageId = uniqueId('msg');
  const slots = new Map();
  let nextBlockIndex = 0;
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let terminalStatus = '';
  let downstreamClosed = false;
  let finished = false;

  const abortUpstream = () => {
    if (finished) return;
    downstreamClosed = true;
    try { upstreamResult.req.destroy(); } catch {}
    try { upstreamResult.res.destroy(); } catch {}
  };
  downstreamReq.once('aborted', abortUpstream);
  res.once('close', abortUpstream);

  sseStart(res);
  sseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const startSlot = (outputIndex, item = {}) => {
    if (slots.has(outputIndex)) return slots.get(outputIndex);
    let kind = '';
    let contentBlock = null;
    if (item.type === 'reasoning') {
      kind = 'thinking';
      contentBlock = { type: 'thinking', thinking: '' };
    } else if (item.type === 'function_call') {
      kind = 'tool_use';
      contentBlock = {
        type: 'tool_use',
        id: item.call_id || item.id || uniqueId('toolu'),
        name: item.name || 'tool',
        input: {},
      };
    } else {
      kind = 'text';
      contentBlock = { type: 'text', text: '' };
    }
    const slot = {
      kind,
      blockIndex: nextBlockIndex++,
      text: '',
      arguments: '',
      stopped: false,
    };
    slots.set(outputIndex, slot);
    sseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: slot.blockIndex,
      content_block: contentBlock,
    });
    return slot;
  };

  const emitTextDelta = (slot, text) => {
    if (!text) return;
    slot.text += text;
    sseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: slot.blockIndex,
      delta: slot.kind === 'thinking'
        ? { type: 'thinking_delta', thinking: text }
        : { type: 'text_delta', text },
    });
  };

  const stopSlot = (outputIndex, item = null) => {
    const slot = slots.get(outputIndex) || startSlot(outputIndex, item || {});
    if (slot.stopped) return;
    if (item && slot.kind === 'thinking' && !slot.text) {
      const text = Array.isArray(item.summary)
        ? item.summary.map((part) => part?.text || '').filter(Boolean).join('\n\n')
        : '';
      emitTextDelta(slot, text);
    } else if (item && slot.kind === 'text' && !slot.text) {
      const text = Array.isArray(item.content)
        ? item.content.map((part) => part?.text || part?.refusal || '').join('')
        : '';
      emitTextDelta(slot, text);
    } else if (item && slot.kind === 'tool_use' && !slot.arguments && item.arguments) {
      const args = normalizeToolArguments(item.arguments);
      slot.arguments = args;
      sseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: slot.blockIndex,
        delta: { type: 'input_json_delta', partial_json: args },
      });
    }
    slot.stopped = true;
    sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: slot.blockIndex });
  };

  const consumePayload = (payload) => {
    if (payload?.type === 'error' || payload?.error) {
      throw new Error(payload?.error?.message || payload?.message || 'Upstream Responses stream error');
    }
    if (Array.isArray(payload?.output)) {
      if (payload.model) model = String(payload.model);
      if (payload.usage) usage = payload.usage;
      terminalStatus = String(payload.status || 'completed');
      payload.output.forEach((item, outputIndex) => {
        startSlot(outputIndex, item || {});
        stopSlot(outputIndex, item || {});
      });
      return;
    }
    if (payload?.response?.model) model = String(payload.response.model);
    if (payload?.response?.usage) usage = payload.response.usage;
    if (payload?.type === 'response.output_item.added') {
      startSlot(Number(payload.output_index || 0), payload.item || {});
      return;
    }
    if (payload?.type === 'response.reasoning_summary_text.delta' || payload?.type === 'response.reasoning_text.delta') {
      const slot = slots.get(Number(payload.output_index || 0))
        || startSlot(Number(payload.output_index || 0), { type: 'reasoning' });
      emitTextDelta(slot, String(payload.delta || ''));
      return;
    }
    if (payload?.type === 'response.output_text.delta' || payload?.type === 'response.refusal.delta') {
      const slot = slots.get(Number(payload.output_index || 0))
        || startSlot(Number(payload.output_index || 0), { type: 'message' });
      emitTextDelta(slot, String(payload.delta || ''));
      return;
    }
    if (payload?.type === 'response.function_call_arguments.delta') {
      const outputIndex = Number(payload.output_index || 0);
      const slot = slots.get(outputIndex) || startSlot(outputIndex, { type: 'function_call' });
      const delta = String(payload.delta || '');
      slot.arguments += delta;
      if (delta) {
        sseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: slot.blockIndex,
          delta: { type: 'input_json_delta', partial_json: delta },
        });
      }
      return;
    }
    if (payload?.type === 'response.output_item.done') {
      stopSlot(Number(payload.output_index || 0), payload.item || {});
      return;
    }
    if (payload?.type === 'response.completed' || payload?.type === 'response.incomplete') {
      terminalStatus = String(payload.response?.status || (payload.type === 'response.incomplete' ? 'incomplete' : 'completed'));
      if (payload.response?.usage) usage = payload.response.usage;
      return;
    }
    if (payload?.type === 'response.failed') {
      throw new Error(payload.response?.error?.message || 'Upstream Responses request failed');
    }
  };

  const parser = createSsePayloadParser(consumePayload);
  upstreamResult.res.setEncoding('utf8');
  try {
    for await (const chunk of upstreamResult.res) {
      if (downstreamClosed) break;
      parser.push(chunk);
    }
    if (downstreamClosed) return;
    parser.end();
    for (const outputIndex of slots.keys()) stopSlot(outputIndex);

    const hasToolUse = [...slots.values()].some((slot) => slot.kind === 'tool_use');
    sseEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: hasToolUse
          ? 'tool_use'
          : (terminalStatus === 'incomplete' ? 'max_tokens' : 'end_turn'),
        stop_sequence: null,
      },
      usage: { output_tokens: usage.output_tokens || 0 },
    });
    sseEvent(res, 'message_stop', { type: 'message_stop' });
    finished = true;
    res.end();
  } catch (error) {
    if (downstreamClosed) return;
    sseEvent(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: error.message || 'Upstream Responses stream failed' },
    });
    finished = true;
    res.end();
  } finally {
    downstreamReq.off('aborted', abortUpstream);
    res.off('close', abortUpstream);
  }
}

async function proxyOpenAiResponsesAsAnthropicMessages(upstreamPayload, req, res, runtime) {
  const payload = {
    ...(upstreamPayload || {}),
    model: resolveRequestModel(runtime, upstreamPayload),
    stream: true,
  };
  const responsesUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'responses');
  const upstreamResult = await requestStream(responsesUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.upstream.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
  }, JSON.stringify(payload));
  if (upstreamResult.res.statusCode < 200 || upstreamResult.res.statusCode >= 300) {
    const upstreamResponse = await collectUpstreamStreamResponse(upstreamResult.res);
    return { ok: false, upstreamResponse, upstreamPayload: payload };
  }
  await streamOpenAiResponsesAsAnthropicMessages(upstreamResult, req, res, payload.model);
  return { ok: true, streamed: true, upstreamPayload: payload };
}

async function streamAnthropicMessagesAsOpenAiResponses(upstreamResult, downstreamReq, res, initialModel) {
  let model = String(initialModel || '');
  const responseId = uniqueId('resp');
  const output = [];
  const slots = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = '';
  let downstreamClosed = false;
  let finished = false;

  const abortUpstream = () => {
    if (finished) return;
    downstreamClosed = true;
    try { upstreamResult.req.destroy(); } catch {}
    try { upstreamResult.res.destroy(); } catch {}
  };
  downstreamReq.once('aborted', abortUpstream);
  res.once('close', abortUpstream);

  sseStart(res);
  sseEvent(res, 'response.created', {
    type: 'response.created',
    response: {
      id: responseId,
      object: 'response',
      created_at: Math.trunc(Date.now() / 1000),
      status: 'in_progress',
      model,
      output: [],
    },
  });

  const startSlot = (anthropicIndex, block = {}) => {
    if (slots.has(anthropicIndex)) return slots.get(anthropicIndex);
    let item;
    let kind;
    if (block.type === 'thinking') {
      kind = 'thinking';
      item = { id: uniqueId('rs'), type: 'reasoning', summary: [] };
    } else if (block.type === 'tool_use') {
      kind = 'tool_use';
      item = {
        id: uniqueId('fc'),
        type: 'function_call',
        status: 'in_progress',
        call_id: block.id || uniqueId('call'),
        name: block.name || 'tool',
        arguments: '',
      };
    } else {
      kind = 'text';
      item = {
        id: uniqueId('msg'),
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      };
    }
    const outputIndex = output.length;
    output.push(item);
    const slot = {
      kind,
      outputIndex,
      item,
      text: '',
      arguments: '',
      stopped: false,
    };
    slots.set(anthropicIndex, slot);
    sseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item,
    });
    const initialText = kind === 'thinking'
      ? String(block.thinking || '')
      : (kind === 'text' ? String(block.text || '') : '');
    if (initialText) {
      slot.text = initialText;
      sseEvent(res, kind === 'thinking' ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta', {
        type: kind === 'thinking' ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta',
        output_index: outputIndex,
        ...(kind === 'thinking' ? { summary_index: 0 } : { content_index: 0 }),
        delta: initialText,
      });
    }
    if (kind === 'tool_use' && block.input && Object.keys(block.input).length) {
      slot.arguments = normalizeToolArguments(block.input);
      sseEvent(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: outputIndex,
        delta: slot.arguments,
      });
    }
    return slot;
  };

  const stopSlot = (anthropicIndex) => {
    const slot = slots.get(anthropicIndex);
    if (!slot || slot.stopped) return;
    slot.stopped = true;
    if (slot.kind === 'thinking') {
      slot.item.summary = [{ type: 'summary_text', text: slot.text }];
      sseEvent(res, 'response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        output_index: slot.outputIndex,
        summary_index: 0,
        text: slot.text,
      });
    } else if (slot.kind === 'text') {
      slot.item.status = 'completed';
      slot.item.content[0].text = slot.text;
      sseEvent(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        output_index: slot.outputIndex,
        content_index: 0,
        text: slot.text,
      });
    } else {
      slot.item.status = 'completed';
      slot.item.arguments = slot.arguments || '{}';
      sseEvent(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: slot.outputIndex,
        arguments: slot.item.arguments,
      });
    }
    sseEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: slot.outputIndex,
      item: slot.item,
    });
  };

  const consumePayload = (payload) => {
    if (payload?.type === 'error') {
      throw new Error(payload.error?.message || 'Upstream Anthropic stream error');
    }
    if (payload?.type === 'message' && Array.isArray(payload.content)) {
      if (payload.model) model = String(payload.model);
      inputTokens = Number(payload.usage?.input_tokens || 0);
      outputTokens = Number(payload.usage?.output_tokens || 0);
      stopReason = String(payload.stop_reason || 'end_turn');
      payload.content.forEach((block, index) => {
        startSlot(index, block || {});
        stopSlot(index);
      });
      return;
    }
    if (payload?.type === 'message_start') {
      if (payload.message?.model) model = String(payload.message.model);
      inputTokens = Number(payload.message?.usage?.input_tokens || inputTokens || 0);
      return;
    }
    if (payload?.type === 'content_block_start') {
      startSlot(Number(payload.index || 0), payload.content_block || {});
      return;
    }
    if (payload?.type === 'content_block_delta') {
      const anthropicIndex = Number(payload.index || 0);
      const delta = payload.delta || {};
      const expectedBlock = delta.type === 'thinking_delta'
        ? { type: 'thinking' }
        : (delta.type === 'input_json_delta' ? { type: 'tool_use' } : { type: 'text' });
      const slot = slots.get(anthropicIndex) || startSlot(anthropicIndex, expectedBlock);
      if (delta.type === 'thinking_delta') {
        const text = String(delta.thinking || '');
        slot.text += text;
        if (text) {
          sseEvent(res, 'response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            output_index: slot.outputIndex,
            summary_index: 0,
            delta: text,
          });
        }
      } else if (delta.type === 'input_json_delta') {
        const args = String(delta.partial_json || '');
        slot.arguments += args;
        if (args) {
          sseEvent(res, 'response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            output_index: slot.outputIndex,
            delta: args,
          });
        }
      } else if (delta.type === 'text_delta' || delta.type === 'text') {
        const text = String(delta.text || '');
        slot.text += text;
        if (text) {
          sseEvent(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            output_index: slot.outputIndex,
            content_index: 0,
            delta: text,
          });
        }
      }
      return;
    }
    if (payload?.type === 'content_block_stop') {
      stopSlot(Number(payload.index || 0));
      return;
    }
    if (payload?.type === 'message_delta') {
      stopReason = String(payload.delta?.stop_reason || stopReason || '');
      outputTokens = Number(payload.usage?.output_tokens || outputTokens || 0);
    }
  };

  const parser = createSsePayloadParser(consumePayload);
  upstreamResult.res.setEncoding('utf8');
  try {
    for await (const chunk of upstreamResult.res) {
      if (downstreamClosed) break;
      parser.push(chunk);
    }
    if (downstreamClosed) return;
    parser.end();
    for (const anthropicIndex of slots.keys()) stopSlot(anthropicIndex);

    const status = stopReason === 'max_tokens' ? 'incomplete' : 'completed';
    const terminalResponse = {
      id: responseId,
      object: 'response',
      created_at: Math.trunc(Date.now() / 1000),
      status,
      model,
      output,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    };
    sseEvent(res, status === 'incomplete' ? 'response.incomplete' : 'response.completed', {
      type: status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      response: terminalResponse,
    });
    finished = true;
    res.end();
  } catch (error) {
    if (downstreamClosed) return;
    sseEvent(res, 'error', {
      type: 'error',
      code: 'bridge_stream_error',
      message: error.message || 'Upstream Anthropic stream failed',
    });
    finished = true;
    res.end();
  } finally {
    downstreamReq.off('aborted', abortUpstream);
    res.off('close', abortUpstream);
  }
}

async function proxyAnthropicMessagesAsOpenAiResponses(body, req, res, runtime) {
  const upstreamPayload = {
    ...translateOpenAiRequestToAnthropic(body || {}, runtime),
    stream: true,
  };
  const upstreamUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'messages');
  const upstreamResult = await requestStream(upstreamUrl, {
    method: 'POST',
    headers: buildAnthropicHeaders(runtime, {
      anthropicVersion: '2023-06-01',
      contentType: 'application/json',
      accept: 'text/event-stream',
      incomingHeaders: req.headers,
    }),
  }, JSON.stringify(upstreamPayload));
  if (upstreamResult.res.statusCode < 200 || upstreamResult.res.statusCode >= 300) {
    const upstreamResponse = await collectUpstreamStreamResponse(upstreamResult.res);
    return { ok: false, upstreamResponse, upstreamPayload };
  }
  await streamAnthropicMessagesAsOpenAiResponses(upstreamResult, req, res, upstreamPayload.model);
  return { ok: true, streamed: true, upstreamPayload };
}

async function proxyOpenAiCompatibleResponseStream(body, req, res, runtime) {
  const upstreamPayload = {
    ...(body || {}),
    model: resolveRequestModel(runtime, body),
    stream: true,
  };
  appendDebugLog({
    phase: 'upstream_request',
    endpoint: 'responses_stream',
    upstreamKind: upstreamKind(runtime),
    model: upstreamPayload.model || '',
    toolCount: Array.isArray(upstreamPayload.tools) ? upstreamPayload.tools.length : 0,
    toolChoice: upstreamPayload.tool_choice ?? null,
    inputCount: Array.isArray(upstreamPayload.input) ? upstreamPayload.input.length : 0,
    body: upstreamPayload,
  });
  const baseHeaders = {
    authorization: `Bearer ${runtime.upstream.apiKey}`,
    'content-type': 'application/json',
    accept: req.headers.accept || 'text/event-stream',
  };
  const responsesUrl = buildUpstreamUrl(runtime.upstream.apiBase, 'responses');
  const upstreamResult = await requestStream(responsesUrl, {
    method: 'POST',
    headers: baseHeaders,
  }, JSON.stringify(upstreamPayload));

  if (upstreamResult.res.statusCode >= 200 && upstreamResult.res.statusCode < 300) {
    res.writeHead(upstreamResult.res.statusCode || 200, proxyResponseHeaders(upstreamResult.res.headers || {
      'content-type': 'text/event-stream',
    }));
    upstreamResult.res.pipe(res);
    await new Promise((resolve, reject) => {
      upstreamResult.res.on('end', resolve);
      upstreamResult.res.on('error', reject);
      res.on('close', resolve);
    });
    return { ok: true };
  }

  let text = '';
  await new Promise((resolve, reject) => {
    upstreamResult.res.setEncoding('utf8');
    upstreamResult.res.on('data', (chunk) => { text += chunk; });
    upstreamResult.res.on('end', resolve);
    upstreamResult.res.on('error', reject);
  });
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  const upstreamResponse = {
    statusCode: upstreamResult.res.statusCode || 502,
    headers: upstreamResult.res.headers || {},
    text,
    json,
  };
  appendDebugLog({
    phase: 'upstream_response',
    endpoint: 'responses_stream',
    statusCode: upstreamResponse.statusCode,
    body: upstreamResponse.json || upstreamResponse.text || null,
  });
  return { ok: false, upstreamResponse };
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
  let result;
  try {
    const wantsStream = body?.stream === true || String(req.headers.accept || '').includes('text/event-stream');
    const configuredEndpoint = configuredOpenAiEndpoint(runtime);
    if (wantsStream && configuredEndpoint === 'chat/completions') {
      result = await proxyChatCompletionsAsAnthropicMessages(body || {}, req, res, runtime);
      if (result?.ok) return;
      if (shouldFallbackToResponses(result?.upstreamResponse, result?.chatPayload)) {
        result = await proxyOpenAiResponsesAsAnthropicMessages(upstreamPayload, req, res, runtime);
        if (result?.ok) return;
      }
    } else if (wantsStream) {
      result = await proxyOpenAiResponsesAsAnthropicMessages(upstreamPayload, req, res, runtime);
      if (result?.ok) return;
      if (shouldFallbackToChatCompletions(result?.upstreamResponse, result?.upstreamPayload || upstreamPayload)) {
        result = await proxyChatCompletionsAsAnthropicMessages(body || {}, req, res, runtime);
        if (result?.ok) return;
      }
    } else {
      result = await requestOpenAiCompatibleResponse(upstreamPayload, runtime);
    }
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

  if (!result?.ok || !result.responseJson) {
    const upstreamResponse = result?.upstreamResponse || null;
    jsonResponse(res, upstreamResponse?.statusCode || 502, {
      type: 'error',
      error: {
        type: 'api_error',
        message: upstreamResponse?.text || 'Upstream returned an invalid response',
      },
    });
    return;
  }

  sendAnthropicResponse(res, result.responseJson, upstreamPayload.model);
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
    const wantsStream = body?.stream === true || String(req.headers.accept || '').includes('text/event-stream');
    if (wantsStream) {
      let streamResult;
      try {
        streamResult = await proxyAnthropicMessagesAsOpenAiResponses(body || {}, req, res, runtime);
      } catch (error) {
        jsonResponse(res, 502, { error: { message: `Upstream request failed: ${error.message}` } });
        return;
      }
      if (streamResult?.ok) return;
      const upstreamResponse = streamResult?.upstreamResponse || null;
      jsonResponse(res, upstreamResponse?.statusCode || 502, {
        error: { message: upstreamResponse?.text || 'Upstream returned an invalid response' },
      });
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
  let body = null;
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {
    jsonResponse(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }
  let result;
  try {
    appendDebugLog({
      phase: 'bridge_request',
      endpoint: 'openai_responses',
      body,
    });
    const wantsStream = body?.stream === true || String(req.headers.accept || '').includes('text/event-stream');
    const prefersChatCompletions = configuredOpenAiEndpoint(runtime) === 'chat/completions';
    if (wantsStream && prefersChatCompletions) {
      result = await proxyChatCompletionsAsOpenAiResponses(body || {}, req, res, runtime, {
        endpointLabel: 'chat_completions_stream_primary',
      });
      if (result?.ok) return;
      if (shouldFallbackToResponses(result?.upstreamResponse, result?.chatPayload)) {
        result = await proxyOpenAiCompatibleResponseStream(body || {}, req, res, runtime);
        if (result?.ok) return;
      }
    } else if (wantsStream) {
      result = await proxyOpenAiCompatibleResponseStream(body || {}, req, res, runtime);
      if (result?.ok) return;
      if (shouldFallbackToChatCompletions(result?.upstreamResponse, body || {})) {
        result = await proxyChatCompletionsAsOpenAiResponses(body || {}, req, res, runtime, {
          endpointLabel: 'chat_completions_stream_fallback',
        });
        if (result?.ok) return;
      }
    } else {
      result = await requestOpenAiCompatibleResponse(body || {}, runtime);
    }
  } catch (error) {
    jsonResponse(res, 502, { error: { message: `Upstream request failed: ${error.message}` } });
    return;
  }

  if (!result?.ok || !result.responseJson) {
    const upstreamResponse = result?.upstreamResponse || null;
    jsonResponse(res, upstreamResponse?.statusCode || 502, {
      error: {
        message: upstreamResponse?.text || 'Upstream returned an invalid response',
      },
    });
    return;
  }

  const wantsStream = body?.stream === true || String(req.headers.accept || '').includes('text/event-stream');
  if (wantsStream) {
    sendOpenAiSseFromBlocks(
      res,
      collectOpenAiBlocks(result.responseJson),
      result.responseJson.model || body?.model || runtime.upstream.defaultModel || '',
      result.responseJson.usage || {},
    );
    return;
  }

  jsonResponse(res, 200, result.responseJson);
}

function cleanupState() {
  try { fs.unlinkSync(statePath); } catch {}
}
process.on('exit', cleanupState);
process.on('SIGINT', () => { cleanupState(); process.exit(0); });
process.on('SIGTERM', () => { cleanupState(); process.exit(0); });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      jsonResponse(res, 200, { ok: true });
      return;
    }

    const requestToken = extractToken(req);
    const runtime = loadRuntime(requestToken);
    if (!runtime) {
      const hasAnyRuntime = !!loadRuntime();
      jsonResponse(res, hasAnyRuntime ? 401 : 503, {
        error: {
          message: hasAnyRuntime ? 'Invalid bridge token' : 'Bridge runtime is not configured',
        },
      });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/openai/v1/models')) {
      if (!ensureAuthorized(req, res, runtime, requestToken)) return;
      await proxyOpenAiModels(res, runtime);
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/anthropic/v1/models')) {
      if (!ensureAuthorized(req, res, runtime, requestToken)) return;
      await proxyOpenAiModels(res, runtime);
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/openai/responses')) {
      if (!ensureAuthorized(req, res, runtime, requestToken)) return;
      await proxyOpenAiResponse(req, res, runtime);
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/anthropic/v1/messages')) {
      if (!ensureAuthorized(req, res, runtime, requestToken)) return;
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
