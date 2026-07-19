const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createCodexRolloutStore(deps) {
  const { codexSessionsDir, codexRuntimeSessionsDir, sessionsDir, normalizeSession, sanitizeToolInput, createGeneratedImageSegmentFromCodexEvent } = deps;
  const MAX_TOOL_RESULT_LENGTH = 2000;
  const MAX_WALK_DEPTH = 8;

  function debugLog(event, details = {}) {
    if (!process.env.CC_WEB_DEBUG) return;
    try {
      console.debug('[codex-rollouts]', event, details);
    } catch {}
  }

  function extractCodexMessageText(content) {
    if (!Array.isArray(content)) return '';
    return content
      .filter((item) => item && (item.type === 'input_text' || item.type === 'output_text'))
      .map((item) => item.text || '')
      .join('');
  }

  function appendAssistantContent(turn, text) {
    if (!turn || !text || !text.trim()) return;
    turn.content = turn.content ? `${turn.content}\n\n${text}` : text;
    if (!Array.isArray(turn.segments)) turn.segments = [];
    const last = turn.segments[turn.segments.length - 1];
    if (last && last.type === 'text') {
      last.text = last.text ? `${last.text}\n\n${text}` : text;
    } else {
      turn.segments.push({ type: 'text', text });
    }
  }

  function appendAssistantTool(turn, tool) {
    if (!turn || !tool) return;
    turn.toolCalls.push(tool);
    if (!Array.isArray(turn.segments)) turn.segments = [];
    turn.segments.push({ type: 'tool_call', ...tool });
  }

  function updateAssistantTool(turn, toolUseId, updates = {}) {
    if (!turn || !toolUseId) return;
    const segment = Array.isArray(turn.segments)
      ? turn.segments.find((item) => item && item.type === 'tool_call' && item.id === toolUseId)
      : null;
    if (segment) Object.assign(segment, updates);
  }

  function parseCodexRolloutLines(lines) {
    const messages = [];
    const pendingToolCalls = new Map();
    const meta = { threadId: null, cwd: null, title: '', updatedAt: null, cliVersion: null, source: null };
    const totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    const postTotalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    let lastUsage = null;
    let contextWindowTokens = null;
    let currentAssistant = null;
    let sawRealUserMessage = false;
    let sawTotalUsageSnapshot = false;
    const fallbackUserMessages = [];

    function ensureAssistant(ts) {
      if (!currentAssistant) {
        currentAssistant = { role: 'assistant', content: '', toolCalls: [], segments: [], timestamp: ts || null };
      } else if (!currentAssistant.timestamp && ts) {
        currentAssistant.timestamp = ts;
      }
      return currentAssistant;
    }

    function flushAssistant() {
      if (!currentAssistant) return;
      if ((currentAssistant.content || '').trim() || currentAssistant.toolCalls.length > 0 || (currentAssistant.segments && currentAssistant.segments.length > 0)) {
        messages.push(currentAssistant);
      }
      currentAssistant = null;
      pendingToolCalls.clear();
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const ts = entry.timestamp || null;
      if (ts) meta.updatedAt = ts;

      if (entry.type === 'session_meta') {
        meta.threadId = entry.payload?.id || meta.threadId;
        meta.cwd = entry.payload?.cwd || meta.cwd;
        meta.cliVersion = entry.payload?.cli_version || meta.cliVersion;
        meta.source = entry.payload?.source || meta.source;
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
        const total = entry.payload?.info?.total_token_usage || null;
        const usage = entry.payload?.info?.last_token_usage || null;
        const reportedWindow = Number(entry.payload?.info?.model_context_window || 0) || null;
        if (reportedWindow) contextWindowTokens = reportedWindow;
        if (usage) {
          lastUsage = {
            inputTokens: usage.input_tokens || 0,
            cachedInputTokens: usage.cached_input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            reasoningOutputTokens: usage.reasoning_output_tokens || 0,
            totalTokens: usage.total_tokens || 0,
          };
        }
        if (total) {
          sawTotalUsageSnapshot = true;
          totalUsage.inputTokens = total.input_tokens || 0;
          totalUsage.cachedInputTokens = total.cached_input_tokens || 0;
          totalUsage.outputTokens = total.output_tokens || 0;
          totalUsage.reasoningOutputTokens = total.reasoning_output_tokens || 0;
          totalUsage.totalTokens = total.total_tokens || 0;
          postTotalUsage.inputTokens = 0;
          postTotalUsage.cachedInputTokens = 0;
          postTotalUsage.outputTokens = 0;
          postTotalUsage.reasoningOutputTokens = 0;
          postTotalUsage.totalTokens = 0;
        } else if (usage && sawTotalUsageSnapshot) {
          postTotalUsage.inputTokens += usage.input_tokens || 0;
          postTotalUsage.cachedInputTokens += usage.cached_input_tokens || 0;
          postTotalUsage.outputTokens += usage.output_tokens || 0;
          postTotalUsage.reasoningOutputTokens += usage.reasoning_output_tokens || 0;
          postTotalUsage.totalTokens += usage.total_tokens || 0;
        } else if (usage) {
          totalUsage.inputTokens += usage.input_tokens || 0;
          totalUsage.cachedInputTokens += usage.cached_input_tokens || 0;
          totalUsage.outputTokens += usage.output_tokens || 0;
          totalUsage.reasoningOutputTokens += usage.reasoning_output_tokens || 0;
          totalUsage.totalTokens += usage.total_tokens || 0;
        }
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        const text = String(entry.payload?.message || '').trim();
        if (text) {
          sawRealUserMessage = true;
          flushAssistant();
          if (!meta.title) meta.title = text.slice(0, 80).replace(/\n/g, ' ');
          messages.push({ role: 'user', content: text, timestamp: ts });
        }
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'image_generation_end') {
        let image = null;
        if (typeof createGeneratedImageSegmentFromCodexEvent === 'function') {
          image = createGeneratedImageSegmentFromCodexEvent(entry.payload, {
            sessionId: meta.threadId || 'imported',
            threadId: meta.threadId || '',
          });
        }
        if (!image) {
          const result = typeof entry.payload.result === 'string' ? entry.payload.result.trim() : '';
          if (result) {
            const src = /^data:image\//i.test(result) ? result : `data:image/png;base64,${result}`;
            image = {
              id: entry.payload.call_id || null,
              src,
              alt: 'Generated image',
              mime: 'image/png',
              prompt: entry.payload.revised_prompt || '',
            };
          }
        }
        if (image) ensureAssistant(ts).segments.push({ type: 'image', ...image });
        continue;
      }

      if (entry.type !== 'response_item') continue;

      const payload = entry.payload || {};
      switch (payload.type) {
      case 'message': {
        if (payload.role === 'assistant') {
          const text = extractCodexMessageText(payload.content);
          if (text.trim()) {
            if (currentAssistant && ((currentAssistant.content || '').trim() || currentAssistant.toolCalls.length > 0)) {
              flushAssistant();
            }
            appendAssistantContent(ensureAssistant(ts), text);
          }
        } else if (payload.role === 'user' && !sawRealUserMessage) {
          const text = extractCodexMessageText(payload.content);
          if (text.trim()) {
              fallbackUserMessages.push({ role: 'user', content: text, timestamp: ts });
          }
        }
        break;
      }
        case 'function_call': {
          const assistant = ensureAssistant(ts);
          const toolUseId = payload.call_id || payload.id || crypto.randomUUID();
          const tc = {
            name: payload.name || 'FunctionCall',
            id: toolUseId,
            input: sanitizeToolInput(payload.name || 'FunctionCall', payload.arguments || ''),
            done: false,
          };
          appendAssistantTool(assistant, tc);
          pendingToolCalls.set(toolUseId, tc);
          break;
        }
        case 'function_call_output': {
          const assistant = ensureAssistant(ts);
          const toolUseId = payload.call_id || crypto.randomUUID();
          let tc = pendingToolCalls.get(toolUseId);
          if (!tc) {
            tc = { name: 'FunctionCall', id: toolUseId, input: null, done: false };
            appendAssistantTool(assistant, tc);
            pendingToolCalls.set(toolUseId, tc);
          }
          tc.done = true;
          tc.result = (typeof payload.output === 'string'
            ? payload.output
            : JSON.stringify(payload.output || '')).slice(0, MAX_TOOL_RESULT_LENGTH);
          updateAssistantTool(assistant, toolUseId, {
            done: true,
            result: tc.result,
          });
          break;
        }
        default:
          break;
      }
    }

    flushAssistant();
    const finalTotalUsage = sawTotalUsageSnapshot ? {
      inputTokens: totalUsage.inputTokens + postTotalUsage.inputTokens,
      cachedInputTokens: totalUsage.cachedInputTokens + postTotalUsage.cachedInputTokens,
      outputTokens: totalUsage.outputTokens + postTotalUsage.outputTokens,
      reasoningOutputTokens: totalUsage.reasoningOutputTokens + postTotalUsage.reasoningOutputTokens,
      totalTokens: totalUsage.totalTokens + postTotalUsage.totalTokens,
    } : totalUsage;
    const result = { meta, messages, totalUsage: finalTotalUsage, lastUsage, contextWindowTokens };
    if (!sawRealUserMessage && fallbackUserMessages.length > 0) {
      const fallback = fallbackUserMessages[0];
      if (!meta.title) meta.title = fallback.content.trim().slice(0, 80).replace(/\n/g, ' ');
      return { ...result, messages: fallbackUserMessages.concat(messages) };
    }
    return result;

  }

  function walkFiles(dir, files = [], depth = 0) {
    if (depth > MAX_WALK_DEPTH) {
      debugLog('walk_depth_limit_reached', { dir, depth, maxDepth: MAX_WALK_DEPTH });
      return files;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      debugLog('walk_readdir_failed', { dir, error: error?.message || String(error) });
      return files;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(fullPath, files, depth + 1);
      else if (entry.isFile()) files.push(fullPath);
    }
    return files;
  }

  function getCodexRolloutFiles() {
    const files = [];
    const seenDirs = new Set();
    for (const dir of [codexSessionsDir, codexRuntimeSessionsDir]) {
      if (!dir || seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      if (!fs.existsSync(dir)) continue;
      walkFiles(dir, files);
    }
    return files.filter((filePath) => filePath.endsWith('.jsonl')).sort().reverse();
  }

  function readSessionJson(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return normalizeSession(JSON.parse(raw));
    } catch (error) {
      debugLog('read_session_json_failed', { filePath, error: error?.message || String(error) });
      return null;
    }
  }

  function getImportedCodexThreadIds() {
    const imported = new Set();
    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const session = readSessionJson(path.join(sessionsDir, entry.name));
        if (session?.codexThreadId) imported.add(session.codexThreadId);
        const contexts = session?.runtimeContexts?.codex;
        if (contexts && typeof contexts === 'object') {
          for (const value of Object.values(contexts)) {
            const runtimeId = value?.runtimeId;
            if (runtimeId) imported.add(runtimeId);
          }
        }
      }
    } catch (error) {
      debugLog('list_sessions_dir_failed', { sessionsDir, error: error?.message || String(error) });
    }
    return imported;
  }

  function *readLinesSync(filePath) {
    const chunkSize = 64 * 1024;
    const chunk = Buffer.alloc(chunkSize);
    const fd = fs.openSync(filePath, 'r');
    let rest = '';
    try {
      while (true) {
        const bytesRead = fs.readSync(fd, chunk, 0, chunkSize, null);
        if (!bytesRead) break;
        rest += chunk.toString('utf8', 0, bytesRead);
        let newlineIndex = rest.indexOf('\n');
        while (newlineIndex >= 0) {
          let line = rest.slice(0, newlineIndex);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          yield line;
          rest = rest.slice(newlineIndex + 1);
          newlineIndex = rest.indexOf('\n');
        }
      }
      if (rest) {
        if (rest.endsWith('\r')) rest = rest.slice(0, -1);
        yield rest;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  function parseCodexRolloutFile(filePath) {
    try {
      const parsed = parseCodexRolloutLines(readLinesSync(filePath));
      parsed.filePath = filePath;
      return parsed;
    } catch (error) {
      debugLog('parse_rollout_failed', { filePath, error: error?.message || String(error) });
      return null;
    }
  }

  return {
    parseCodexRolloutLines,
    getCodexRolloutFiles,
    getImportedCodexThreadIds,
    parseCodexRolloutFile,
  };
}

module.exports = { createCodexRolloutStore };
