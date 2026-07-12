#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !String(args[idx + 1]).startsWith('-')) {
    return args[idx + 1];
  }
  return null;
}

(async function main() {
  const args = process.argv.slice(2);
  const sessionDir = getArgValue(args, '--session-dir');
  const sessionId = getArgValue(args, '--session-id') || crypto.randomUUID();
  const model = getArgValue(args, '--model') || 'mock-pi-model';
  const input = (await readStdin()).trim();
  const imageCount = args.filter((arg) => String(arg).startsWith('@')).length;
  const toolsIdx = args.indexOf('--tools');
  const tools = toolsIdx >= 0 ? String(args[toolsIdx + 1] || '') : '';

  // Persist a tiny resume state so multi-turn can be verified.
  let state = { turns: 0, lastInput: '' };
  const statePath = sessionDir
    ? path.join(sessionDir, `${sessionId}.mock-state.json`)
    : null;
  if (statePath) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {}
  }
  state.turns = (state.turns || 0) + 1;
  state.lastInput = input;
  if (statePath) {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state));
    } catch {}
  }

  emit({
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  });
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({
    type: 'message_start',
    message: {
      role: 'user',
      content: [{ type: 'text', text: input }],
      timestamp: Date.now(),
    },
  });
  emit({
    type: 'message_end',
    message: {
      role: 'user',
      content: [{ type: 'text', text: input }],
      timestamp: Date.now(),
    },
  });

  if (input === 'trigger pi silent exit') {
    emit({
      type: 'message_start',
      message: { role: 'assistant', content: [], stopReason: 'stop', timestamp: Date.now() },
    });
    const partial = 'Pi mock partial before silent exit.';
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: partial },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: partial }],
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    });
    process.exit(1);
  }

  if (input === 'trigger pi auth error') {
    process.stderr.write('authentication failed: missing api key\n');
    process.exit(1);
  }

  if (input === 'trigger pi json error') {
    emit({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() });
    emit({ type: 'agent_start' });
    emit({ type: 'turn_start' });
    emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        model,
        stopReason: 'error',
        errorMessage: 'Pi mock structured failure (stopReason=error)',
        usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
        timestamp: Date.now(),
      },
    });
    emit({ type: 'agent_end', messages: [], willRetry: false });
    process.exit(0);
  }

  let text = '';
  if (input === '/compact') {
    text = 'Pi mock compact finished.';
  } else if (imageCount > 0) {
    text = `Pi mock handled ${imageCount} image attachment(s): ${input || '[no text]'}`;
  } else if (tools) {
    text = `Pi mock handled (tools=${tools}): ${input}`;
  } else {
    text = `Pi mock handled (turn ${state.turns}, model=${model}): ${input}`;
  }

  // Optional tool call path for tool event coverage
  if (/run bash/i.test(input)) {
    const toolId = 'call_mock_bash_1';
    emit({
      type: 'tool_execution_start',
      toolCallId: toolId,
      toolName: 'bash',
      args: { command: 'echo mock-pi' },
    });
    emit({
      type: 'tool_execution_end',
      toolCallId: toolId,
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'mock-pi\n' }] },
      isError: false,
    });
  }

  emit({
    type: 'message_start',
    message: {
      role: 'assistant',
      content: [],
      api: 'mock',
      provider: 'mock',
      model,
      usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  });

  // Stream text as deltas
  const chunks = text.match(/.{1,24}/g) || [text];
  let built = '';
  for (const chunk of chunks) {
    built += chunk;
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: built }],
        api: 'mock',
        provider: 'mock',
        model,
        usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    });
  }

  const usage = {
    input: 120,
    output: Math.max(8, text.length),
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120 + Math.max(8, text.length),
    cost: { input: 0.0001, output: 0.0002, total: 0.0003 },
  };

  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'mock',
      provider: 'mock',
      model,
      usage,
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  });
  emit({
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage,
      stopReason: 'stop',
      timestamp: Date.now(),
    },
    toolResults: [],
  });
  emit({
    type: 'agent_end',
    messages: [
      { role: 'user', content: [{ type: 'text', text: input }] },
      { role: 'assistant', content: [{ type: 'text', text }], usage },
    ],
    willRetry: false,
  });
})();
