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

(async function main() {
  const args = process.argv.slice(2);
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
