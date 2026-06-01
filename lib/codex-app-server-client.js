'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');

class JsonRpcError extends Error {
  constructor(message, data = {}) {
    super(message || 'JSON-RPC request failed');
    this.name = 'JsonRpcError';
    this.code = data.code;
    this.data = data.data;
    this.response = data.response;
  }
}

class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexPath = options.codexPath || process.env.CODEX_PATH || 'codex';
    this.args = Array.isArray(options.args) && options.args.length > 0
      ? options.args.slice()
      : ['app-server', '--listen', 'stdio://'];
    this.cwd = options.cwd || process.cwd();
    this.env = { ...(options.env || process.env) };
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 30000) || 30000;
    this.detached = !!options.detached;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.initialized = false;
    this.closed = false;
  }

  start() {
    if (this.proc) return this;
    this.proc = spawn(this.codexPath, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: this.detached,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 20000) this.stderrBuffer = this.stderrBuffer.slice(-20000);
      this.emit('stderr', chunk);
    });
    this.proc.on('error', (error) => this.#close(error));
    this.proc.on('exit', (code, signal) => {
      const err = code === 0 || this.closed
        ? null
        : new Error(`codex app-server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      if (err && this.stderrBuffer.trim()) err.stderr = this.stderrBuffer.trim();
      this.#close(err, { code, signal });
    });
    return this;
  }

  async initialize(params = {}) {
    this.start();
    const result = await this.request('initialize', {
      clientInfo: {
        name: params.name || 'webcoding-codex-native',
        title: params.title || 'Webcoding Codex Native',
        version: params.version || '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
        ...(params.capabilities || {}),
      },
    }, params.timeoutMs || this.requestTimeoutMs);
    this.notify('initialized');
    this.initialized = true;
    return result;
  }

  request(method, params = undefined, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('codex app-server client is closed'));
    this.start();
    const id = this.nextId++;
    const payload = { id, method };
    if (params !== undefined) payload.params = params;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    this.#write(payload);
    return promise;
  }

  notify(method, params = undefined) {
    if (this.closed) return;
    const payload = { method };
    if (params !== undefined) payload.params = params;
    this.#write(payload);
  }

  async shutdown(signal = 'SIGTERM') {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('codex app-server client shutting down'));
      this.pending.delete(id);
    }
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(signal); } catch {}
    }
  }

  #write(payload) {
    const line = JSON.stringify(payload);
    this.emit('send', payload);
    this.proc.stdin.write(`${line}\n`);
  }

  #onStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message = null;
      try {
        message = JSON.parse(trimmed);
      } catch (error) {
        this.emit('parseError', { line: trimmed, error });
        continue;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    this.emit('message', message);
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit('unmatchedResponse', message);
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new JsonRpcError(message.error.message || `Request failed: ${pending.method}`, {
          code: message.error.code,
          data: message.error.data,
          response: message,
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      this.emit('notification', message.method, message.params || {}, message);
      // EventEmitter treats the literal 'error' event specially and throws when
      // no listener is installed. Keep app-server error notifications on the
      // generic notification channel unless a consumer explicitly subscribed.
      if (message.method !== 'error' || this.listenerCount('error') > 0) {
        this.emit(message.method, message.params || {}, message);
      }
      return;
    }
    this.emit('unknownMessage', message);
  }

  #close(error = null, meta = {}) {
    if (this.closed && !error) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error || new Error('codex app-server exited'));
      this.pending.delete(id);
    }
    this.emit('close', error, meta);
  }
}

module.exports = { CodexAppServerClient, JsonRpcError };
