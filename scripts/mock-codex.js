#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function writeJsonRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function mockThread(id) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'mock',
    createdAt: now,
    updatedAt: now,
    status: { type: 'idle' },
    path: null,
    cwd: process.cwd(),
    cliVersion: 'mock',
    source: { custom: 'mock-codex-app-server' },
    threadSource: 'user',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function mockTurn(id, status = 'running', error = null) {
  return {
    id,
    items: [],
    itemsView: { type: 'complete' },
    status,
    error,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: status === 'running' ? null : Math.floor(Date.now() / 1000),
    durationMs: status === 'running' ? null : 1,
  };
}

function userTextFromAppServerInput(input) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item && item.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
    .trim();
}

function localImageCountFromAppServerInput(input) {
  return (Array.isArray(input) ? input : []).filter((item) => item && (item.type === 'localImage' || item.type === 'image')).length;
}

async function runMockAppServerTurn({ threadId, turnId, input, goals }) {
  const text = userTextFromAppServerInput(input);
  const imageCount = localImageCountFromAppServerInput(input);
  const statePath = path.join(os.tmpdir(), `webcoding-mock-codex-${threadId}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}

  const userItem = { type: 'userMessage', id: `user_${crypto.randomUUID()}`, content: [{ type: 'text', text, text_elements: [] }] };
  writeJsonRpc({ method: 'turn/started', params: { threadId, turn: mockTurn(turnId) } });
  writeJsonRpc({ method: 'item/started', params: { threadId, turnId, item: userItem, startedAtMs: Date.now() } });
  writeJsonRpc({ method: 'item/completed', params: { threadId, turnId, item: userItem, completedAtMs: Date.now() } });

  const completeTurn = (status = 'completed', error = null) => {
    writeJsonRpc({ method: 'thread/tokenUsage/updated', params: {
      threadId,
      turnId,
      tokenUsage: {
        total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 },
        last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 },
        modelContextWindow: 258400,
      },
    } });
    writeJsonRpc({ method: 'turn/completed', params: { threadId, turn: mockTurn(turnId, status, error) } });
  };
  const agentDelta = (id, delta) => writeJsonRpc({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: id, delta } });
  const agentDone = (id, textValue) => writeJsonRpc({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id, text: textValue, phase: null, memoryCitation: null }, completedAtMs: Date.now() } });
  const updateGoal = (patch = {}) => {
    if (!goals || !goals.has(threadId)) return null;
    const previous = goals.get(threadId);
    const goal = {
      ...previous,
      ...patch,
      tokensUsed: patch.tokensUsed === undefined ? Number(previous.tokensUsed || 0) + 15 : patch.tokensUsed,
      timeUsedSeconds: patch.timeUsedSeconds === undefined ? Number(previous.timeUsedSeconds || 0) + 1 : patch.timeUsedSeconds,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    goals.set(threadId, goal);
    writeJsonRpc({ method: 'thread/goal/updated', params: { threadId, turnId, goal } });
    return goal;
  };

  if (/pwd/i.test(text)) {
    const item = { type: 'commandExecution', id: 'item_cmd', command: '/bin/bash -lc pwd', cwd: process.cwd(), processId: null, source: 'exec', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    writeJsonRpc({ method: 'item/started', params: { threadId, turnId, item, startedAtMs: Date.now() } });
    writeJsonRpc({ method: 'item/completed', params: { threadId, turnId, item: { ...item, status: 'completed', aggregatedOutput: '/tmp/mock-codex\n', exitCode: 0, durationMs: 1 }, completedAtMs: Date.now() } });
  }

  if (text === '/compact') {
    state.compacted = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  if (text === 'trigger codex context limit' && !state.compacted) {
    const message = 'Context window exceeded. Please use /compact and retry.';
    writeJsonRpc({ method: 'error', params: { error: { message }, willRetry: false, threadId, turnId } });
    completeTurn('failed', { message, codexErrorInfo: 'context_window_exceeded', additionalDetails: null });
    return;
  }
  if (text === 'trigger codex auth error') {
    const message = 'authentication failed: invalid api key';
    process.stderr.write(`${message}\n`);
    writeJsonRpc({ method: 'error', params: { error: { message }, willRetry: false, threadId, turnId } });
    completeTurn('failed', { message, codexErrorInfo: 'unauthorized', additionalDetails: null });
    return;
  }
  if (text === 'trigger codex capacity retry') {
    state.capacityAttempts = Number(state.capacityAttempts || 0) + 1;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.capacityAttempts <= 2) {
      const message = 'Selected model is at capacity. Please try a different model.';
      process.stderr.write(`${message}\n`);
      writeJsonRpc({ method: 'error', params: { error: { message }, willRetry: false, threadId, turnId } });
      completeTurn('failed', { message, codexErrorInfo: 'server_overloaded', additionalDetails: null });
      return;
    }
    agentDelta('item_capacity_retry_success', 'Codex mock capacity retry succeeded.');
    try { fs.unlinkSync(statePath); } catch {}
    completeTurn();
    return;
  }
  if (text === 'trigger codex stream disconnect retry') {
    state.streamDisconnectAttempts = Number(state.streamDisconnectAttempts || 0) + 1;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.streamDisconnectAttempts <= 1) {
      const message = 'stream disconnected before completion: error sending request for url (http://127.0.0.1:12345/openai/responses)';
      writeJsonRpc({ method: 'error', params: { message: 'Reconnecting... 1/5 (stream disconnected before completion: An error occurred while processing your request.)' } });
      process.stderr.write(`${message}\n`);
      completeTurn('failed', { message, codexErrorInfo: 'response_stream_disconnected', additionalDetails: null });
      return;
    }
    agentDelta('item_stream_disconnect_retry_success', 'Codex mock stream disconnect retry succeeded.');
    try { fs.unlinkSync(statePath); } catch {}
    completeTurn();
    return;
  }
  if (text === 'trigger codex silent exit') {
    agentDelta('item_msg_partial', 'Codex mock partial before silent exit.');
    completeTurn('failed', { message: 'process exited with non-zero status 1 but returned no stderr', codexErrorInfo: 'other', additionalDetails: null });
    return;
  }
  if (text === 'trigger codex metadata warning') {
    writeJsonRpc({ method: 'item/completed', params: { threadId, turnId, item: {
      type: 'error',
      id: 'item_warn',
      message: 'Model metadata for `claude-sonnet-4-6` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
    }, completedAtMs: Date.now() } });
  }
  const slowStreamMatch = text.match(/^trigger codex slow stream(?:\s+(.+))?$/i);
  if (slowStreamMatch) {
    const label = String(slowStreamMatch[1] || 'default').trim() || 'default';
    agentDelta(`item_msg_slow_${label}`, `slow-start:${label} `);
    await sleep(1500);
    agentDelta(`item_msg_slow_${label}`, `slow-mid:${label} `);
    await sleep(1500);
    agentDelta(`item_msg_slow_${label}`, `slow-end:${label}`);
    completeTurn();
    return;
  }
  if (text === 'trigger codex cumulative usage within window') {
    agentDelta('item_msg_cumulative_usage', 'Codex mock cumulative usage handled.');
    writeJsonRpc({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: {
      total: { inputTokens: 28201, cachedInputTokens: 16128, outputTokens: 40, reasoningOutputTokens: 0, totalTokens: 28241 },
      last: { inputTokens: 15351, cachedInputTokens: 12672, outputTokens: 14, reasoningOutputTokens: 0, totalTokens: 15365 },
      modelContextWindow: 258400,
    } } });
    writeJsonRpc({ method: 'turn/completed', params: { threadId, turn: mockTurn(turnId, 'completed') } });
    return;
  }
  if (text === 'trigger codex anomalous usage') {
    agentDelta('item_msg_usage', 'Codex mock anomalous usage handled.');
    writeJsonRpc({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: {
      total: { inputTokens: 35000000, cachedInputTokens: 32000000, outputTokens: 90000, reasoningOutputTokens: 0, totalTokens: 35090000 },
      last: { inputTokens: 210000, cachedInputTokens: 207000, outputTokens: 900, reasoningOutputTokens: 0, totalTokens: 210900 },
      modelContextWindow: 400000,
    } } });
    writeJsonRpc({ method: 'turn/completed', params: { threadId, turn: mockTurn(turnId, 'completed') } });
    return;
  }
  if (text === 'trigger codex active goal auto continuation') {
    agentDelta('item_goal_step_1', 'mock goal step 1 done; goal remains active.');
    updateGoal({ status: 'active' });
    completeTurn();
    return;
  }
  if (/Continue working toward the active Codex thread goal/.test(text)
    && /trigger codex active goal auto continuation/.test(text)) {
    const item = { type: 'commandExecution', id: 'item_goal_continue_cmd', command: '/bin/bash -lc true', cwd: process.cwd(), processId: null, source: 'exec', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    writeJsonRpc({ method: 'item/started', params: { threadId, turnId, item, startedAtMs: Date.now() } });
    writeJsonRpc({ method: 'item/completed', params: { threadId, turnId, item: { ...item, status: 'completed', aggregatedOutput: 'continued\n', exitCode: 0, durationMs: 1 }, completedAtMs: Date.now() } });
    agentDelta('item_goal_step_2', 'mock goal step 2 complete.');
    updateGoal({ status: 'complete' });
    completeTurn();
    return;
  }

  const responseText = text === '/compact'
    ? 'Codex compact finished.'
    : `Codex mock handled (${imageCount} image): ${text}`;
  agentDelta('item_msg', responseText);
  if (text === 'trigger codex context limit' && state.compacted) {
    try { fs.unlinkSync(statePath); } catch {}
  }
  completeTurn();
}

async function runMockAppServer() {
  const goals = new Map();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let request;
      try { request = JSON.parse(trimmed); } catch { continue; }
      const { id, method, params } = request;
      const respond = (result) => { if (id !== undefined) writeJsonRpc({ id, result }); };
      const fail = (message) => { if (id !== undefined) writeJsonRpc({ id, error: { code: -32000, message } }); };
      try {
        if (method === 'initialize') {
          respond({ userAgent: 'mock-codex-app-server', codexHome: process.env.CODEX_HOME || '', platformFamily: 'unix', platformOs: 'linux' });
        } else if (method === 'initialized') {
          // notification
        } else if (method === 'thread/start') {
          const threadId = `mock-${crypto.randomUUID()}`;
          const thread = mockThread(threadId);
          respond({ thread, model: params?.model || 'mock-model', modelProvider: 'mock', serviceTier: null, cwd: params?.cwd || process.cwd(), instructionSources: [], approvalPolicy: params?.approvalPolicy || 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, reasoningEffort: null });
          writeJsonRpc({ method: 'thread/started', params: { thread } });
        } else if (method === 'thread/resume') {
          const threadId = params?.threadId || `mock-${crypto.randomUUID()}`;
          const thread = mockThread(threadId);
          respond({ thread, model: params?.model || 'mock-model', modelProvider: 'mock', serviceTier: null, cwd: params?.cwd || process.cwd(), instructionSources: [], approvalPolicy: params?.approvalPolicy || 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, reasoningEffort: null });
        } else if (method === 'turn/start') {
          const threadId = params?.threadId;
          const turnId = `turn-${crypto.randomUUID()}`;
          respond({ turn: mockTurn(turnId) });
          await runMockAppServerTurn({ threadId, turnId, input: params?.input || [], goals });
        } else if (method === 'turn/interrupt') {
          respond({});
          writeJsonRpc({ method: 'turn/completed', params: { threadId: params?.threadId, turn: mockTurn(params?.turnId || 'interrupted', 'interrupted') } });
        } else if (method === 'thread/goal/set') {
          const threadId = params?.threadId;
          const previous = goals.get(threadId) || null;
          const now = Math.floor(Date.now() / 1000);
          const goal = {
            threadId,
            objective: params?.objective || previous?.objective || '',
            status: params?.status || previous?.status || 'active',
            tokenBudget: params?.tokenBudget === undefined ? (previous?.tokenBudget ?? null) : params.tokenBudget,
            tokensUsed: previous?.tokensUsed || 0,
            timeUsedSeconds: previous?.timeUsedSeconds || 0,
            createdAt: previous?.createdAt || now,
            updatedAt: now,
          };
          goals.set(threadId, goal);
          respond({ goal });
          writeJsonRpc({ method: 'thread/goal/updated', params: { threadId, turnId: null, goal } });
        } else if (method === 'thread/goal/get') {
          respond({ goal: goals.get(params?.threadId) || null });
        } else if (method === 'thread/goal/clear') {
          goals.delete(params?.threadId);
          respond({});
          writeJsonRpc({ method: 'thread/goal/cleared', params: { threadId: params?.threadId } });
        } else {
          fail(`Unsupported mock app-server method: ${method}`);
        }
      } catch (error) {
        fail(error?.message || String(error));
      }
    }
  });
}

(async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'app-server') {
    await runMockAppServer();
    return;
  }
  const isResume = args[0] === 'exec' && args[1] === 'resume';
  const threadId = (() => {
    if (!isResume) return `mock-${crypto.randomUUID()}`;
    for (let i = args.length - 1; i >= 2; i--) {
      const arg = args[i];
      if (arg === '-' || String(arg).startsWith('-')) continue;
      return arg;
    }
    return `mock-${crypto.randomUUID()}`;
  })();
  const input = (await readStdin()).trim();
  const imageCount = args.filter((arg) => arg === '--image').length;
  const statePath = path.join(os.tmpdir(), `webcoding-mock-codex-${threadId}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {}

  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);

  if (/pwd/i.test(input)) {
    process.stdout.write(`${JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '/tmp/mock-codex\n',
        exit_code: 0,
        status: 'completed',
      },
    })}\n`);
  }

  if (input === '/compact') {
    state.compacted = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }

  if (input === 'trigger codex context limit' && !state.compacted) {
    process.stdout.write(`${JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Context window exceeded. Please use /compact and retry.' },
    })}\n`);
    process.exit(1);
  }

  if (input === 'trigger codex auth error') {
    process.stderr.write('authentication failed: invalid api key\n');
    process.exit(1);
  }

  if (input === 'trigger codex capacity retry') {
    state.capacityAttempts = Number(state.capacityAttempts || 0) + 1;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.capacityAttempts <= 2) {
      process.stderr.write('Selected model is at capacity. Please try a different model.\n');
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_capacity_retry_success',
        type: 'agent_message',
        text: 'Codex mock capacity retry succeeded.',
      },
    })}\n`);
    try { fs.unlinkSync(statePath); } catch {}
    return;
  }

  if (input === 'trigger codex stream disconnect retry') {
    state.streamDisconnectAttempts = Number(state.streamDisconnectAttempts || 0) + 1;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.streamDisconnectAttempts <= 1) {
      process.stdout.write(`${JSON.stringify({
        type: 'error',
        message: 'Reconnecting... 1/5 (stream disconnected before completion: An error occurred while processing your request.)',
      })}\n`);
      process.stderr.write('stream disconnected before completion: error sending request for url (http://127.0.0.1:12345/openai/responses)\n');
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_stream_disconnect_retry_success',
        type: 'agent_message',
        text: 'Codex mock stream disconnect retry succeeded.',
      },
    })}\n`);
    try { fs.unlinkSync(statePath); } catch {}
    return;
  }

  if (input === 'trigger codex silent exit') {
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_msg_partial',
        type: 'agent_message',
        text: 'Codex mock partial before silent exit.',
      },
    })}\n`);
    process.exit(1);
  }

  if (input === 'trigger codex metadata warning') {
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_warn',
        type: 'error',
        message: 'Model metadata for `claude-sonnet-4-6` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
      },
    })}\n`);
  }

  const slowStreamMatch = input.match(/^trigger codex slow stream(?:\s+(.+))?$/i);
  if (slowStreamMatch) {
    const label = String(slowStreamMatch[1] || 'default').trim() || 'default';
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: `item_msg_start_${label}`,
        type: 'agent_message',
        text: `slow-start:${label} `,
      },
    })}\n`);
    await sleep(1500);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: `item_msg_mid_${label}`,
        type: 'agent_message',
        text: `slow-mid:${label} `,
      },
    })}\n`);
    await sleep(1500);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: `item_msg_end_${label}`,
        type: 'agent_message',
        text: `slow-end:${label}`,
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
    })}\n`);
    return;
  }



  if (input === 'trigger codex cumulative usage within window') {
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_msg_cumulative_usage',
        type: 'agent_message',
        text: 'Codex mock cumulative usage handled.',
      },
    })}
`);
    process.stdout.write(`${JSON.stringify({
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 28201, cached_input_tokens: 16128, output_tokens: 40, reasoning_output_tokens: 0, total_tokens: 28241 },
        last_token_usage: { input_tokens: 15351, cached_input_tokens: 12672, output_tokens: 14, reasoning_output_tokens: 0, total_tokens: 15365 },
        model_context_window: 258400,
      },
    })}
`);
    process.stdout.write(`${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 28201, cached_input_tokens: 16128, output_tokens: 40, reasoning_output_tokens: 0 },
      model_context_window: 258400,
    })}
`);
    return;
  }

  if (input === 'trigger codex anomalous usage') {
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_msg_usage',
        type: 'agent_message',
        text: 'Codex mock anomalous usage handled.',
      },
    })}
`);
    process.stdout.write(`${JSON.stringify({
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 35000000, cached_input_tokens: 32000000, output_tokens: 90000, total_tokens: 35090000 },
        last_token_usage: { input_tokens: 210000, cached_input_tokens: 207000, output_tokens: 900, total_tokens: 210900 },
        model_context_window: 400000,
      },
    })}
`);
    process.stdout.write(`${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 35010000, cached_input_tokens: 32005000, output_tokens: 90500, total_tokens: 35100500 },
      model_context_window: 400000,
    })}
`);
    return;
  }

  const responseText = input === '/compact'
    ? 'Codex compact finished.'
    : `Codex mock handled (${imageCount} image): ${input}`;

  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_msg',
      type: 'agent_message',
      text: responseText,
    },
  })}\n`);

  if (input === 'trigger codex context limit' && state.compacted) {
    try { fs.unlinkSync(statePath); } catch {}
  }

  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
  })}\n`);
})();
