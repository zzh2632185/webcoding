#!/usr/bin/env node
'use strict';

const path = require('path');
const { CodexAppServerClient } = require('./codex-app-server-client');

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function legacyEvent(type, extra = {}) {
  emit({ type: 'event_msg', payload: { type, ...extra } });
}

function logError(message, detail = null) {
  const text = detail ? `${message}: ${detail}` : message;
  process.stderr.write(`${text}\n`);
}

function normalizeEffort(value) {
  const raw = String(value || '').trim().toLowerCase();
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(raw) ? raw : null;
}

function permissionParams(mode, cwd) {
  const normalized = String(mode || 'yolo').trim().toLowerCase();
  if (normalized === 'plan') {
    return {
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
    };
  }
  if (normalized === 'default') {
    return {
      approvalPolicy: 'on-failure',
      sandbox: 'workspace-write',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: cwd ? [cwd] : [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    };
  }
  return {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  };
}

function textInput(text) {
  return [{ type: 'text', text: String(text || ''), text_elements: [] }];
}

function buildInput(text, attachments = []) {
  const input = textInput(text);
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment && attachment.path) input.push({ type: 'localImage', path: attachment.path });
  }
  return input;
}

function snakeItemType(type) {
  switch (type) {
    case 'agentMessage': return 'agent_message';
    case 'commandExecution': return 'command_execution';
    case 'fileChange': return 'file_change';
    case 'mcpToolCall': return 'mcp_tool_call';
    case 'dynamicToolCall': return 'dynamic_tool_call';
    case 'imageGeneration': return 'image_generation';
    case 'webSearch': return 'web_search';
    default: return type;
  }
}

function convertItem(item) {
  if (!item || typeof item !== 'object') return item;
  const type = snakeItemType(item.type);
  if (item.type === 'agentMessage') return { id: item.id, type, text: item.text || '' };
  if (item.type === 'commandExecution') {
    return {
      id: item.id,
      type,
      command: item.command || '',
      aggregated_output: item.aggregatedOutput || '',
      exit_code: typeof item.exitCode === 'number' ? item.exitCode : null,
      status: item.status || null,
    };
  }
  if (item.type === 'mcpToolCall') {
    return {
      id: item.id,
      type,
      server_name: item.server || '',
      tool_name: item.tool || '',
      status: item.status || null,
      arguments: item.arguments || null,
      result: item.result || null,
      error: item.error || null,
      text: item.result ? JSON.stringify(item.result) : item.error ? JSON.stringify(item.error) : '',
    };
  }
  if (item.type === 'dynamicToolCall') {
    return {
      id: item.id,
      type,
      tool_name: item.tool || '',
      namespace: item.namespace || null,
      status: item.status || null,
      arguments: item.arguments || null,
      text: Array.isArray(item.contentItems) ? JSON.stringify(item.contentItems) : '',
    };
  }
  if (item.type === 'fileChange') return { ...item, type, status: item.status || null };
  if (item.type === 'reasoning') {
    return { id: item.id, type: 'reasoning', text: [...(item.summary || []), ...(item.content || [])].join('\n'), status: null };
  }
  return { ...item, type };
}

function summarizeGoal(goal) {
  if (!goal) return '当前线程没有原生 goal。';
  const budget = goal.tokenBudget == null ? '无限制' : String(goal.tokenBudget);
  return [
    `原生 goal 状态: ${goal.status}`,
    `目标: ${goal.objective}`,
    `tokensUsed: ${goal.tokensUsed}`,
    `timeUsedSeconds: ${goal.timeUsedSeconds}`,
    `tokenBudget: ${budget}`,
  ].join('\n');
}

function normalizeGoalStatus(status) {
  return String(status || '').trim().toLowerCase().replace(/[_-]/g, '');
}

function isActiveGoal(goal) {
  return normalizeGoalStatus(goal?.status) === 'active';
}

function buildGoalContinuationPrompt(goal) {
  const budget = goal?.tokenBudget == null ? 'none' : String(goal.tokenBudget);
  const tokensUsed = goal?.tokensUsed == null ? '0' : String(goal.tokensUsed);
  const timeUsedSeconds = goal?.timeUsedSeconds == null ? '0' : String(goal.timeUsedSeconds);
  const objective = String(goal?.objective || '').trim();
  return [
    'Continue working toward the active Codex thread goal.',
    '',
    'This is a Webcoding native goal-runner continuation turn, not a new user request.',
    'Do not create or replace the goal. Keep the existing active goal intact.',
    '',
    '<active_goal>',
    `objective: ${objective}`,
    `tokensUsed: ${tokensUsed}`,
    `timeUsedSeconds: ${timeUsedSeconds}`,
    `tokenBudget: ${budget}`,
    '</active_goal>',
    '',
    'Before deciding the goal is complete, audit the current evidence against the objective.',
    'If the objective is complete, use the native goal tool to mark it complete.',
    'If it is blocked, report the blocker and the exact input or external change needed.',
    'If it is still active and not blocked, take the next concrete action now; do not ask the user to type "continue".',
  ].join('\n');
}

function parseGoalCommand(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const arg = String(match[1] || '').trim();
  if (!arg || /^(get|status)$/i.test(arg)) return { action: 'get' };
  if (/^clear$/i.test(arg)) return { action: 'clear' };
  if (/^pause$/i.test(arg)) return { action: 'pause' };
  if (/^(resume|active)$/i.test(arg)) return { action: 'resume' };
  const setMatch = arg.match(/^set\s+([\s\S]+)$/i);
  return { action: 'set', objective: (setMatch ? setMatch[1] : arg).trim() };
}

function turnErrorMessage(turn) {
  if (!turn || !turn.error) return '';
  return turn.error.message || turn.error.description || JSON.stringify(turn.error);
}

async function main() {
  let inputText = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
  inputText = inputText.replace(/\s+$/g, '');

  const cwd = process.env.WEBCODING_CODEX_CWD || process.cwd();
  const mode = process.env.WEBCODING_CODEX_PERMISSION_MODE || 'yolo';
  const model = process.env.WEBCODING_CODEX_MODEL || '';
  const effort = normalizeEffort(process.env.WEBCODING_CODEX_REASONING_EFFORT || '');
  const resumeThreadId = process.env.WEBCODING_CODEX_THREAD_ID || '';
  const appServerArgs = parseJsonEnv('WEBCODING_CODEX_APP_SERVER_ARGS', ['app-server', '--listen', 'stdio://']);
  const attachments = parseJsonEnv('WEBCODING_CODEX_ATTACHMENTS', []);
  const requestTimeoutMs = Number(process.env.WEBCODING_CODEX_REQUEST_TIMEOUT_MS || 60000) || 60000;
  const turnTimeoutMs = Number(process.env.WEBCODING_CODEX_TURN_TIMEOUT_MS || 0) || 0;
  const goalMaxContinuations = Math.max(0, Number(process.env.WEBCODING_CODEX_GOAL_MAX_CONTINUATIONS || 80) || 80);
  const goalAutoWaitMs = Math.max(0, Number(process.env.WEBCODING_CODEX_GOAL_AUTO_WAIT_MS || 1200) || 1200);
  const perms = permissionParams(mode, cwd);
  const client = new CodexAppServerClient({
    codexPath: process.env.WEBCODING_CODEX_PATH || process.env.CODEX_PATH || 'codex',
    args: appServerArgs,
    cwd,
    env: process.env,
    requestTimeoutMs,
    detached: true,
  });

  let threadId = resumeThreadId;
  let activeTurnId = '';
  let turnDone = false;
  let fatalError = null;
  let pendingTurnKind = 'user';
  let currentTurnKind = 'user';
  let currentTurnHadToolActivity = false;
  let lastTurnKind = 'user';
  let lastTurnHadToolActivity = false;
  let completedTurnCount = 0;
  let manualGoalRunnerEnabled = false;
  const agentDeltaItems = new Set();

  async function interruptAndExit() {
    if (threadId && activeTurnId && !turnDone) {
      try {
        await client.request('turn/interrupt', { threadId, turnId: activeTurnId }, 1200);
        process.stderr.write(`[codex-native-interrupt] turn/interrupt sent threadId=${threadId} turnId=${activeTurnId}
`);
      } catch (error) {
        process.stderr.write(`[codex-native-interrupt] turn/interrupt failed threadId=${threadId} turnId=${activeTurnId} error=${error?.message || String(error)}
`);
      }
    }
    await client.shutdown('SIGTERM');
    process.exit(130);
  }
  process.on('SIGTERM', interruptAndExit);
  process.on('SIGINT', interruptAndExit);

  client.on('stderr', (chunk) => process.stderr.write(chunk));
  client.on('parseError', ({ line, error }) => logError('codex app-server JSON parse error', `${error.message}: ${line.slice(0, 500)}`));
  client.on('close', (error) => {
    if (error && !turnDone && !fatalError) fatalError = error;
  });
  client.on('notification', (method, params) => {
    switch (method) {
      case 'thread/started': {
        const id = params?.thread?.id;
        if (id) {
          threadId = id;
          legacyEvent('thread.started', { thread_id: id });
        }
        break;
      }
      case 'turn/started': {
        const turn = params?.turn || {};
        activeTurnId = turn.id || activeTurnId;
        turnDone = false;
        currentTurnKind = pendingTurnKind || 'native_auto_goal';
        pendingTurnKind = '';
        currentTurnHadToolActivity = false;
        emit({ type: 'event_msg', payload: { type: 'task_started', model_context_window: null } });
        break;
      }
      case 'item/started': {
        const original = params?.item;
        if (original && !['agentMessage', 'userMessage', 'reasoning'].includes(original.type)) {
          currentTurnHadToolActivity = true;
        }
        const item = convertItem(params?.item);
        if (item && item.id && item.type !== 'agent_message') legacyEvent('item.started', { item });
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = params?.delta || '';
        if (delta) {
          if (params?.itemId) agentDeltaItems.add(params.itemId);
          legacyEvent('item.agent_message.delta', { item_id: params?.itemId || '', text: delta });
        }
        break;
      }
      case 'item/completed': {
        const original = params?.item;
        if (!original) break;
        if (!['agentMessage', 'userMessage', 'reasoning'].includes(original.type)) {
          currentTurnHadToolActivity = true;
        }
        if (original.type === 'agentMessage' && agentDeltaItems.has(original.id)) break;
        const item = convertItem(original);
        if (item?.type === 'image_generation' && item.result) {
          legacyEvent('image_generation_end', {
            call_id: item.id,
            result: item.result,
            revised_prompt: item.revisedPrompt || item.revised_prompt || '',
          });
        } else if (item) {
          legacyEvent('item.completed', { item });
        }
        break;
      }
      case 'command/exec/outputDelta':
      case 'process/outputDelta':
      case 'item/commandExecution/outputDelta': {
        const delta = params?.delta || params?.deltaBase64 || '';
        currentTurnHadToolActivity = true;
        if (delta && params?.itemId) {
          legacyEvent('item.output.delta', { item_id: params.itemId, text: delta });
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const usage = params?.tokenUsage || params?.usage || null;
        if (usage) {
          legacyEvent('token_count', {
            info: {
              total_token_usage: usage.total || usage,
              last_token_usage: usage.last || usage,
              model_context_window: usage.modelContextWindow || usage.model_context_window || null,
            },
          });
        }
        break;
      }
      case 'thread/goal/updated': {
        const goal = params?.goal || null;
        legacyEvent('thread.goal.updated', { thread_id: params?.threadId || threadId, turn_id: params?.turnId || null, goal });
        process.stderr.write(`[codex-native-goal] ${JSON.stringify(goal)}\n`);
        break;
      }
      case 'thread/goal/cleared': {
        legacyEvent('thread.goal.cleared', { thread_id: params?.threadId || threadId });
        process.stderr.write(`[codex-native-goal] cleared ${params?.threadId || threadId}\n`);
        break;
      }
      case 'turn/completed': {
        const turn = params?.turn || {};
        turnDone = true;
        lastTurnKind = currentTurnKind || lastTurnKind;
        lastTurnHadToolActivity = !!currentTurnHadToolActivity;
        completedTurnCount += 1;
        activeTurnId = '';
        if (turn.status === 'failed' || turn.error) {
          fatalError = new Error(turnErrorMessage(turn) || 'Codex turn failed');
          legacyEvent('turn.failed', { error: { message: fatalError.message } });
        }
        legacyEvent('turn.completed', { usage: null });
        break;
      }
      case 'error': {
        const rawMessage = params?.message || params?.error || params || {};
        const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
        if (message) {
          fatalError = new Error(message);
          legacyEvent('error', { message });
        }
        break;
      }
      default:
        break;
    }
  });

  try {
    await client.initialize({ timeoutMs: requestTimeoutMs });

    async function ensureThread() {
      if (threadId) {
        const resumed = await client.request('thread/resume', {
          threadId,
          cwd,
          model: model || null,
          approvalPolicy: perms.approvalPolicy,
          sandbox: perms.sandbox,
        }, requestTimeoutMs);
        threadId = resumed?.thread?.id || threadId;
        legacyEvent('thread.started', { thread_id: threadId });
        return resumed;
      }
      const started = await client.request('thread/start', {
        cwd,
        model: model || null,
        approvalPolicy: perms.approvalPolicy,
        sandbox: perms.sandbox,
        threadSource: 'user',
      }, requestTimeoutMs);
      threadId = started?.thread?.id;
      if (!threadId) throw new Error('codex app-server did not return thread id');
      legacyEvent('thread.started', { thread_id: threadId });
      return started;
    }

    async function startTurn(turnInputText, kind = 'user') {
      const turnParams = {
        threadId,
        input: buildInput(turnInputText, attachments),
        cwd,
        approvalPolicy: perms.approvalPolicy,
        sandboxPolicy: perms.sandboxPolicy,
        model: model || null,
        effort,
      };
      turnDone = false;
      fatalError = null;
      activeTurnId = '';
      pendingTurnKind = kind;
      currentTurnKind = kind;
      currentTurnHadToolActivity = false;
      const turnStart = await client.request('turn/start', turnParams, requestTimeoutMs);
      activeTurnId = turnStart?.turn?.id || activeTurnId;
      if (!activeTurnId) throw new Error('codex app-server did not return turn id');
      return turnStart;
    }

    async function waitForCurrentTurn() {
      const startedAt = Date.now();
      while (!turnDone && !fatalError) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (turnTimeoutMs && Date.now() - startedAt > turnTimeoutMs) {
          throw new Error(`Codex turn timeout after ${turnTimeoutMs}ms`);
        }
      }
      if (fatalError) throw fatalError;
    }

    async function readCurrentGoal() {
      if (!threadId) return null;
      try {
        const result = await client.request('thread/goal/get', { threadId }, requestTimeoutMs);
        return result?.goal || null;
      } catch (error) {
        process.stderr.write(`[codex-native-goal-runner] thread/goal/get failed: ${error?.message || String(error)}\n`);
        return null;
      }
    }

    async function waitForNativeAutoContinuation(previousCompletedCount) {
      const deadline = Date.now() + goalAutoWaitMs;
      while (Date.now() < deadline && !fatalError) {
        if (!turnDone && activeTurnId) {
          process.stderr.write(`[codex-native-goal-runner] native app-server auto-continuation detected threadId=${threadId} turnId=${activeTurnId}\n`);
          await waitForCurrentTurn();
          return true;
        }
        if (completedTurnCount > previousCompletedCount && turnDone) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (fatalError) throw fatalError;
      return false;
    }

    async function followActiveGoalIfNeeded() {
      if (!manualGoalRunnerEnabled) return;
      let continuations = 0;
      while (true) {
        const goal = await readCurrentGoal();
        if (!isActiveGoal(goal)) {
          const status = goal ? goal.status : 'none';
          process.stderr.write(`[codex-native-goal-runner] stop status=${status} threadId=${threadId}\n`);
          return;
        }
        if ((lastTurnKind === 'continuation' || lastTurnKind === 'native_auto_goal') && !lastTurnHadToolActivity) {
          process.stderr.write(`[codex-native-goal-runner] stop no-tool continuation threadId=${threadId}\n`);
          legacyEvent('thread.goal.runner.stopped', {
            thread_id: threadId,
            reason: 'no_tool_call_in_continuation',
            goal,
          });
          return;
        }
        if (continuations >= goalMaxContinuations) {
          process.stderr.write(`[codex-native-goal-runner] stop max continuations=${goalMaxContinuations} threadId=${threadId}\n`);
          legacyEvent('thread.goal.runner.stopped', {
            thread_id: threadId,
            reason: 'max_continuations',
            goal,
            max_continuations: goalMaxContinuations,
          });
          return;
        }

        const completedBeforeWait = completedTurnCount;
        const nativeContinued = await waitForNativeAutoContinuation(completedBeforeWait);
        if (nativeContinued) {
          continuations += 1;
          continue;
        }

        continuations += 1;
        process.stderr.write(`[codex-native-goal-runner] starting fallback continuation ${continuations}/${goalMaxContinuations} threadId=${threadId}\n`);
        legacyEvent('thread.goal.runner.continuing', {
          thread_id: threadId,
          continuation: continuations,
          max_continuations: goalMaxContinuations,
          goal,
        });
        await startTurn(buildGoalContinuationPrompt(goal), 'continuation');
        await waitForCurrentTurn();
      }
    }

    let turnInputText = inputText;
    const goalCommand = parseGoalCommand(inputText);
    if (goalCommand) {
      await ensureThread();
      const action = goalCommand;
      if (action.action === 'set') {
        const result = await client.request('thread/goal/set', { threadId, objective: action.objective, status: 'active' }, requestTimeoutMs);
        legacyEvent('item.agent_message.delta', { item_id: 'goal-set', text: `已创建/更新 Codex 原生 goal。
${summarizeGoal(result?.goal)}

开始执行该 goal…
` });
        // Native thread/goal/set only updates persisted Codex goal state; it does
        // not start a turn by itself. Continue this same Webcoding turn with a
        // native turn/start so `/goal <objective>` begins work without restoring
        // Webcoding's old .codex-goals state. After that first turn, this
        // process keeps the native app-server alive long enough for native
        // auto-continuation; if the short-lived wrapper boundary prevents that,
        // it starts bounded native continuation turns until the native goal
        // leaves the active state.
        turnInputText = action.objective || inputText;
        manualGoalRunnerEnabled = true;
      } else if (action.action === 'get') {
        if (!threadId) {
          legacyEvent('item.agent_message.delta', { item_id: 'goal-get', text: '当前会话还没有 Codex 原生 thread，因此没有 goal。\n' });
        } else {
          await ensureThread();
          const result = await client.request('thread/goal/get', { threadId }, requestTimeoutMs);
          legacyEvent('item.agent_message.delta', { item_id: 'goal-get', text: `${summarizeGoal(result?.goal)}\n` });
        }
        turnDone = true;
        legacyEvent('turn.completed', { usage: null });
        await client.shutdown();
        return;
      } else if (action.action === 'clear') {
        await ensureThread();
        await client.request('thread/goal/clear', { threadId }, requestTimeoutMs);
        legacyEvent('item.agent_message.delta', { item_id: 'goal-clear', text: '已清除 Codex 原生 goal。\n' });
        turnDone = true;
        legacyEvent('turn.completed', { usage: null });
        await client.shutdown();
        return;
      } else if (action.action === 'pause' || action.action === 'resume') {
        await ensureThread();
        const result = await client.request('thread/goal/set', { threadId, status: action.action === 'pause' ? 'paused' : 'active' }, requestTimeoutMs);
        legacyEvent('item.agent_message.delta', { item_id: `goal-${action.action}`, text: `${action.action === 'pause' ? '已暂停' : '已恢复'} Codex 原生 goal。\n${summarizeGoal(result?.goal)}\n` });
        turnDone = true;
        legacyEvent('turn.completed', { usage: null });
        await client.shutdown();
        return;
      }
    }

    await ensureThread();
    await startTurn(turnInputText, 'user');
    await waitForCurrentTurn();
    await followActiveGoalIfNeeded();
    await client.shutdown();
  } catch (error) {
    const message = error?.message || String(error);
    legacyEvent('turn.failed', { error: { message } });
    logError('codex native runtime failed', message);
    await client.shutdown();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildGoalContinuationPrompt,
  isActiveGoal,
  normalizeGoalStatus,
  parseGoalCommand,
  summarizeGoal,
};
