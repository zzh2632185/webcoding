const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const { createAgentRuntime } = require('./lib/agent-runtime');
const { createCodexRolloutStore } = require('./lib/codex-rollouts');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = String(m[2] || '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
      val = val.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = val;
  }
}

const PORT = parseInt(process.env.PORT) || 8001;
// Ignore loopback-only HOST values (some cloud images set HOST=127.0.0.1 globally)
const _HOST_ENV = process.env.HOST || '';
const HOST = (_HOST_ENV && _HOST_ENV !== '127.0.0.1' && _HOST_ENV !== 'localhost') ? _HOST_ENV : '0.0.0.0';
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const CODEX_PATH = process.env.CODEX_PATH || 'codex';
const CONFIG_DIR = process.env.CC_WEB_CONFIG_DIR || path.join(__dirname, 'config');
const CODEX_RUNTIME_HOME = path.join(CONFIG_DIR, 'codex-runtime-home');
const GENERATED_IMAGES_ROOT = path.join(CODEX_RUNTIME_HOME, 'generated_images');
const GENERATED_MESSAGE_IMAGES_ROOT = path.join(CONFIG_DIR, 'generated-message-images');
const SESSIONS_DIR = process.env.CC_WEB_SESSIONS_DIR || path.join(__dirname, 'sessions');
const PUBLIC_DIR = process.env.CC_WEB_PUBLIC_DIR || path.join(__dirname, 'public');
const LOGS_DIR = process.env.CC_WEB_LOGS_DIR || path.join(__dirname, 'logs');
const ATTACHMENTS_DIR = path.join(SESSIONS_DIR, '_attachments');
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 4;
const MAX_CONTEXT_FILE_REFS = 8;
const MAX_CONTEXT_FILE_SIZE = 256 * 1024;
const MAX_CONTEXT_FILES_TOTAL_SIZE = 1024 * 1024;
const FILE_VIEW_TEXT_MAX_SIZE = 1024 * 1024;
const FILE_VIEW_BINARY_MAX_SIZE = 20 * 1024 * 1024;
const FILE_VIEW_TABLE_MAX_ROWS = 1000;
const FILE_VIEW_TABLE_MAX_COLS = 50;
const FILE_TREE_MAX_DEPTH = 3;
const FILE_TREE_MAX_ENTRIES = 800;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const FILE_TREE_IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.pytest_cache', '.cache']);
const TEXT_CONTEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.jsonl', '.css', '.scss', '.sass',
  '.html', '.htm', '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini', '.conf', '.env', '.example', '.sh', '.bash', '.zsh',
  '.py', '.java', '.kt', '.kts', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.rb', '.swift', '.sql',
  '.dockerfile', '.gitignore', '.gitattributes', '.editorconfig', '.csv', '.tsv', '.log'
]);
const FILE_VIEW_CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.scss', '.sass', '.html', '.htm', '.xml', '.svg',
  '.yml', '.yaml', '.toml', '.ini', '.conf', '.env', '.example', '.sh', '.bash', '.zsh', '.py', '.java', '.kt', '.kts',
  '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.rb', '.swift', '.sql', '.dockerfile'
]);
const FILE_VIEW_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.avif']);
const FILE_VIEW_BINARY_EXTENSIONS = new Set(['.pdf', '.xlsx', '.xls', '.docx']);
const NOTIFY_CONFIG_PATH = path.join(CONFIG_DIR, 'notify.json');
const AUTH_CONFIG_PATH = path.join(CONFIG_DIR, 'auth.json');
const MODEL_CONFIG_PATH = path.join(CONFIG_DIR, 'model.json');
const CODEX_CONFIG_PATH = path.join(CONFIG_DIR, 'codex.json');
const PROJECTS_CONFIG_PATH = path.join(CONFIG_DIR, 'projects.json');
const BRIDGE_RUNTIME_PATH = path.join(CONFIG_DIR, 'bridge-runtime.json');
const BRIDGE_STATE_PATH = path.join(CONFIG_DIR, 'bridge-state.json');
const BRIDGE_USAGE_PATH = path.join(CONFIG_DIR, 'bridge-usage.jsonl');
const TUNNEL_STATE_PATH = path.join(CONFIG_DIR, 'tunnel-state.json');
const TUNNEL_SCRIPT_PATH = path.join(__dirname, 'lib', 'cf-tunnel.js');
const TUNNEL_START_TIMEOUT_MS = 30000;
const CLAUDE_SETTINGS_BACKUP_PATH = path.join(CONFIG_DIR, 'claude-settings-backup.json');
const BRIDGE_SCRIPT_PATH = path.join(__dirname, 'lib', 'local-api-bridge.js');
const PUBLIC_ROOT = path.resolve(PUBLIC_DIR);
const USER_HOME = process.env.HOME || process.env.USERPROFILE || '';
const BROWSE_ROOTS = USER_HOME ? [path.resolve(USER_HOME)] : [path.resolve(process.cwd())];
const AUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_TOKEN_CLEANUP_MS = 60 * 60 * 1000;
const HISTORY_CHUNK_BUFFER_LIMIT = 512 * 1024;
const HISTORY_CHUNK_RETRY_MS = 16;
const ATTACHMENT_CLEANUP_THROTTLE_MS = 30 * 60 * 1000;
const BRIDGE_START_TIMEOUT_MS = 5000;
const HTTP_BODY_MAX_BYTES = 2 * 1024 * 1024;
const AUTH_LOCK_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 5;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 64;
const MAX_AUTO_COMPACT_RETRIES = 2;
const SESSION_LIST_CACHE_TTL_MS = 300;
const FILE_TAIL_DEBOUNCE_MS = 40;
const FILE_TAIL_MAX_READ_BYTES = 8 * 1024 * 1024;
const IMPORTED_SESSION_IDS_CACHE_TTL_MS = 2000;
const JSONL_HEAD_READ_BYTES = 128 * 1024;
const JSONL_TAIL_READ_BYTES = 128 * 1024;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-XSS-Protection': '0',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; frame-ancestors 'none'; base-uri 'none'",
};

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
fs.mkdirSync(GENERATED_MESSAGE_IMAGES_ROOT, { recursive: true });

const jsonConfigCache = new Map();
const authAttemptByIp = new Map();

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function readCachedJsonConfig(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    const cached = jsonConfigCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cloneJson(cached.value);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    jsonConfigCache.set(filePath, { mtimeMs: stat.mtimeMs, value: cloneJson(parsed) });
    return cloneJson(parsed);
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function writeCachedJsonConfig(filePath, value) {
  writeJsonAtomic(filePath, value);
  try {
    const stat = fs.statSync(filePath);
    jsonConfigCache.set(filePath, { mtimeMs: stat.mtimeMs, value: cloneJson(value) });
  } catch {
    jsonConfigCache.set(filePath, { mtimeMs: null, value: cloneJson(value) });
  }
}

function deleteCachedJsonConfig(filePath) {
  jsonConfigCache.delete(filePath);
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function writeHeadWithSecurity(res, statusCode, headers = {}) {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
}

// === Process Lifecycle Logger ===
const LOG_FILE = path.join(LOGS_DIR, 'process.log');
const LOG_MAX_SIZE = 2 * 1024 * 1024; // 2MB per file

function plog(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    // Simple rotation: if file > 2MB, rename to .old and start fresh
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > LOG_MAX_SIZE) {
        const oldFile = LOG_FILE.replace('.log', '.old.log');
        try { fs.unlinkSync(oldFile); } catch {}
        fs.renameSync(LOG_FILE, oldFile);
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// === Notification System ===
function loadNotifyConfig() {
  const cached = readCachedJsonConfig(NOTIFY_CONFIG_PATH);
  if (cached) return cached;
  // First run: migrate from .env PUSHPLUS_TOKEN
  const token = process.env.PUSHPLUS_TOKEN || '';
  const config = {
    provider: token ? 'pushplus' : 'off',
    pushplus: { token },
    telegram: { botToken: '', chatId: '' },
    serverchan: { sendKey: '' },
    feishu: { webhook: '' },
    qqbot: { qmsgKey: '' },
  };
  saveNotifyConfig(config);
  return config;
}

function saveNotifyConfig(config) {
  writeCachedJsonConfig(NOTIFY_CONFIG_PATH, config);
}

function maskToken(str) {
  if (!str || str.length <= 8) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function validateFeishuWebhook(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: '飞书 Webhook 必须使用 HTTPS' };
    }
    const host = parsed.hostname.toLowerCase();
    const hostAllowed = host === 'feishu.cn'
      || host.endsWith('.feishu.cn')
      || host === 'larksuite.com'
      || host.endsWith('.larksuite.com');
    if (!hostAllowed) {
      return { ok: false, error: '飞书 Webhook 域名不合法' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: '飞书 Webhook URL 无效' };
  }
}

function getNotifyConfigMasked() {
  const config = loadNotifyConfig();
  return {
    provider: config.provider,
    pushplus: { token: maskToken(config.pushplus?.token) },
    telegram: { botToken: maskToken(config.telegram?.botToken), chatId: config.telegram?.chatId || '' },
    serverchan: { sendKey: maskToken(config.serverchan?.sendKey) },
    feishu: { webhook: maskToken(config.feishu?.webhook) },
    qqbot: { qmsgKey: maskToken(config.qqbot?.qmsgKey) },
  };
}

function sendNotification(title, content) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') return Promise.resolve({ ok: true, skipped: true });

  return new Promise((resolve) => {
    let url, data;
    let isFormData = false;
    switch (config.provider) {
      case 'pushplus': {
        if (!config.pushplus?.token) return resolve({ ok: false, error: 'PushPlus token 未配置' });
        url = 'https://www.pushplus.plus/send';
        data = JSON.stringify({ token: config.pushplus.token, title, content, template: 'txt' });
        break;
      }
      case 'telegram': {
        if (!config.telegram?.botToken || !config.telegram?.chatId) return resolve({ ok: false, error: 'Telegram botToken 或 chatId 未配置' });
        url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
        data = JSON.stringify({ chat_id: config.telegram.chatId, text: `${title}\n\n${content}` });
        break;
      }
      case 'serverchan': {
        if (!config.serverchan?.sendKey) return resolve({ ok: false, error: 'Server酱 sendKey 未配置' });
        url = `https://sctapi.ftqq.com/${config.serverchan.sendKey}.send`;
        data = JSON.stringify({ title, desp: content });
        break;
      }
      case 'feishu': {
        if (!config.feishu?.webhook) return resolve({ ok: false, error: '飞书 Webhook 未配置' });
        const feishuValidation = validateFeishuWebhook(config.feishu.webhook);
        if (!feishuValidation.ok) return resolve({ ok: false, error: feishuValidation.error });
        url = config.feishu.webhook;
        data = JSON.stringify({ msg_type: 'text', content: { text: `${title}\n\n${content}` } });
        break;
      }
      case 'qqbot': {
        if (!config.qqbot?.qmsgKey) return resolve({ ok: false, error: 'Qmsg Key 未配置' });
        url = `https://qmsg.zendee.cn/send/${config.qqbot.qmsgKey}`;
        data = `msg=${encodeURIComponent(`${title}\n\n${content}`)}`;
        isFormData = true;
        break;
      }
      default:
        return resolve({ ok: false, error: `未知通知方式: ${config.provider}` });
    }

    const parsed = new URL(url);
    const contentType = isFormData ? 'application/x-www-form-urlencoded' : 'application/json';
    const reqOptions = {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(parsed, reqOptions, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        plog('INFO', 'notify_response', { provider: config.provider, status: res.statusCode, body: body.slice(0, 200) });
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: body.slice(0, 200) });
      });
    });
    req.on('error', (e) => {
      plog('WARN', 'notify_error', { provider: config.provider, error: e.message });
      resolve({ ok: false, error: e.message });
    });
    req.setTimeout(10000, () => req.destroy(new Error('notification timeout')));
    req.write(data);
    req.end();
  });
}

// Load config on startup (ensures migration)
loadNotifyConfig();

// === Auth Config ===
function generateRandomPassword(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, PASSWORD_HASH_BYTES).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function isPasswordHashFormat(stored) {
  const parts = String(stored || '').split(':');
  return parts.length === 3 && parts[0] === 'scrypt' && parts[1] && /^[a-f0-9]+$/i.test(parts[2]);
}

function verifyPasswordHash(password, stored) {
  if (!isPasswordHashFormat(stored)) return false;
  try {
    const [, salt, expectedHex] = String(stored).split(':');
    const derivedHex = crypto.scryptSync(String(password || ''), salt, PASSWORD_HASH_BYTES).toString('hex');
    return timingSafeStringEqual(derivedHex, expectedHex);
  } catch {
    return false;
  }
}

function normalizeAuthConfig(raw) {
  const mustChange = !!raw?.mustChange;
  if (isPasswordHashFormat(raw?.passwordHash)) {
    return { passwordHash: String(raw.passwordHash), mustChange };
  }
  if (typeof raw?.password === 'string' && raw.password) {
    return { passwordHash: hashPassword(raw.password), mustChange };
  }
  return null;
}

function loadAuthConfig() {
  // Priority 1: config/auth.json exists
  try {
    if (fs.existsSync(AUTH_CONFIG_PATH)) {
      const rawConfig = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8'));
      const normalized = normalizeAuthConfig(rawConfig);
      if (normalized) {
        if (!isPasswordHashFormat(rawConfig?.passwordHash) || rawConfig?.password) {
          saveAuthConfig(normalized);
          plog('INFO', 'auth_password_migrated_to_hash', {});
        }
        return normalized;
      }
    }
  } catch {}

  // Priority 2: .env has CC_WEB_PASSWORD → migrate
  const envPw = process.env.CC_WEB_PASSWORD;
  if (envPw && envPw !== 'changeme') {
    const config = { passwordHash: hashPassword(envPw), mustChange: false };
    saveAuthConfig(config);
    return config;
  }

  // Priority 3: Generate random password
  const pw = generateRandomPassword(12);
  const config = { passwordHash: hashPassword(pw), mustChange: true };
  saveAuthConfig(config);
  console.log('========================================');
  console.log('  自动生成初始密码: ' + pw);
  console.log('  首次登录后将要求修改密码');
  console.log('========================================');
  return config;
}

function saveAuthConfig(config) {
  const normalized = normalizeAuthConfig(config);
  if (!normalized) return;
  writeCachedJsonConfig(AUTH_CONFIG_PATH, normalized);
}

function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) {
    return { valid: false, message: '密码长度至少 8 位' };
  }
  let types = 0;
  if (/[a-z]/.test(pw)) types++;
  if (/[A-Z]/.test(pw)) types++;
  if (/[0-9]/.test(pw)) types++;
  if (/[^a-zA-Z0-9]/.test(pw)) types++;
  if (types < 2) {
    return { valid: false, message: '密码需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
  }
  return { valid: true, message: '' };
}

let authConfig = loadAuthConfig();
let PASSWORD_HASH = authConfig.passwordHash || '';

const activeTokens = new Map();

function timingSafeStringEqual(left, right) {
  const leftBuf = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuf = Buffer.from(String(right ?? ''), 'utf8');
  const maxLen = Math.max(leftBuf.length, rightBuf.length, 1);
  const paddedLeft = Buffer.alloc(maxLen);
  const paddedRight = Buffer.alloc(maxLen);
  leftBuf.copy(paddedLeft);
  rightBuf.copy(paddedRight);
  return crypto.timingSafeEqual(paddedLeft, paddedRight) && leftBuf.length === rightBuf.length;
}

function hasConfiguredPassword() {
  return !!PASSWORD_HASH;
}

function verifyConfiguredPassword(inputPassword) {
  if (!hasConfiguredPassword()) return false;
  return verifyPasswordHash(inputPassword, PASSWORD_HASH);
}

function getWsClientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.socket?.remoteAddress || 'unknown';
}

function getAuthLockState(ip, now = Date.now()) {
  const state = authAttemptByIp.get(ip);
  if (!state) return { locked: false, remainingMs: 0, count: 0 };
  if (state.lockedUntil && state.lockedUntil > now) {
    return { locked: true, remainingMs: state.lockedUntil - now, count: state.count || 0 };
  }
  if (state.lockedUntil && state.lockedUntil <= now) {
    authAttemptByIp.delete(ip);
  }
  return { locked: false, remainingMs: 0, count: 0 };
}

function clearAuthFailures(ip) {
  if (!ip) return;
  authAttemptByIp.delete(ip);
}

function recordAuthFailure(ip, now = Date.now()) {
  const prev = authAttemptByIp.get(ip) || { count: 0, firstAt: now, lockedUntil: 0 };
  const count = (prev.firstAt + AUTH_LOCK_WINDOW_MS < now) ? 1 : (prev.count + 1);
  const firstAt = (prev.firstAt + AUTH_LOCK_WINDOW_MS < now) ? now : prev.firstAt;
  const lockedUntil = count >= AUTH_MAX_FAILURES ? now + AUTH_LOCK_WINDOW_MS : 0;
  const next = { count, firstAt, lockedUntil };
  authAttemptByIp.set(ip, next);
  return {
    locked: lockedUntil > now,
    remainingMs: lockedUntil > now ? (lockedUntil - now) : 0,
    count,
  };
}

function rememberActiveToken(token, now = Date.now()) {
  if (!token) return null;
  activeTokens.set(token, now + AUTH_TOKEN_TTL_MS);
  return token;
}

function hasActiveToken(token, now = Date.now()) {
  if (!token) return false;
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= now) {
    activeTokens.delete(token);
    return false;
  }
  activeTokens.set(token, now + AUTH_TOKEN_TTL_MS);
  return true;
}

function cleanupExpiredTokens(now = Date.now()) {
  for (const [token, expiresAt] of activeTokens) {
    if (expiresAt <= now) activeTokens.delete(token);
  }
}

function cleanupAuthAttempts(now = Date.now()) {
  for (const [ip, state] of authAttemptByIp) {
    if (!state) {
      authAttemptByIp.delete(ip);
      continue;
    }
    const expired = state.lockedUntil ? state.lockedUntil <= now : (state.firstAt + AUTH_LOCK_WINDOW_MS <= now);
    if (expired) authAttemptByIp.delete(ip);
  }
}

function clearPendingSlashCommand(sessionId, expected) {
  const current = pendingSlashCommands.get(sessionId);
  if (!current) return;
  if (!expected || current === expected) pendingSlashCommands.delete(sessionId);
}

// Pending slash command metadata: sessionId -> { kind: string }
const pendingSlashCommands = new Map();

// Slash commands cache: per-agent discovered commands from CLI init events
const SLASH_COMMAND_DESCRIPTIONS = {
  // Webcoding core commands (server-side handled)
  clear: '清除当前会话（含上下文）',
  model: '查看/切换模型',
  mode: '查看/切换权限模式',
  reasoning: '查看/切换 Codex 思考级别',
  effort: '查看/切换 Codex 思考级别',
  cost: '查看会话费用/统计',
  compact: '压缩上下文',
  help: '显示帮助',
  // Claude CLI native commands
  debug: '调试模式',
  simplify: '精简代码',
  batch: '批量处理',
  review: '代码审查',
  'security-review': '安全审查',
  init: '初始化项目',
  context: '查看上下文',
  heapdump: '堆内存快照',
  insights: '洞察分析',
  'team-onboarding': '团队引导',
  // Claude skills (user-installed) — descriptions are best-effort; new skills show their raw name
  'update-config': '更新配置',
  loop: '循环执行',
  'claude-api': 'Claude API 开发',
  'web-access': '联网访问',
  opencli: 'OpenCLI 社交操作',
  'frontend-design': '前端设计',
  // Claude plugin commands
  'claude-hud:setup': '配置 HUD 状态栏',
  'claude-hud:configure': '配置 HUD 显示',
  'ralph-loop:help': 'Ralph Loop 帮助',
  'ralph-loop:cancel-ralph': '取消 Ralph Loop',
  'ralph-loop:ralph-loop': '启动 Ralph Loop',
  // Codex CLI built-in interactive commands
  status: '查看当前模型、审批和 Token 使用量',
  fork: '分支当前对话到新线程',
  new: '开始新的对话',
  feedback: '发送反馈日志给维护者',
  mcp: '列出已配置的 MCP 工具',
  permissions: '控制 Codex 何时请求确认',
  personality: '自定义 Codex 的沟通风格',
  rename: '重命名线程',
  skills: '列出可用技能',
  statusline: '配置状态栏显示内容',
  // Codex skills (user-installed) — discovered at runtime from ~/.codex/skills/
  imagegen: 'AI 图像生成',
  'openai-docs': 'OpenAI 官方文档查询',
  'plugin-creator': '创建 Codex 插件',
  'skill-creator': '创建 Codex 技能',
  'skill-installer': '安装 Codex 技能',
  pdf: 'PDF 文件处理',
  slides: 'PowerPoint 演示文稿',
  spreadsheets: 'Excel 电子表格',
  'computer-use': 'macOS 桌面控制',
};

const slashCommandsCache = {
  claude: { commands: null },
  codex: { commands: null },
};

function buildSlashCommandList(agent) {
  const cache = slashCommandsCache[agent];
  const cliCommands = (cache && cache.commands) || [];
  const isClaude = agent === 'claude';

  // Webcoding core commands — always present, server-handled
  const coreCmds = [
    { cmd: '/clear', desc: SLASH_COMMAND_DESCRIPTIONS.clear, source: 'webcoding' },
    { cmd: '/model', desc: SLASH_COMMAND_DESCRIPTIONS.model, source: 'webcoding' },
    { cmd: '/mode', desc: SLASH_COMMAND_DESCRIPTIONS.mode, source: 'webcoding' },
    { cmd: '/cost', desc: SLASH_COMMAND_DESCRIPTIONS.cost, source: 'webcoding' },
    { cmd: '/compact', desc: SLASH_COMMAND_DESCRIPTIONS.compact, source: 'webcoding' },
    { cmd: '/help', desc: SLASH_COMMAND_DESCRIPTIONS.help, source: 'webcoding' },
  ];

  // Deduplication set from core commands
  const coreNames = new Set(coreCmds.map(c => c.cmd));

  // Build CLI commands, skipping ones already in core
  const cliCmds = [];
  for (const raw of cliCommands) {
    const cmd = raw.startsWith('/') ? raw : `/${raw}`;
    if (coreNames.has(cmd)) continue;
    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    const desc = SLASH_COMMAND_DESCRIPTIONS[name] || name;
    cliCmds.push({ cmd, desc, source: isClaude ? 'claude-cli' : 'codex-cli' });
  }
  cliCmds.sort((a, b) => a.cmd.localeCompare(b.cmd));

  return [...coreCmds, ...cliCmds];
}

function onSlashCommandsDiscovered(agent, commands) {
  if (!agent || !Array.isArray(commands)) return;
  slashCommandsCache[agent] = { commands };
  // Broadcast to all connected clients
  broadcastSlashCommands(agent);
}

function broadcastSlashCommands(agent) {
  const list = buildSlashCommandList(agent);
  const msg = { type: 'slash_commands_list', agent, commands: list };
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
      wsSend(client, msg);
    }
  }
}

function discoverClaudeSlashCommands() {
  return new Promise((resolve) => {
    // Use text input with a minimal prompt — the init event arrives before any response
    const args = ['-p', '--output-format', 'stream-json', '--verbose', 'say hi'];
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(null); }
    }, 30000);

    try {
      const proc = spawn(CLAUDE_PATH, args, {
        env: { ...process.env },
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });

      let buf = '';
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'system' && Array.isArray(evt.slash_commands)) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                onSlashCommandsDiscovered('claude', evt.slash_commands);
                proc.kill();
                resolve(evt.slash_commands);
              }
            }
          } catch {}
        }
      });

      proc.stderr.on('data', () => {});
      proc.on('error', () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); } });
      proc.on('close', () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); } });
    } catch {
      if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
    }
  });
}

// Codex has no runtime discovery API — discover slash commands by reading the filesystem:
//   1. Built-in interactive commands (hardcoded from binary analysis)
//   2. Skills from ~/.codex/skills/ (user-installed + .system/)
//   3. Plugins from ~/.codex/.tmp/bundled-marketplaces/*/plugins/
function discoverCodexSlashCommands() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const skillsDir = path.join(codexHome, 'skills');
  const marketplacesDir = path.join(codexHome, '.tmp', 'bundled-marketplaces');
  const commands = new Set();

  // 1. Built-in interactive commands (from Codex binary analysis — stable across versions)
  const builtIn = ['compact', 'model', 'status', 'review', 'fork', 'new',
    'feedback', 'init', 'mcp', 'permissions', 'personality', 'rename', 'skills', 'statusline'];
  builtIn.forEach(c => commands.add(c));

  // 2. User-installed skills (directories under ~/.codex/skills/, excluding .system)
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '.system') continue;
      // Each skill dir may contain sub-skills (e.g. codex-primary-runtime/slides)
      if (entry.isDirectory()) {
        const subDir = path.join(skillsDir, entry.name);
        // Check for sub-directories (nested skills like codex-primary-runtime/slides)
        try {
          const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
          const hasSkillMd = subEntries.some(e => e.isFile() && e.name === 'SKILL.md');
          if (hasSkillMd) {
            commands.add(entry.name);
          } else {
            // Add sub-directories as individual skills (e.g. slides, spreadsheets)
            for (const sub of subEntries) {
              if (sub.isDirectory() && !sub.name.startsWith('.')) {
                const subSkillMd = path.join(subDir, sub.name, 'SKILL.md');
                if (fs.existsSync(subSkillMd)) {
                  commands.add(sub.name);
                }
              }
            }
          }
        } catch {}
      } else if (entry.isSymbolicLink()) {
        // Symlinked skills (e.g. frontend-design -> /path/to/skill)
        const targetSkillMd = path.join(skillsDir, entry.name, 'SKILL.md');
        try { if (fs.existsSync(targetSkillMd)) commands.add(entry.name); } catch {}
      }
    }
  } catch {}

  // 3. System skills (under ~/.codex/skills/.system/)
  try {
    const sysDir = path.join(skillsDir, '.system');
    const sysEntries = fs.readdirSync(sysDir, { withFileTypes: true });
    for (const entry of sysEntries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const skillMd = path.join(sysDir, entry.name, 'SKILL.md');
        try { if (fs.existsSync(skillMd)) commands.add(entry.name); } catch {}
      }
    }
  } catch {}

  // 4. Plugins (under bundled-marketplaces/*/plugins/)
  try {
    const mkDirs = fs.readdirSync(marketplacesDir, { withFileTypes: true });
    for (const mk of mkDirs) {
      if (!mk.isDirectory() || mk.name.startsWith('.')) continue;
      const pluginsDir = path.join(marketplacesDir, mk.name, 'plugins');
      try {
        const pluginEntries = fs.readdirSync(pluginsDir, { withFileTypes: true });
        for (const pe of pluginEntries) {
          if (!pe.isDirectory()) continue;
          // Read plugin.json for the plugin name
          const pluginJsonPath = path.join(pluginsDir, pe.name, '.codex-plugin', 'plugin.json');
          try {
            if (fs.existsSync(pluginJsonPath)) {
              const raw = fs.readFileSync(pluginJsonPath, 'utf8');
              const parsed = JSON.parse(raw);
              if (parsed.name) commands.add(parsed.name);
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  const result = [...commands];
  onSlashCommandsDiscovered('codex', result);
  return result;
}

// Pending compact retry metadata: sessionId -> { text: string, mode: string, reason: string, autoRetryCount: number }
const pendingCompactRetries = new Map();
const MAX_SERVER_QUEUED_MESSAGES = 10;


// Active processes: sessionId -> { pid, ws, fullText, toolCalls, segments, lastCost, tailer }
const activeProcesses = new Map();

// Track which session each ws is viewing: ws -> sessionId
const wsSessionMap = new Map();


function isWsOpen(ws) {
  return !!(ws && ws.readyState === 1);
}

function ensureProcessClients(entry) {
  if (!entry) return new Set();
  if (!(entry.clients instanceof Set)) entry.clients = new Set();
  if (isWsOpen(entry.ws)) entry.clients.add(entry.ws);
  return entry.clients;
}

function getConnectedProcessClients(entry) {
  const clients = ensureProcessClients(entry);
  const connected = [];
  for (const client of Array.from(clients)) {
    if (isWsOpen(client)) connected.push(client);
    else clients.delete(client);
  }
  if (entry && entry.ws && !isWsOpen(entry.ws)) entry.ws = null;
  return connected;
}

function getPrimaryProcessWs(entry) {
  if (!entry) return null;
  if (isWsOpen(entry.ws)) return entry.ws;
  const [first] = getConnectedProcessClients(entry);
  entry.ws = first || null;
  return entry.ws;
}

function isProcessRealtimeConnected(entry) {
  return !!getPrimaryProcessWs(entry);
}

function attachWebSocketToProcess(entry, ws) {
  if (!entry || !isWsOpen(ws)) return false;
  ensureProcessClients(entry).add(ws);
  if (!isWsOpen(entry.ws)) entry.ws = ws;
  entry.wsDisconnectTime = null;
  return true;
}

function detachWebSocketFromProcess(entry, ws, options = {}) {
  if (!entry || !ws) return false;
  const clients = ensureProcessClients(entry);
  const hadClient = clients.delete(ws);
  const wasPrimary = entry.ws === ws;
  if (wasPrimary) entry.ws = null;
  const nextPrimary = getPrimaryProcessWs(entry);
  if (!nextPrimary && (hadClient || wasPrimary) && options.markDisconnect === true) {
    entry.wsDisconnectTime = new Date().toISOString();
  }
  return hadClient || wasPrimary;
}

function sendRuntimeMessage(entry, data) {
  const clients = getConnectedProcessClients(entry);
  if (clients.length === 0) {
    if (entry) entry.ws = null;
    return false;
  }
  for (const client of clients) wsSend(client, data);
  if (entry && !isWsOpen(entry.ws)) entry.ws = clients[0] || null;
  return true;
}

function sendSessionListToProcessClients(entry, options = {}) {
  const clients = getConnectedProcessClients(entry);
  for (const client of clients) sendSessionList(client, options);
}

const sessionListCache = {
  expiresAt: 0,
  sessions: [],
};

const importedSessionIdsCache = {
  expiresAt: 0,
  ids: new Set(),
};

function invalidateSessionListCache() {
  sessionListCache.expiresAt = 0;
}

function invalidateImportedSessionIdsCache() {
  importedSessionIdsCache.expiresAt = 0;
  importedSessionIdsCache.ids = new Set();
}

function setActiveProcess(sessionId, entry) {
  activeProcesses.set(sessionId, entry);
  invalidateSessionListCache();
}

function removeActiveProcess(sessionId) {
  const removed = activeProcesses.delete(sessionId);
  if (removed) invalidateSessionListCache();
  return removed;
}

function execFileQuiet(command, args = []) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, maxBuffer: 1024 * 1024 }, (error) => {
      resolve({ ok: !error, error });
    });
  });
}

const DEFAULT_CLAUDE_MODEL_MAP = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

// Default fallback MODEL_MAP (overridden by model config at runtime)
let MODEL_MAP = { ...DEFAULT_CLAUDE_MODEL_MAP };

const CLAUDE_MODEL_MENU_ENTRIES = [
  {
    alias: 'default',
    label: '默认（推荐）',
    desc: '使用默认模型（当前为 Sonnet 4.6）',
    pricing: '输入/输出 $3 / $15 / 百万 Token',
  },
  {
    alias: 'sonnet[1m]',
    label: 'Sonnet（1M 上下文）',
    desc: 'Sonnet 4.6，适合长上下文会话',
    pricing: '输入/输出 $3 / $15 / 百万 Token',
  },
  {
    alias: 'opus',
    label: 'Opus',
    desc: 'Opus 4.6，复杂任务能力最强',
    pricing: '输入/输出 $5 / $25 / 百万 Token',
  },
  {
    alias: 'opus[1m]',
    label: 'Opus（1M 上下文）',
    desc: 'Opus 4.6，支持 1M 上下文，适合复杂任务',
    pricing: '输入/输出 $5 / $25 / 百万 Token',
  },
  {
    alias: 'haiku',
    label: 'Haiku',
    desc: 'Haiku 4.5，响应最快，适合快速问答',
    pricing: '输入/输出 $1 / $5 / 百万 Token',
  },
];

const VALID_AGENTS = new Set(['claude', 'codex']);

// === Models API fetch ===
let _modelCache = null; // { models: [{id, display_name}], fetchedAt: number, source: 'anthropic'|'openai' }

function resolveActiveApiCredentials() {
  // Check Claude-selected provider first
  try {
    const tpl = getClaudeSelectedTemplate(loadModelConfig());
    if (tpl && tpl.apiKey) {
      return {
        apiKey: tpl.apiKey,
        apiBase: tpl.apiBase || 'https://api.anthropic.com',
        upstreamType: tpl.upstreamType === 'anthropic' ? 'anthropic' : 'openai',
      };
    }
  } catch {}
  // Check ~/.claude/settings.json env block
  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    const env = settings.env || {};
    const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
    if (key) return { apiKey: key, apiBase: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', upstreamType: 'anthropic' };
  } catch {}
  // Fall back to process.env
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (key) return { apiKey: key, apiBase: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', upstreamType: 'anthropic' };
  return null;
}

function fetchModelsFromApi(credentials) {
  return new Promise((resolve, reject) => {
    const apiBase = credentials.apiBase || 'https://api.anthropic.com';
    const isAnthropic = credentials.upstreamType === 'anthropic';
    let spec;
    let url;
    try {
      spec = buildModelsRequestSpec(apiBase, credentials.apiKey, credentials.upstreamType);
      url = new URL(spec.fullUrl);
    } catch (error) {
      return reject(error);
    }
    url.searchParams.set('limit', '100');
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: {
        ...spec.headers,
        'content-type': 'application/json',
      },
    };
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(options, (res) => {
      let body = '';
      let bodyBytes = 0;
      res.on('data', (d) => {
        bodyBytes += d.length;
        if (bodyBytes > HTTP_BODY_MAX_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        body += d;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          const json = JSON.parse(body);
          // Anthropic format: { data: [{id, display_name, ...}] }
          // OpenAI-compat format: { data: [{id, object, ...}] }
          const raw = json.data || json.models || [];
          const models = raw
            .filter(m => typeof m.id === 'string' && m.id.toLowerCase().includes('claude'))
            .map(m => ({ id: m.id, display_name: m.display_name || m.id }));
          const source = isAnthropic ? 'anthropic' : 'openai';
          resolve({ models, source });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function getModelList() {
  const now = Date.now();
  if (_modelCache && now - _modelCache.fetchedAt < 3600_000) return _modelCache;
  const creds = resolveActiveApiCredentials();
  if (!creds) return null; // no credentials — caller uses hardcoded fallback
  try {
    const { models, source } = await fetchModelsFromApi(creds);
    if (models.length > 0) {
      _modelCache = { models, fetchedAt: now, source };
      return _modelCache;
    }
  } catch (e) {
    console.error('[model-api] fetch failed:', e.message);
  }
  return null; // caller uses hardcoded fallback
}

// === Model Config ===
const DEFAULT_MODEL_CONFIG = {
  mode: 'local',      // 'local' | 'custom'
  templates: [],      // array of { name, apiKey, apiBase, upstreamType, defaultModel, opusModel, sonnetModel, haikuModel }
  activeTemplate: '', // name of active template (for 'custom' mode)
};

const DEFAULT_CODEX_CONFIG = {
  mode: 'local',
  legacyMode: '',
  activeProfile: '',
  sharedTemplate: '',
  profiles: [],
  enableSearch: false,
  supportsSearch: false,
};
const CODEX_REASONING_EFFORTS = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'];

function normalizeCodexReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.includes(normalized) ? normalized : '';
}

function codexReasoningEffortLabel(value) {
  const labels = {
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
  };
  return labels[value] || '默认';
}

function normalizeModelTemplate(template) {
  const apiBase = String(template?.apiBase || '').trim();
  const name = String(template?.name || '').trim();
  const modelHints = [
    String(template?.defaultModel || '').trim(),
    String(template?.opusModel || '').trim(),
    String(template?.sonnetModel || '').trim(),
    String(template?.haikuModel || '').trim(),
  ].filter(Boolean);
  const combinedHints = `${name}\n${apiBase}\n${modelHints.join('\n')}`.toLowerCase();
  const looksLikeAnthropicProtocol = /(^|\b)claude-|anthropic|messages\b/.test(combinedHints);
  const looksLikeOpenAiProtocol = /(^|\b)(gpt-|o1|o3|o4|openai|responses\b|chat\/completions|\/v1\b)/.test(combinedHints);
  const upstreamType = template?.upstreamType === 'anthropic'
    ? (looksLikeOpenAiProtocol && !looksLikeAnthropicProtocol ? 'openai' : 'anthropic')
    : 'openai';
  return {
    name,
    apiKey: String(template?.apiKey || ''),
    apiBase,
    upstreamType,
    defaultModel: String(template?.defaultModel || '').trim(),
    opusModel: String(template?.opusModel || '').trim(),
    sonnetModel: String(template?.sonnetModel || '').trim(),
    haikuModel: String(template?.haikuModel || '').trim(),
  };
}

function normalizeModelTemplates(templates) {
  return Array.isArray(templates)
    ? templates.map(normalizeModelTemplate).filter((template) => template.name)
    : [];
}

function normalizeModelMode(mode) {
  return mode === 'custom' ? 'custom' : 'local';
}

function selectTemplateByName(templates, templateName) {
  const normalizedName = String(templateName || '').trim();
  if (!normalizedName) return null;
  return (Array.isArray(templates) ? templates : []).find((template) => template.name === normalizedName) || null;
}

function pickConfiguredTemplate(templates, preferredName, fallbackName = '') {
  return selectTemplateByName(templates, preferredName)
    || selectTemplateByName(templates, fallbackName)
    || (Array.isArray(templates) ? templates[0] || null : null);
}

function getClaudeSelectedTemplate(config = null) {
  const modelConfig = config || loadModelConfig();
  if (!modelConfig || normalizeModelMode(modelConfig.mode) !== 'custom') return null;
  return pickConfiguredTemplate(modelConfig.templates, modelConfig.activeTemplate);
}

function getCodexSelectedTemplate(codexConfig = null, modelConfig = null) {
  const resolvedCodexConfig = codexConfig || loadCodexConfig();
  const resolvedModelConfig = modelConfig || loadModelConfig();
  const templates = Array.isArray(resolvedModelConfig.templates) ? resolvedModelConfig.templates : [];
  const preferredName = String(resolvedCodexConfig?.sharedTemplate || '').trim();
  const fallbackName = !preferredName ? String(resolvedModelConfig.activeTemplate || '').trim() : '';
  return pickConfiguredTemplate(templates, preferredName, fallbackName);
}

function normalizeCodexProfile(profile) {
  return {
    name: String(profile?.name || '').trim(),
    apiKey: String(profile?.apiKey || ''),
    apiBase: String(profile?.apiBase || '').trim(),
    defaultModel: String(profile?.defaultModel || '').trim(),
  };
}

function normalizeCodexProfiles(profiles) {
  return Array.isArray(profiles)
    ? profiles.map(normalizeCodexProfile).filter((profile) => profile.name)
    : [];
}

function normalizeCodexMode(mode) {
  return mode === 'unified' || mode === 'shared' || mode === 'custom' ? 'unified' : 'local';
}

function resolveCodexLegacyMode(raw) {
  if (raw === 'custom' || raw === 'shared') return raw;
  return '';
}

function loadModelConfig() {
  const raw = readCachedJsonConfig(MODEL_CONFIG_PATH);
  if (!raw) return cloneJson(DEFAULT_MODEL_CONFIG);
  const templates = normalizeModelTemplates(raw.templates);
  const normalized = {
    mode: normalizeModelMode(raw.mode),
    activeTemplate: String(raw.activeTemplate || '').trim(),
    templates,
  };
  if (normalized.mode === 'custom' && !selectTemplateByName(templates, normalized.activeTemplate)) {
    normalized.activeTemplate = templates[0]?.name || '';
  }
  if (normalized.mode === 'local') {
    normalized.activeTemplate = '';
  }
  return normalized;
}

function saveModelConfig(config) {
  const normalized = {
    mode: normalizeModelMode(config?.mode),
    activeTemplate: String(config?.activeTemplate || '').trim(),
    templates: normalizeModelTemplates(config?.templates),
  };
  if (normalized.mode === 'custom' && !selectTemplateByName(normalized.templates, normalized.activeTemplate)) {
    normalized.activeTemplate = normalized.templates[0]?.name || '';
  }
  if (normalized.mode === 'local') {
    normalized.activeTemplate = '';
  }
  writeCachedJsonConfig(MODEL_CONFIG_PATH, normalized);
}

// === Projects Config ===
function loadProjectsConfig() {
  const raw = readCachedJsonConfig(PROJECTS_CONFIG_PATH);
  if (raw) {
    return { projects: Array.isArray(raw.projects) ? raw.projects : [] };
  }
  return { projects: [] };
}

function saveProjectsConfig(config) {
  writeCachedJsonConfig(PROJECTS_CONFIG_PATH, config);
}

function normalizeProjectPathKey(projectPath) {
  const raw = String(projectPath || '').trim();
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

function isSameOrChildProjectPath(parentPath, childPath) {
  const parent = normalizeProjectPathKey(parentPath);
  const child = normalizeProjectPathKey(childPath);
  if (!parent || !child) return false;
  if (parent === child) return true;
  const relativePath = path.relative(parent, child);
  return !!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function findBestProjectForPath(projects, targetPath) {
  const normalizedTargetPath = normalizeProjectPathKey(targetPath);
  if (!normalizedTargetPath) return null;
  let matchedProject = null;
  let matchedPathLength = -1;
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project?.path || !isSameOrChildProjectPath(project.path, normalizedTargetPath)) continue;
    const normalizedProjectPath = normalizeProjectPathKey(project.path);
    if (normalizedProjectPath.length > matchedPathLength) {
      matchedProject = project;
      matchedPathLength = normalizedProjectPath.length;
    }
  }
  return matchedProject;
}

function ensureProjectForPath(projectPath, options = {}) {
  const normalizedProjectPath = normalizeProjectPathKey(projectPath);
  if (!normalizedProjectPath) return { project: null, created: false };
  const config = loadProjectsConfig();
  const existing = findBestProjectForPath(config.projects, normalizedProjectPath);
  if (existing) {
    let changed = false;
    if (normalizeProjectPathKey(existing.path) === normalizedProjectPath && existing.path !== normalizedProjectPath) {
      existing.path = normalizedProjectPath;
      changed = true;
    }
    if (changed) saveProjectsConfig(config);
    return { project: existing, created: false };
  }
  const project = {
    id: options.id || crypto.randomUUID(),
    name: String(options.name || path.basename(normalizedProjectPath) || normalizedProjectPath).trim(),
    path: normalizedProjectPath,
  };
  config.projects.push(project);
  saveProjectsConfig(config);
  return { project, created: true };
}

function loadCodexConfig() {
  const raw = readCachedJsonConfig(CODEX_CONFIG_PATH);
  if (raw) {
    return {
      mode: normalizeCodexMode(raw.mode),
      legacyMode: resolveCodexLegacyMode(raw.legacyMode || raw.mode),
      activeProfile: raw.activeProfile || '',
      sharedTemplate: String(raw.sharedTemplate || '').trim(),
      profiles: normalizeCodexProfiles(raw.profiles),
      enableSearch: false,
      supportsSearch: false,
      storedEnableSearch: !!raw.enableSearch,
    };
  }
  return cloneJson(DEFAULT_CODEX_CONFIG);
}

function saveCodexConfig(config) {
  writeCachedJsonConfig(CODEX_CONFIG_PATH, {
    mode: normalizeCodexMode(config.mode),
    legacyMode: resolveCodexLegacyMode(config.legacyMode || config.mode),
    activeProfile: config.activeProfile || '',
    sharedTemplate: String(config.sharedTemplate || '').trim(),
    profiles: normalizeCodexProfiles(config.profiles),
    enableSearch: false,
  });
}

function getCodexConfigMasked() {
  const config = loadCodexConfig();
  const effectiveTemplate = normalizeCodexMode(config.mode) === 'unified'
    ? getCodexSelectedTemplate(config, loadModelConfig())
    : null;
  return {
    mode: normalizeCodexMode(config.mode),
    legacyMode: resolveCodexLegacyMode(config.legacyMode),
    activeProfile: config.activeProfile || '',
    sharedTemplate: effectiveTemplate?.name || config.sharedTemplate || '',
    profiles: (config.profiles || []).map((profile) => ({
      name: profile.name,
      apiKey: maskSecret(profile.apiKey),
      apiBase: profile.apiBase || '',
      defaultModel: profile.defaultModel || '',
    })),
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: !!config.storedEnableSearch,
  };
}

function maskSecret(str) {
  if (!str || str.length <= 12) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function mergeSecretField(nextValue, currentValue) {
  const next = String(nextValue || '');
  if (next && !next.includes('****')) return next;
  return String(currentValue || '');
}

function getModelConfigMasked() {
  const config = loadModelConfig();
  return {
    mode: config.mode,
    activeTemplate: config.activeTemplate,
    templates: (config.templates || []).map(t => ({
      name: t.name,
      apiKey: maskSecret(t.apiKey),
      apiBase: t.apiBase || '',
      upstreamType: t.upstreamType || 'openai',
      defaultModel: t.defaultModel || '',
      opusModel: t.opusModel || '',
      sonnetModel: t.sonnetModel || '',
      haikuModel: t.haikuModel || '',
    })),
  };
}

const CODEX_LOCAL_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_LOCAL_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function parseTomlStringLiteral(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  return value.split(/\s+#/)[0].trim();
}

function readTopLevelTomlString(text, key) {
  const beforeSections = String(text || '').split(/^\s*\[/m)[0] || '';
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.+?)\\s*$`, 'm');
  const match = beforeSections.match(re);
  return match ? parseTomlStringLiteral(match[1]) : '';
}

function findTomlSection(text, sectionName) {
  const source = String(text || '');
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, 'm');
  const match = re.exec(source);
  if (!match) return null;
  const start = match.index;
  const bodyStart = match.index + match[0].length;
  const rest = source.slice(bodyStart);
  const nextMatch = /^\s*\[/m.exec(rest);
  const end = nextMatch ? bodyStart + nextMatch.index : source.length;
  return { start, bodyStart, end, header: match[0] };
}

function readTomlSectionString(text, sectionName, key) {
  const section = findTomlSection(text, sectionName);
  if (!section) return '';
  const body = String(text || '').slice(section.bodyStart, section.end);
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.+?)\\s*$`, 'm');
  const match = body.match(re);
  return match ? parseTomlStringLiteral(match[1]) : '';
}

function setTomlSectionString(text, sectionName, key, value) {
  let source = String(text || '');
  let section = findTomlSection(source, sectionName);
  if (!section) {
    source = `${source.replace(/\s*$/, '')}\n\n[${sectionName}]\n`;
    section = findTomlSection(source, sectionName);
  }
  if (!section) return source;
  const before = source.slice(0, section.bodyStart);
  let body = source.slice(section.bodyStart, section.end);
  const after = source.slice(section.end);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldRe = new RegExp(`(^\\s*${escapedKey}\\s*=).*$`, 'm');
  const nextLine = `\n${key} = ${tomlString(value)}`;
  if (fieldRe.test(body)) {
    body = body.replace(fieldRe, `$1 ${tomlString(value)}`);
  } else {
    body = body.endsWith('\n') ? `${body}${key} = ${tomlString(value)}\n` : `${body}${nextLine}\n`;
  }
  return before + body + after;
}

function readCodexLocalAuthKey(envKey = 'OPENAI_API_KEY') {
  const keyName = String(envKey || 'OPENAI_API_KEY').trim() || 'OPENAI_API_KEY';
  try {
    const auth = JSON.parse(fs.readFileSync(CODEX_LOCAL_AUTH_PATH, 'utf8'));
    const fileKey = String(auth?.[keyName] || auth?.OPENAI_API_KEY || auth?.api_key || '').trim();
    if (fileKey) return fileKey;
  } catch {}
  return String(process.env[keyName] || '').trim();
}

function resolveCodexLocalBridgeSource() {
  let configText = '';
  try { configText = fs.readFileSync(CODEX_LOCAL_CONFIG_PATH, 'utf8'); } catch { return { mode: 'local' }; }
  const provider = readTopLevelTomlString(configText, 'model_provider');
  const model = readTopLevelTomlString(configText, 'model');
  if (!provider) return { mode: 'local' };
  const sectionName = `model_providers.${provider}`;
  const apiBase = readTomlSectionString(configText, sectionName, 'base_url');
  const envKey = readTomlSectionString(configText, sectionName, 'env_key') || 'OPENAI_API_KEY';
  const apiKey = readCodexLocalAuthKey(envKey);
  if (!apiBase || !apiKey) return { mode: 'local' };
  return {
    mode: 'local_bridge',
    name: `本地 Codex: ${provider}`,
    provider,
    apiKey,
    apiBase,
    upstreamType: 'openai',
    defaultModel: model || '',
    configText,
  };
}

function writeCodexLocalBridgeConfig(source, bridge) {
  fs.mkdirSync(CODEX_RUNTIME_HOME, { recursive: true });
  let configToml = String(source.configText || '');
  configToml = setTomlSectionString(configToml, `model_providers.${source.provider}`, 'base_url', bridge.openaiBaseUrl);
  configToml = setTomlSectionString(configToml, `model_providers.${source.provider}`, 'env_key', 'OPENAI_API_KEY');
  configToml = `${configToml.replace(/\s*$/, '')}\n\n# webcoding_bridge_base_url = ${tomlString(bridge.openaiBaseUrl)}\n`;
  fs.writeFileSync(path.join(CODEX_RUNTIME_HOME, 'config.toml'), configToml);
  const localInstruction = path.join(path.dirname(CODEX_LOCAL_CONFIG_PATH), 'instruction.md');
  const runtimeInstruction = path.join(CODEX_RUNTIME_HOME, 'instruction.md');
  try {
    if (fs.existsSync(localInstruction)) fs.copyFileSync(localInstruction, runtimeInstruction);
  } catch {}
}

function resolveCodexCustomProfile(config) {
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  const activeProfile = profiles.find((profile) => profile.name === config?.activeProfile) || null;
  if (!activeProfile) {
    return { error: 'Codex 独立配置缺少已激活的配置项。请先在设置中创建并激活一个 API 配置。' };
  }
  if (!activeProfile.apiKey || !activeProfile.apiBase) {
    return { error: `Codex 配置「${activeProfile.name}」缺少 API Key 或 API Base URL。` };
  }
  return {
    mode: 'custom',
    name: activeProfile.name,
    apiKey: activeProfile.apiKey,
    apiBase: activeProfile.apiBase,
    upstreamType: 'openai',
    defaultModel: activeProfile.defaultModel || '',
  };
}

function resolveCodexUnifiedSource(config) {
  const modelConfig = loadModelConfig();
  // Fallback priority:
  // 1) Codex selected provider
  // 2) legacy Claude-selected provider (for old configs that never chose a separate Codex provider)
  // 3) first available provider
  // 4) legacy custom profile
  // 5) legacy shared(local Claude credentials)
  const template = getCodexSelectedTemplate(config, modelConfig);

  if (template) {
    if (!template.apiKey || !template.apiBase) {
      if (config?.legacyMode === 'custom') return resolveCodexCustomProfile(config);
      return { error: `AI 提供商配置「${template.name}」缺少 API Key 或 API Base URL。` };
    }
    return {
      mode: 'unified',
      name: template.name,
      apiKey: template.apiKey,
      apiBase: template.apiBase,
      upstreamType: template.upstreamType === 'anthropic' ? 'anthropic' : 'openai',
      defaultModel: template.defaultModel || '',
    };
  }

  if (config?.legacyMode === 'custom') {
    return resolveCodexCustomProfile(config);
  }

  if (config?.legacyMode === 'shared') {
    const localClaude = readClaudeSettingsCredentials();
    if (localClaude) {
      return {
        mode: 'unified',
        name: '当前 Claude Code 配置',
        apiKey: localClaude.apiKey,
        apiBase: localClaude.apiBase,
        upstreamType: 'anthropic',
        defaultModel: localClaude.defaultModel || '',
      };
    }
  }

  return { error: '当前没有可用的 AI 提供商配置。请先在设置中创建至少一个可用提供商。' };
}

function resolveCodexActiveSource(config) {
  if (!config || normalizeCodexMode(config.mode) === 'local') return { mode: 'local' };
  return resolveCodexUnifiedSource(config);
}

function getCodexRuntimeFingerprint(config) {
  const source = resolveCodexActiveSource(config || loadCodexConfig());
  if (!source || source.mode === 'local') {
    const localBridgeSource = resolveCodexLocalBridgeSource();
    return JSON.stringify({
      runtimeVersion: 6,
      mode: localBridgeSource?.mode === 'local_bridge' ? 'local_bridge' : 'local',
      sourceName: localBridgeSource?.mode === 'local_bridge' ? String(localBridgeSource.name || '').trim() : '',
      apiBase: localBridgeSource?.mode === 'local_bridge' ? String(localBridgeSource.apiBase || '').trim().replace(/\/+$/, '') : '',
      configFingerprint: fileContentFingerprint(CODEX_LOCAL_CONFIG_PATH),
      authFingerprint: fileContentFingerprint(CODEX_LOCAL_AUTH_PATH),
    });
  }
  if (source.error) return `error:${source.error}`;
  return JSON.stringify({
    runtimeVersion: 6,
    mode: 'remote',
    sourceName: String(source.name || '').trim(),
    apiBase: String(source.apiBase || '').trim().replace(/\/+$/, ''),
    upstreamType: String(source.upstreamType || 'openai').toLowerCase(),
  });
}

function buildCodexRuntimeResult(source, bridge) {
  return {
    mode: 'custom',
    homeDir: CODEX_RUNTIME_HOME,
    apiKey: bridge.token,
    apiBase: bridge.openaiBaseUrl,
    bridgeToken: bridge.token,
    profileName: source.name,
    defaultModel: bridge.defaultModel || source.defaultModel || '',
  };
}

function prepareCodexCustomRuntime(config) {
  let source = resolveCodexActiveSource(config);
  if (source?.error) return source;
  if (!source || source.mode === 'local') {
    source = resolveCodexLocalBridgeSource();
    if (!source || source.mode !== 'local_bridge') return { mode: 'local' };
    try {
      const bridge = ensureBridgeRuntimeForTemplate(source, { forceNewToken: true });
      writeCodexLocalBridgeConfig(source, bridge);
      return buildCodexRuntimeResult(source, bridge);
    } catch (error) {
      return { error: error.message || '本地 Codex API 桥接初始化失败' };
    }
  }

  let bridge = null;
  try {
    bridge = ensureBridgeRuntimeForTemplate(source, { forceNewToken: true });
  } catch (error) {
    return { error: error.message || '本地 API 中间件初始化失败' };
  }

  fs.mkdirSync(CODEX_RUNTIME_HOME, { recursive: true });
  const configToml = [
    '# Generated by webcoding. Codex startup is also forced via CLI -c overrides.',
    `# bridge_base_url = ${tomlString(bridge.openaiBaseUrl)}`,
    `# bridge_api_key = ${tomlString(bridge.token)}`,
    bridge.defaultModel ? `model = ${tomlString(bridge.defaultModel)}` : null,
    'preferred_auth_method = "apikey"',
    'model_provider = "openai_compat"',
    '',
    '[model_providers.openai_compat]',
    `name = ${tomlString(source.name || 'AI Provider')}`,
    `base_url = ${tomlString(bridge.openaiBaseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ].filter((line) => line !== null).join('\n');
  fs.writeFileSync(path.join(CODEX_RUNTIME_HOME, 'config.toml'), configToml);

  return buildCodexRuntimeResult(source, bridge);
}

function normalizeCodexModelEntries(rawModels) {
  const entries = [];
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    const value = String(raw?.slug || raw?.id || raw?.name || raw || '').trim();
    if (!value) continue;
    const visibility = String(raw?.visibility || '').toLowerCase();
    if (visibility && visibility !== 'list') continue;
    const label = String(raw?.display_name || raw?.name || value).trim() || value;
    const desc = String(raw?.description || '').trim() || 'Codex 模型';
    entries.push({
      value,
      label,
      desc,
      priority: Number.isFinite(raw?.priority) ? raw.priority : 999,
    });
  }
  entries.sort((a, b) => (a.priority - b.priority) || a.label.localeCompare(b.label));
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    deduped.push({
      value: entry.value,
      label: entry.label,
      desc: entry.desc,
    });
  }
  return deduped;
}

function loadCodexModelsCacheEntries(cachePath) {
  try {
    if (!cachePath) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const entries = normalizeCodexModelEntries(parsed.models);
    if (!entries.length) return null;
    return {
      entries,
      source: 'codex-cache',
      fetchedAt: parsed.fetched_at || null,
      clientVersion: parsed.client_version || null,
    };
  } catch {
    return null;
  }
}

function getCodexModelsCachePaths(config) {
  const paths = [];
  if (config?.mode && config.mode !== 'local') {
    paths.push(path.join(CODEX_RUNTIME_HOME, 'models_cache.json'));
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    paths.push(path.join(home, '.codex', 'models_cache.json'));
  }
  return paths;
}

function buildVersionedEndpointUrl(apiBase, endpoint) {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  const normalizedEndpoint = String(endpoint || '').trim().replace(/^\/+/, '');
  if (!base) throw new Error('缺少 API Base URL');
  if (!normalizedEndpoint) throw new Error('缺少 API endpoint');
  if (base.toLowerCase().endsWith(`/${normalizedEndpoint.toLowerCase()}`)) return base;
  return /\/v\d+(?:\.\d+)?$/i.test(base) ? `${base}/${normalizedEndpoint}` : `${base}/v1/${normalizedEndpoint}`;
}

function buildFetchModelsUrl(apiBase) {
  return buildVersionedEndpointUrl(apiBase, 'models');
}

function buildModelsRequestSpec(apiBase, apiKey, upstreamType = 'openai') {
  const fullUrl = buildFetchModelsUrl(apiBase);
  const headers = upstreamType === 'anthropic'
    ? {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }
    : {
        Authorization: `Bearer ${apiKey}`,
      };
  return { fullUrl, headers };
}

function isTlsHandshakeFailure(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return /eproto|handshake failure|alert handshake failure|protocol version|ssl3_read_bytes|tlsv1 alert protocol version/.test(text);
}

function getClaudeFallbackModels() {
  const models = [];
  for (const alias of ['opus', 'sonnet', 'haiku']) {
    const value = MODEL_MAP[alias] || DEFAULT_CLAUDE_MODEL_MAP[alias];
    if (value) models.push(value);
  }
  return Array.from(new Set(models));
}

function fetchCodexModelsFromApi(profile) {
  return new Promise((resolve, reject) => {
    const base = String(profile?.apiBase || '').trim().replace(/\/$/, '');
    const token = String(profile?.apiKey || '').trim();
    const upstreamType = profile?.upstreamType === 'anthropic' ? 'anthropic' : 'openai';
    if (!base || !token) {
      return resolve(null);
    }
    let url;
    let spec;
    try {
      spec = buildModelsRequestSpec(base, token, upstreamType);
      url = new URL(spec.fullUrl);
    } catch (error) {
      return reject(error);
    }
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: {
        ...spec.headers,
        'content-type': 'application/json',
      },
    };
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(options, (res) => {
      let body = '';
      let bodyBytes = 0;
      res.on('data', (chunk) => {
        bodyBytes += chunk.length;
        if (bodyBytes > HTTP_BODY_MAX_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(body);
          const entries = normalizeCodexModelEntries(json.data || json.models || []);
          resolve(entries.length ? { entries, source: 'provider-api' } : null);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function getCodexModelMenuPayload(session) {
  const currentFull = session?.model || '';
  const current = currentFull || 'default';
  const modelConfig = loadModelConfig();
  const codexConfig = loadCodexConfig();
  const activeTemplate = normalizeCodexMode(codexConfig.mode) === 'unified'
    ? getCodexSelectedTemplate(codexConfig, modelConfig)
    : null;
  let dynamicEntries = [];
  let source = null;

  if (activeTemplate?.apiBase && activeTemplate?.apiKey) {
    try {
      const fetched = await fetchCodexModelsFromApi(activeTemplate);
      if (fetched?.entries?.length) {
        dynamicEntries = fetched.entries;
        source = fetched.source;
      }
    } catch (error) {
      plog('WARN', 'codex_model_fetch_failed', { error: error.message });
    }
  }

  if (!dynamicEntries.length) {
    for (const cachePath of getCodexModelsCachePaths(codexConfig)) {
      const cached = loadCodexModelsCacheEntries(cachePath);
      if (cached?.entries?.length) {
        dynamicEntries = cached.entries;
        source = cached.source;
        break;
      }
    }
  }

  const entries = [{
    value: 'default',
    label: '默认模型（Codex）',
    desc: activeTemplate?.defaultModel
      ? `使用当前 Codex 默认模型（${activeTemplate.defaultModel}）`
      : '使用当前 Codex 默认模型',
  }];
  const seen = new Set(entries.map((entry) => entry.value));
  if (activeTemplate?.defaultModel && !seen.has(activeTemplate.defaultModel)) {
    seen.add(activeTemplate.defaultModel);
    entries.push({
      value: activeTemplate.defaultModel,
      label: activeTemplate.defaultModel,
      desc: '当前 AI 提供商默认模型（Codex）',
    });
  }
  for (const entry of dynamicEntries) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    entries.push(entry);
  }
  if (currentFull && !seen.has(currentFull)) {
    entries.push({
      value: currentFull,
      label: currentFull,
      desc: '当前会话模型',
    });
  }

  return {
    type: 'model_list',
    agent: 'codex',
    entries,
    current,
    currentFull,
    source,
  };
}

function extractClaudeModelMapFromEnv(env) {
  const map = {};
  if (env?.ANTHROPIC_DEFAULT_OPUS_MODEL) map.opus = String(env.ANTHROPIC_DEFAULT_OPUS_MODEL).trim();
  if (env?.ANTHROPIC_DEFAULT_SONNET_MODEL) map.sonnet = String(env.ANTHROPIC_DEFAULT_SONNET_MODEL).trim();
  if (env?.ANTHROPIC_DEFAULT_HAIKU_MODEL) map.haiku = String(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).trim();
  if (!map.opus && env?.ANTHROPIC_MODEL) map.opus = String(env.ANTHROPIC_MODEL).trim();
  return Object.keys(map).length > 0 ? map : null;
}

function loadClaudeLocalModelMap() {
  const settingsEnv = readClaudeSettingsEnv();
  const settingsMap = extractClaudeModelMapFromEnv(settingsEnv);
  if (settingsMap) return settingsMap;

  try {
    const p = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude.json');
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const claudeJsonMap = extractClaudeModelMapFromEnv(raw?.env || {});
      if (claudeJsonMap) return claudeJsonMap;
    }
  } catch {}

  const processMap = extractClaudeModelMapFromEnv(process.env || {});
  return processMap;
}

function fileContentFingerprint(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return 'missing';
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return 'unreadable';
  }
}

// Apply model config to runtime MODEL_MAP only (env vars are injected per-spawn, not here)
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'settings.json');
const SETTINGS_API_KEYS = ['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_REASONING_MODEL'];
const LOCAL_CLAUDE_BRIDGE_BASE_RE = /^http:\/\/127\.0\.0\.1:\d+\/anthropic\/?$/i;

function readClaudeSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readClaudeSettingsSnapshot() {
  const exists = fs.existsSync(CLAUDE_SETTINGS_PATH);
  return {
    exists,
    settings: readClaudeSettings(),
  };
}

function writeClaudeSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    writeJsonAtomic(CLAUDE_SETTINGS_PATH, settings && typeof settings === 'object' ? settings : {});
  } catch {}
}

function deleteClaudeSettingsFile() {
  try {
    fs.unlinkSync(CLAUDE_SETTINGS_PATH);
  } catch {}
}

function stripManagedClaudeSettingsEnv(env) {
  const cleanedEnv = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (!SETTINGS_API_KEYS.includes(k)) cleanedEnv[k] = v;
  }
  return cleanedEnv;
}

function extractManagedClaudeSettingsEnv(env) {
  const managedEnv = {};
  for (const key of SETTINGS_API_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(env || {}, key)) continue;
    const value = env[key];
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized) managedEnv[key] = normalized;
  }
  return managedEnv;
}

function buildManagedClaudeSettingsEnv(tpl, bridge) {
  const managedEnv = {};
  const defaultModel = String(tpl?.defaultModel || '').trim();
  const opusModel = String(tpl?.opusModel || defaultModel || '').trim();
  const sonnetModel = String(tpl?.sonnetModel || defaultModel || '').trim();
  const haikuModel = String(tpl?.haikuModel || defaultModel || '').trim();

  if (bridge?.token) {
    managedEnv.ANTHROPIC_API_KEY = String(bridge.token).trim();
  } else if (tpl?.apiKey) {
    managedEnv.ANTHROPIC_API_KEY = String(tpl.apiKey).trim();
  }
  if (bridge?.anthropicBaseUrl) managedEnv.ANTHROPIC_BASE_URL = String(bridge.anthropicBaseUrl).trim();
  else if (tpl?.apiBase) managedEnv.ANTHROPIC_BASE_URL = String(tpl.apiBase).trim();
  if (defaultModel) managedEnv.ANTHROPIC_MODEL = defaultModel;
  if (opusModel) managedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
  if (sonnetModel) managedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
  if (haikuModel) managedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
  return managedEnv;
}

function managedClaudeSettingsEnvEquals(left, right) {
  const normalizedLeft = extractManagedClaudeSettingsEnv(left);
  const normalizedRight = extractManagedClaudeSettingsEnv(right);
  const keys = new Set([...Object.keys(normalizedLeft), ...Object.keys(normalizedRight)]);
  for (const key of keys) {
    if (String(normalizedLeft[key] || '') !== String(normalizedRight[key] || '')) return false;
  }
  return true;
}

function looksLikeManagedClaudeBridgeEnv(env, bridgeTokens) {
  const managedEnv = extractManagedClaudeSettingsEnv(env);
  const tokenSet = new Set(
    Array.isArray(bridgeTokens)
      ? bridgeTokens.map((token) => String(token || '').trim()).filter(Boolean)
      : [String(bridgeTokens || '').trim()].filter(Boolean)
  );
  if (!tokenSet.size) return false;
  return tokenSet.has(String(managedEnv.ANTHROPIC_API_KEY || '').trim())
    && LOCAL_CLAUDE_BRIDGE_BASE_RE.test(String(managedEnv.ANTHROPIC_BASE_URL || ''));
}

function loadClaudeSettingsBackup() {
  const raw = readCachedJsonConfig(CLAUDE_SETTINGS_BACKUP_PATH);
  if (!raw || typeof raw !== 'object') return null;
  if (Number(raw.version) !== 2) {
    clearClaudeSettingsBackup();
    return null;
  }
  return {
    version: 2,
    exists: raw.exists !== false,
    settings: raw.settings && typeof raw.settings === 'object'
      ? cloneJson(raw.settings)
      : null,
    capturedAt: String(raw.capturedAt || '').trim() || null,
  };
}

function saveClaudeSettingsBackup(snapshot) {
  writeCachedJsonConfig(CLAUDE_SETTINGS_BACKUP_PATH, {
    version: 2,
    exists: !!snapshot?.exists,
    settings: snapshot?.exists && snapshot?.settings && typeof snapshot.settings === 'object'
      ? cloneJson(snapshot.settings)
      : null,
    capturedAt: new Date().toISOString(),
  });
}

function clearClaudeSettingsBackup() {
  deleteCachedJsonConfig(CLAUDE_SETTINGS_BACKUP_PATH);
}

function ensureClaudeSettingsBackupForCustom(currentSnapshot, nextManagedEnv, bridge) {
  if (loadClaudeSettingsBackup()) return;
  const settings = currentSnapshot?.settings || {};
  const currentManagedEnv = extractManagedClaudeSettingsEnv(settings?.env || {});
  const bridgeTokens = bridge?.token ? [bridge.token] : listBridgeRuntimeTokens();
  const alreadyManaged = managedClaudeSettingsEnvEquals(currentManagedEnv, nextManagedEnv)
    || looksLikeManagedClaudeBridgeEnv(currentManagedEnv, bridgeTokens);
  if (alreadyManaged) return;
  saveClaudeSettingsBackup({
    exists: !!currentSnapshot?.exists,
    settings,
  });
}

function readClaudeSettingsEnv() {
  const settings = readClaudeSettings();
  return settings?.env && typeof settings.env === 'object' ? settings.env : {};
}

function readClaudeSettingsCredentials() {
  const env = readClaudeSettingsEnv();
  const apiKey = String(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const apiBase = String(env.ANTHROPIC_BASE_URL || '').trim();
  if (!apiKey || !apiBase) return null;
  return {
    apiKey,
    apiBase,
    defaultModel: String(env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL || '').trim(),
  };
}

function getClaudeRuntimeFingerprint(config = null) {
  const modelConfig = config || loadModelConfig();
  const tpl = getClaudeSelectedTemplate(modelConfig);
  if (tpl) {
    return JSON.stringify({
      runtimeVersion: 3,
      mode: 'custom',
      templateName: String(tpl.name || '').trim(),
      apiBase: String(tpl.apiBase || '').trim().replace(/\/+$/, ''),
      upstreamType: String(tpl.upstreamType === 'anthropic' ? 'anthropic' : 'openai'),
    });
  }

  return JSON.stringify({
    runtimeVersion: 1,
    mode: 'local',
    settingsFingerprint: fileContentFingerprint(CLAUDE_SETTINGS_PATH),
    claudeJsonFingerprint: fileContentFingerprint(path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude.json')),
  });
}

function applyCustomTemplateToSettings(tpl, existingBridge) {
  let bridge = existingBridge || null;
  if (!bridge) {
    try {
      bridge = ensureBridgeRuntimeForTemplate(tpl);
    } catch {
      bridge = null;
    }
  }
  const currentSnapshot = readClaudeSettingsSnapshot();
  const settings = cloneJson(currentSnapshot.settings) || {};
  const managedEnv = buildManagedClaudeSettingsEnv(tpl, bridge);
  ensureClaudeSettingsBackupForCustom(currentSnapshot, managedEnv, bridge);
  settings.env = {
    ...stripManagedClaudeSettingsEnv(settings.env),
    ...managedEnv,
  };
  writeClaudeSettings(settings);
}

function refreshCodexGeneratedRuntimeSnapshot(context = 'runtime_refresh') {
  try {
    const result = prepareCodexCustomRuntime(loadCodexConfig());
    if (result?.error) {
      plog('WARN', context, { error: result.error });
    }
  } catch (error) {
    plog('WARN', context, { error: error.message });
  }
}

function restoreManagedClaudeSettings(previousTemplate = null, options = {}) {
  const backup = loadClaudeSettingsBackup();
  if (!backup && options.onlyIfBackupExists) return false;

  const settings = readClaudeSettings();
  const cleanedEnv = stripManagedClaudeSettingsEnv(settings.env);

  const writeMergedClaudeSettings = (nextSettings) => {
    const normalized = nextSettings && typeof nextSettings === 'object'
      ? cloneJson(nextSettings)
      : {};
    const env = normalized?.env && typeof normalized.env === 'object'
      ? Object.fromEntries(Object.entries(normalized.env).filter(([, value]) => value !== undefined && value !== null && String(value).trim()))
      : null;
    if (env && Object.keys(env).length > 0) normalized.env = env;
    else delete normalized.env;
    if (Object.keys(normalized).length > 0) writeClaudeSettings(normalized);
    else deleteClaudeSettingsFile();
  };

  if (backup) {
    const previousManagedEnv = extractManagedClaudeSettingsEnv(backup.settings?.env || {});
    const nextSettings = settings && typeof settings === 'object' ? cloneJson(settings) : {};
    nextSettings.env = {
      ...cleanedEnv,
      ...previousManagedEnv,
    };
    writeMergedClaudeSettings(nextSettings);
    clearClaudeSettingsBackup();
    return true;
  }

  const currentManagedEnv = extractManagedClaudeSettingsEnv(settings.env);
  if (!Object.keys(currentManagedEnv).length || !previousTemplate) return false;

  const fallbackManagedEnv = buildManagedClaudeSettingsEnv(previousTemplate, null);
  const bridgeTokens = listBridgeRuntimeTokens();
  const shouldClear = managedClaudeSettingsEnvEquals(currentManagedEnv, fallbackManagedEnv)
    || looksLikeManagedClaudeBridgeEnv(currentManagedEnv, bridgeTokens);
  if (!shouldClear) return false;

  settings.env = cleanedEnv;
  writeMergedClaudeSettings(settings);
  return true;
}

function applyModelConfig() {
  const config = loadModelConfig();
  const tpl = getClaudeSelectedTemplate(config);
  if (tpl) {
    const defaultModel = String(tpl.defaultModel || '').trim();
    if (tpl.opusModel || defaultModel) MODEL_MAP.opus = tpl.opusModel || defaultModel;
    if (tpl.sonnetModel || defaultModel) MODEL_MAP.sonnet = tpl.sonnetModel || defaultModel;
    if (tpl.haikuModel || defaultModel) MODEL_MAP.haiku = tpl.haikuModel || defaultModel;
    if (defaultModel || tpl.opusModel || tpl.sonnetModel || tpl.haikuModel) return;
  }
  // mode === 'local': read model names from local Claude settings / env overrides
  const localMap = loadClaudeLocalModelMap();
  if (localMap) {
    if (localMap.opus) MODEL_MAP.opus = localMap.opus;
    if (localMap.sonnet) MODEL_MAP.sonnet = localMap.sonnet;
    if (localMap.haiku) MODEL_MAP.haiku = localMap.haiku;
  }
}

// Apply on startup
applyModelConfig();
try {
  const activeTemplate = getActiveUnifiedTemplate();
  if (activeTemplate) {
    const bridge = ensureBridgeRuntimeForTemplate(activeTemplate);
    applyCustomTemplateToSettings(activeTemplate, bridge);
  } else {
    restoreManagedClaudeSettings(null, { onlyIfBackupExists: true });
  }
  refreshCodexGeneratedRuntimeSnapshot('codex_runtime_refresh_on_startup');
} catch (error) {
  plog('WARN', 'bridge_startup_init_failed', { error: error.message });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function getPublicAssetVersion(name) {
  try {
    const stat = fs.statSync(path.join(PUBLIC_ROOT, name));
    return Math.trunc(stat.mtimeMs).toString(36);
  } catch {
    return 'dev';
  }
}

function renderIndexHtml() {
  const indexPath = path.join(PUBLIC_ROOT, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const styleVersion = getPublicAssetVersion('style.css');
  const appVersion = getPublicAssetVersion('app.js');
  return html
    .replace('href="style.css"', `href="style.css?v=${styleVersion}"`)
    .replace('src="app.js"', `src="app.js?v=${appVersion}"`);
}

// === Utility Functions ===

function wsSend(ws, data) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(data));
  } catch (error) {
    plog('WARN', 'ws_send_failed', {
      type: data?.type || null,
      error: error?.message || String(error),
    });
  }
}

function isPathInside(filePath, rootDir) {
  const relative = path.relative(rootDir, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeWorkspaceCwd(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw || !path.isAbsolute(raw)) return null;
  const resolved = path.resolve(raw);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function resolvePathWithinCwd(cwd, targetPath = '') {
  const root = normalizeWorkspaceCwd(cwd);
  if (!root) throw new Error('当前目录无效');
  const raw = String(targetPath || '').trim();
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(root, raw));
  if (!isPathInside(resolved, root)) throw new Error('文件不在当前目录内');
  return { root, resolved };
}

function isLikelyTextFile(filePath, size = 0) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base).toLowerCase();
  if (TEXT_CONTEXT_EXTENSIONS.has(ext) || TEXT_CONTEXT_EXTENSIONS.has(base)) return true;
  if (size > MAX_CONTEXT_FILE_SIZE) return false;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(4096, Math.max(1, size || 4096)));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      for (let i = 0; i < bytes; i += 1) {
        if (buffer[i] === 0) return false;
      }
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function getFileMime(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'text/markdown; charset=utf-8';
  if (ext === '.txt' || ext === '.log' || ext === '.gitignore' || ext === '.env') return 'text/plain; charset=utf-8';
  if (ext === '.csv') return 'text/csv; charset=utf-8';
  if (ext === '.tsv') return 'text/tab-separated-values; charset=utf-8';
  if (ext === '.json' || ext === '.jsonl') return 'application/json; charset=utf-8';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.xls') return 'application/vnd.ms-excel';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.avif') return 'image/avif';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function getFileViewType(filePath, stat) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.csv') return 'csv';
  if (ext === '.tsv') return 'tsv';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.docx') return 'docx';
  if (ext === '.pdf') return 'pdf';
  if (FILE_VIEW_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.json') return 'json';
  if (FILE_VIEW_CODE_EXTENSIONS.has(ext) || FILE_VIEW_CODE_EXTENSIONS.has(base)) return 'code';
  if (isLikelyTextFile(filePath, stat?.size || 0)) return 'text';
  return 'binary';
}

function fileViewLanguage(filePath, viewType) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base).toLowerCase().replace(/^\./, '');
  if (viewType === 'markdown') return 'markdown';
  if (viewType === 'json') return 'json';
  if (viewType === 'csv') return 'csv';
  if (viewType === 'tsv') return 'tsv';
  if (base === 'dockerfile' || ext === 'dockerfile') return 'dockerfile';
  if (ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'jsx') return 'javascript';
  if (ext === 'tsx') return 'typescript';
  if (ext === 'htm') return 'html';
  if (ext === 'yml') return 'yaml';
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return 'bash';
  if (ext === 'cc' || ext === 'cpp' || ext === 'hpp') return 'cpp';
  if (ext === 'py') return 'python';
  if (ext === 'rb') return 'ruby';
  if (ext === 'rs') return 'rust';
  if (ext === 'go') return 'go';
  if (ext === 'kt' || ext === 'kts') return 'kotlin';
  return ext || 'plaintext';
}

function buildFileIdentity(root, filePath, stat, viewType) {
  return {
    ok: true,
    type: viewType,
    name: path.basename(filePath),
    path: filePath,
    relativePath: path.relative(root, filePath) || path.basename(filePath),
    size: stat.size,
    mime: getFileMime(filePath),
    language: fileViewLanguage(filePath, viewType),
  };
}

function readTextFileForView(filePath, stat) {
  if (stat.size > FILE_VIEW_TEXT_MAX_SIZE) {
    const err = new Error('文本文件超过 1MB，不能直接预览');
    err.statusCode = 413;
    throw err;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeWorkbookCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function buildWorkbookView(filePath, stat) {
  if (stat.size > FILE_VIEW_BINARY_MAX_SIZE) {
    const err = new Error('表格文件超过 20MB，不能直接预览');
    err.statusCode = 413;
    throw err;
  }
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
  const activeSheet = sheetNames[0] || '';
  const sheet = activeSheet ? workbook.Sheets[activeSheet] : null;
  let rows = [];
  let totalRows = 0;
  let totalCols = 0;
  if (sheet && sheet['!ref']) {
    const range = XLSX.utils.decode_range(sheet['!ref']);
    totalRows = Math.max(0, range.e.r - range.s.r + 1);
    totalCols = Math.max(0, range.e.c - range.s.c + 1);
    const limitedRange = {
      s: range.s,
      e: {
        r: Math.min(range.e.r, range.s.r + FILE_VIEW_TABLE_MAX_ROWS - 1),
        c: Math.min(range.e.c, range.s.c + FILE_VIEW_TABLE_MAX_COLS - 1),
      },
    };
    rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
      raw: false,
      range: XLSX.utils.encode_range(limitedRange),
    }).map((row) => Array.isArray(row) ? row.slice(0, FILE_VIEW_TABLE_MAX_COLS).map(normalizeWorkbookCell) : []);
  }
  return {
    sheets: sheetNames,
    activeSheet,
    rows,
    truncated: totalRows > FILE_VIEW_TABLE_MAX_ROWS || totalCols > FILE_VIEW_TABLE_MAX_COLS,
    totalRows,
    totalCols,
    displayedRows: rows.length,
    displayedCols: rows.reduce((max, row) => Math.max(max, row.length), 0),
  };
}

async function buildDocxView(filePath, stat) {
  if (stat.size > FILE_VIEW_BINARY_MAX_SIZE) {
    const err = new Error('Word 文件超过 20MB，不能直接预览');
    err.statusCode = 413;
    throw err;
  }
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.convertToHtml({ buffer });
  return {
    html: result?.value || '',
    messages: Array.isArray(result?.messages) ? result.messages.map((m) => String(m.message || '')).filter(Boolean) : [],
  };
}

function jsonErrorResponse(res, err, fallbackMessage = '请求失败') {
  return jsonResponse(res, err?.statusCode || 400, { ok: false, message: err?.message || fallbackMessage });
}

function buildFileTree(root, currentPath, depth, state) {
  if (state.count >= FILE_TREE_MAX_ENTRIES) return [];
  let entries;
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  const items = [];
  for (const entry of entries) {
    if (state.count >= FILE_TREE_MAX_ENTRIES) break;
    if (FILE_TREE_IGNORED_NAMES.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') continue;
    const abs = path.join(currentPath, entry.name);
    let lst;
    try { lst = fs.lstatSync(abs); } catch { continue; }
    if (lst.isSymbolicLink()) continue;
    const rel = path.relative(root, abs) || entry.name;
    const item = {
      name: entry.name,
      path: abs,
      relativePath: rel,
      type: entry.isDirectory() ? 'directory' : 'file',
    };
    if (entry.isDirectory()) {
      item.children = depth > 1 ? buildFileTree(root, abs, depth - 1, state) : [];
    } else if (entry.isFile()) {
      item.size = lst.size;
      item.isText = isLikelyTextFile(abs, lst.size);
      item.tooLarge = lst.size > MAX_CONTEXT_FILE_SIZE;
    } else {
      continue;
    }
    state.count += 1;
    items.push(item);
  }
  return items;
}

function normalizeContextFileRefs(fileRefs, cwd) {
  const refs = Array.isArray(fileRefs) ? fileRefs.slice(0, MAX_CONTEXT_FILE_REFS) : [];
  if (refs.length === 0) return { refs: [], error: '' };
  const seen = new Set();
  const normalized = [];
  let totalSize = 0;
  for (const ref of refs) {
    const rawPath = String(ref?.path || ref?.relativePath || '').trim();
    if (!rawPath) continue;
    let root;
    let resolved;
    try { ({ root, resolved } = resolvePathWithinCwd(cwd, rawPath)); }
    catch (err) { return { refs: [], error: err.message || '引用路径无效' }; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let stat;
    try { stat = fs.statSync(resolved); }
    catch { return { refs: [], error: `无法读取引用: ${path.basename(resolved)}` }; }
    const relativePath = path.relative(root, resolved) || path.basename(resolved);
    if (stat.isDirectory()) {
      normalized.push({
        type: 'directory',
        path: resolved,
        relativePath,
        size: 0,
      });
      continue;
    }
    if (!stat.isFile()) return { refs: [], error: `只能引用文件或目录: ${relativePath}` };
    if (stat.size > MAX_CONTEXT_FILE_SIZE) return { refs: [], error: `文件超过 256KB: ${relativePath}` };
    if (!isLikelyTextFile(resolved, stat.size)) return { refs: [], error: `只能引用文本文件: ${relativePath}` };
    totalSize += stat.size;
    if (totalSize > MAX_CONTEXT_FILES_TOTAL_SIZE) return { refs: [], error: '引用文件总大小不能超过 1MB' };
    let content;
    try { content = fs.readFileSync(resolved, 'utf8'); }
    catch { return { refs: [], error: `读取失败: ${relativePath}` }; }
    normalized.push({
      type: 'file',
      path: resolved,
      relativePath,
      size: stat.size,
      content,
    });
  }
  return { refs: normalized, error: '' };
}

function buildContextFilePrompt(text, fileRefs) {
  const normalizedText = String(text || '');
  if (!Array.isArray(fileRefs) || fileRefs.length === 0) return normalizedText;
  const blocks = fileRefs.map((ref) => {
    const safePath = String(ref.relativePath || ref.path || '').replace(/"/g, '&quot;');
    if (ref.type === 'directory') {
      return `<directory path="${safePath}" />`;
    }
    return [
      `<file path="${safePath}">`,
      ref.content,
      '</file>',
    ].join('\n');
  }).join('\n\n');
  return `下面是用户从当前工作目录引用的文件和目录。目录引用表示用户选中了整个目录本身；不要把它理解为已经展开了目录下所有文件内容，如需查看请基于路径自行读取。

${blocks}

用户问题：
${normalizedText}`;
}

function fileRefHistoryMeta(ref) {
  return {
    type: ref.type === 'directory' ? 'directory' : 'file',
    path: ref.path,
    relativePath: ref.relativePath,
    size: ref.type === 'directory' ? 0 : ref.size,
  };
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9\-]/g, '');
}

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${sanitizeId(id)}.json`);
}

function runDir(sessionId) {
  return path.join(SESSIONS_DIR, `${sanitizeId(sessionId)}-run`);
}

function attachmentDataPath(id, ext = '') {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}${ext}`);
}

function attachmentMetaPath(id) {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}.json`);
}

function safeFilename(name) {
  return String(name || 'image')
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'image';
}

function extFromMime(mime) {
  switch (mime) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '';
  }
}

function detectMimeFromMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';
  return null;
}


function isGeneratedImageExtension(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
}

function generatedImageRootEntries() {
  return [
    ['codex', GENERATED_IMAGES_ROOT],
    ['cache', GENERATED_MESSAGE_IMAGES_ROOT],
  ];
}

function generatedImageUrlForFile(filePath) {
  const absPath = path.resolve(String(filePath || ''));
  if (!isGeneratedImageExtension(absPath)) return '';
  for (const [rootKey, rootDir] of generatedImageRootEntries()) {
    const root = path.resolve(rootDir);
    if (!isPathInside(absPath, root)) continue;
    const rel = path.relative(root, absPath).split(path.sep).filter(Boolean);
    if (!rel.length || rel.some((part) => part === '..' || part.includes('\0'))) return '';
    return `/api/generated-image/${encodeURIComponent(rootKey)}/${rel.map((part) => encodeURIComponent(part)).join('/')}`;
  }
  return '';
}

function findCodexGeneratedImageByCallId(callId, preferredThreadId = '') {
  const safeCallId = String(callId || '').trim();
  if (!safeCallId || !/^[A-Za-z0-9_-]+$/.test(safeCallId)) return null;
  const root = path.resolve(GENERATED_IMAGES_ROOT);
  const filename = `${safeCallId}.png`;
  const preferred = String(preferredThreadId || '').trim();
  if (preferred && /^[A-Za-z0-9_-]+$/.test(preferred)) {
    const direct = path.resolve(root, preferred, filename);
    if (isPathInside(direct, root) && fs.existsSync(direct)) return direct;
  }
  try {
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(dirent.name)) continue;
      const candidate = path.resolve(root, dirent.name, filename);
      if (isPathInside(candidate, root) && fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function imageBufferFromCodexResult(result) {
  let raw = typeof result === 'string' ? result.trim() : '';
  if (!raw) return null;
  const dataUrlMatch = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
  if (dataUrlMatch) raw = dataUrlMatch[2].trim();
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) return null;
  try {
    const buffer = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

function persistGeneratedImageFromResult(result, sessionId, callId) {
  const buffer = imageBufferFromCodexResult(result);
  if (!buffer) return null;
  const detectedMime = detectMimeFromMagic(buffer);
  if (!IMAGE_MIME_TYPES.has(detectedMime)) return null;
  const ext = extFromMime(detectedMime) || '.png';
  const safeSessionId = sanitizeId(sessionId || 'unknown') || 'unknown';
  const rawCallId = String(callId || '').trim();
  const safeCallId = /^[A-Za-z0-9_-]+$/.test(rawCallId) ? rawCallId : crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const dir = path.join(GENERATED_MESSAGE_IMAGES_ROOT, safeSessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.resolve(dir, `${safeCallId}${ext}`);
  const root = path.resolve(GENERATED_MESSAGE_IMAGES_ROOT);
  if (!isPathInside(filePath, root)) return null;
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
  return filePath;
}

function createGeneratedImageSegmentFromCodexEvent(codexEvent = {}, options = {}) {
  const callId = String(codexEvent.call_id || '').trim();
  const preferredThreadId = String(options.threadId || options.runtimeSessionId || '').trim();
  const existingPath = findCodexGeneratedImageByCallId(callId, preferredThreadId);
  const filePath = existingPath || persistGeneratedImageFromResult(codexEvent.result, options.sessionId || preferredThreadId || 'unknown', callId);
  const src = filePath ? generatedImageUrlForFile(filePath) : '';
  if (!src) return null;
  const detectedMime = extFromMime('image/png') ? 'image/png' : 'image/png';
  return {
    id: callId || null,
    src,
    mime: detectedMime,
    alt: 'Generated image',
    prompt: codexEvent.revised_prompt || '',
  };
}

function loadAttachmentMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(attachmentMetaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function saveAttachmentMeta(meta) {
  writeJsonAtomic(attachmentMetaPath(meta.id), meta);
}

function removeAttachmentById(id) {
  const meta = loadAttachmentMeta(id);
  const paths = new Set([attachmentMetaPath(id)]);
  if (meta?.path) paths.add(meta.path);
  for (const filePath of paths) {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
}

function currentAttachmentState(meta) {
  if (!meta) return 'missing';
  const expiresAtMs = new Date(meta.expiresAt || 0).getTime();
  if (expiresAtMs && Date.now() > expiresAtMs) return 'expired';
  if (!meta.path || !fs.existsSync(meta.path)) return 'missing';
  return 'available';
}

let lastAttachmentCleanupAt = 0;

function normalizeMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const normalized = [];
  for (const attachment of attachments) {
    const id = sanitizeId(attachment?.id || '');
    if (!id) continue;
    const meta = loadAttachmentMeta(id);
    const state = currentAttachmentState(meta);
    if (state === 'expired') removeAttachmentById(id);
    normalized.push({
      id,
      kind: 'image',
      filename: meta?.filename || attachment?.filename || 'image',
      mime: meta?.mime || attachment?.mime || 'image/png',
      size: meta?.size || attachment?.size || 0,
      createdAt: meta?.createdAt || attachment?.createdAt || null,
      expiresAt: meta?.expiresAt || attachment?.expiresAt || null,
      storageState: state === 'available' ? 'available' : 'expired',
    });
  }
  return normalized;
}

function resolveMessageAttachments(attachments) {
  const resolved = [];
  for (const attachment of normalizeMessageAttachments(attachments)) {
    if (attachment.storageState !== 'available') continue;
    const meta = loadAttachmentMeta(attachment.id);
    if (!meta?.path || !fs.existsSync(meta.path)) continue;
    resolved.push({
      ...attachment,
      path: meta.path,
    });
  }
  return resolved;
}

function cleanupExpiredAttachments() {
  const now = Date.now();
  if (now - lastAttachmentCleanupAt < ATTACHMENT_CLEANUP_THROTTLE_MS) return;
  lastAttachmentCleanupAt = now;
  try {
    const files = fs.readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      const meta = loadAttachmentMeta(id);
      if (!meta || currentAttachmentState(meta) === 'expired') {
        removeAttachmentById(id);
      }
    }
  } catch {}
}

function collectSessionAttachmentIds(session) {
  const ids = new Set();
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      const id = sanitizeId(attachment?.id || '');
      if (id) ids.add(id);
    }
  }
  return Array.from(ids);
}

function extractBearerToken(req) {
  const authHeader = String(req.headers.authorization || '');
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

function jsonResponse(res, statusCode, payload) {
  writeHeadWithSecurity(res, statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(payload));
}

const INITIAL_HISTORY_COUNT = 12;
const HISTORY_CHUNK_SIZE = 24;
const CONTEXT_REPLAY_RECENT_MESSAGE_LIMIT = 6;
const CONTEXT_REPLAY_MESSAGE_CHAR_LIMIT = 900;
const CONTEXT_REPLAY_RECENT_CHAR_BUDGET = 4200;
const CONTEXT_REPLAY_MIN_DETAILED_SUMMARY_MESSAGES = 4;
const CONTEXT_REPLAY_MIN_DETAILED_SUMMARY_CHARS = 280;
const CONTEXT_REPLAY_FIELD_CHAR_LIMIT = 240;
const CONTEXT_REPLAY_MAX_COMPLETED_ITEMS = 3;
const CONTEXT_REPLAY_MAX_CONSTRAINT_ITEMS = 4;
const CONTEXT_REPLAY_MAX_EXACT_ITEMS = 4;
const CONTEXT_REPLAY_SUMMARY_MAX_CHARS = 3200;
const HANDOFF_AI_TRANSCRIPT_CHAR_BUDGET = 90000;
const HANDOFF_AI_MESSAGE_CHAR_LIMIT = 2400;
const HANDOFF_AI_SUMMARY_MAX_CHARS = 12000;
const HANDOFF_AI_TIMEOUT_MS = 180000;

function normalizeAgent(agent) {
  return VALID_AGENTS.has(agent) ? agent : 'claude';
}

const VALID_PERMISSION_MODES = new Set(['default', 'plan', 'yolo']);
const CLAUDE_ROOT_YOLO_DOWNGRADE_MESSAGE = '检测到 Webcoding 正以 root 用户运行，Claude 的 YOLO 模式会触发 CLI 报错；已自动降级为默认模式。';

function isRootProcessOnUnix() {
  return process.platform !== 'win32'
    && typeof process.getuid === 'function'
    && process.getuid() === 0;
}

function normalizePermissionModeInput(mode) {
  return VALID_PERMISSION_MODES.has(mode) ? mode : 'yolo';
}

function resolvePermissionModeForAgent(agent, mode) {
  const requestedMode = normalizePermissionModeInput(mode);
  if (normalizeAgent(agent) === 'claude' && requestedMode === 'yolo' && isRootProcessOnUnix()) {
    return {
      mode: 'default',
      requestedMode,
      downgraded: true,
      message: CLAUDE_ROOT_YOLO_DOWNGRADE_MESSAGE,
    };
  }
  return {
    mode: requestedMode,
    requestedMode,
    downgraded: false,
    message: '',
  };
}

function normalizeRuntimeContextEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const runtimeId = entry.runtimeId ? String(entry.runtimeId) : null;
  const runtimeFingerprint = entry.runtimeFingerprint ? String(entry.runtimeFingerprint) : null;
  const descriptor = entry.descriptor && typeof entry.descriptor === 'object' && !Array.isArray(entry.descriptor)
    ? cloneJson(entry.descriptor)
    : null;
  const updatedAt = entry.updatedAt ? String(entry.updatedAt) : null;
  const model = String(entry.model || '').trim();
  if (!runtimeId && !runtimeFingerprint && !descriptor && !updatedAt) return null;
  return {
    runtimeId,
    runtimeFingerprint,
    updatedAt,
    model,
    descriptor,
    legacy: !!entry.legacy,
  };
}

function normalizeRuntimeApiBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeRuntimeUpstreamType(value) {
  return String(value === 'anthropic' ? 'anthropic' : (value || 'openai')).toLowerCase();
}

function buildRuntimeChannelIdentityDescriptor(agent, descriptor = null) {
  const normalizedAgent = normalizeAgent(agent);
  const mode = String(descriptor?.mode || 'local').toLowerCase();
  if (mode === 'legacy') {
    return {
      mode: 'legacy',
      runtimeIdHint: String(descriptor?.runtimeIdHint || ''),
      runtimeFingerprintHint: String(descriptor?.runtimeFingerprintHint || ''),
    };
  }
  if (mode === 'error') {
    return {
      mode: 'error',
      error: String(descriptor?.error || ''),
    };
  }
  if (mode === 'local') {
    return { mode: 'local' };
  }
  if (normalizedAgent === 'codex') {
    return {
      mode: 'remote',
      sourceName: String(descriptor?.sourceName || ''),
      apiBase: normalizeRuntimeApiBase(descriptor?.apiBase),
      upstreamType: normalizeRuntimeUpstreamType(descriptor?.upstreamType),
    };
  }
  return {
    mode: 'custom',
    templateName: String(descriptor?.templateName || ''),
    apiBase: normalizeRuntimeApiBase(descriptor?.apiBase),
    upstreamType: normalizeRuntimeUpstreamType(descriptor?.upstreamType),
  };
}

function normalizeRuntimeFingerprintForComparison(agent, fingerprint) {
  const raw = String(fingerprint || '').trim();
  if (!raw) return null;
  if (raw.startsWith('error:')) {
    return { mode: 'error', error: raw.slice('error:'.length) };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { raw };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { raw };
  }
  const mode = String(parsed.mode || 'local').toLowerCase();
  if (mode === 'local') {
    if (normalizeAgent(agent) === 'codex') {
      return {
        mode: 'local',
        configFingerprint: String(parsed.configFingerprint || ''),
        authFingerprint: String(parsed.authFingerprint || ''),
      };
    }
    return {
      mode: 'local',
      settingsFingerprint: String(parsed.settingsFingerprint || ''),
      claudeJsonFingerprint: String(parsed.claudeJsonFingerprint || ''),
    };
  }
  if (mode === 'error') {
    return { mode: 'error', error: String(parsed.error || '') };
  }
  return buildRuntimeChannelIdentityDescriptor(agent, parsed);
}

function runtimeFingerprintsCompatible(agent, left, right) {
  const normalizedLeft = normalizeRuntimeFingerprintForComparison(agent, left);
  const normalizedRight = normalizeRuntimeFingerprintForComparison(agent, right);
  if (!normalizedLeft || !normalizedRight) return false;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function runtimeChannelDescriptorsCompatible(agent, left, right) {
  const normalizedLeft = buildRuntimeChannelIdentityDescriptor(agent, left);
  const normalizedRight = buildRuntimeChannelIdentityDescriptor(agent, right);
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function ensureRuntimeContextStore(session) {
  if (!session || typeof session !== 'object') {
    return { claude: {}, codex: {} };
  }
  const store = session.runtimeContexts && typeof session.runtimeContexts === 'object' && !Array.isArray(session.runtimeContexts)
    ? session.runtimeContexts
    : {};
  if (!store.claude || typeof store.claude !== 'object' || Array.isArray(store.claude)) store.claude = {};
  if (!store.codex || typeof store.codex !== 'object' || Array.isArray(store.codex)) store.codex = {};
  session.runtimeContexts = store;
  return store;
}

function currentSessionModelOverride(session) {
  return String(session?.model || '').trim();
}

function buildClaudeRuntimeChannelDescriptor(session, options = {}) {
  const modelConfig = options.modelConfig || loadModelConfig();
  const explicitModel = currentSessionModelOverride(session);
  const tpl = getClaudeSelectedTemplate(modelConfig);
  if (tpl) {
    return {
      mode: 'custom',
      templateName: String(tpl.name || ''),
      apiBase: String(tpl.apiBase || ''),
      upstreamType: String(tpl.upstreamType === 'anthropic' ? 'anthropic' : 'openai'),
      defaultModel: String(tpl.defaultModel || ''),
      explicitModel,
    };
  }
  return {
    mode: 'local',
    explicitModel,
  };
}

function buildCodexRuntimeChannelDescriptor(session, options = {}) {
  const codexConfig = options.codexConfig || loadCodexConfig();
  const explicitModel = currentSessionModelOverride(session);
  const source = resolveCodexActiveSource(codexConfig);
  if (!source || source.mode === 'local') {
    return {
      mode: 'local',
      explicitModel,
    };
  }
  if (source.error) {
    return {
      mode: 'error',
      error: String(source.error || ''),
      explicitModel,
    };
  }
  return {
    mode: String(source.mode || 'unified'),
    sourceName: String(source.name || ''),
    apiBase: String(source.apiBase || ''),
    upstreamType: String(source.upstreamType || 'openai'),
    defaultModel: String(source.defaultModel || ''),
    explicitModel,
  };
}

function buildRuntimeChannelDescriptor(session, agent, options = {}) {
  const normalizedAgent = normalizeAgent(agent || session?.agent);
  if (normalizedAgent === 'codex') return buildCodexRuntimeChannelDescriptor(session, options);
  return buildClaudeRuntimeChannelDescriptor(session, options);
}

function buildRuntimeChannelKey(agent, descriptor) {
  const normalizedAgent = normalizeAgent(agent);
  const identityDescriptor = buildRuntimeChannelIdentityDescriptor(normalizedAgent, descriptor);
  const digest = crypto.createHash('sha1')
    .update(JSON.stringify(identityDescriptor))
    .digest('hex');
  return `${normalizedAgent}:${digest}`;
}

function getLegacyRuntimeMirror(session, agent) {
  if (!session) return { runtimeId: null, runtimeFingerprint: null };
  if (normalizeAgent(agent || session?.agent) === 'codex') {
    return {
      runtimeId: session.codexThreadId ? String(session.codexThreadId) : null,
      runtimeFingerprint: session.codexRuntimeFingerprint ? String(session.codexRuntimeFingerprint) : null,
    };
  }
  return {
    runtimeId: session.claudeSessionId ? String(session.claudeSessionId) : null,
    runtimeFingerprint: session.claudeRuntimeFingerprint ? String(session.claudeRuntimeFingerprint) : null,
  };
}

function listRuntimeContextEntries(session, agent) {
  const store = ensureRuntimeContextStore(session)[normalizeAgent(agent || session?.agent)] || {};
  return Object.entries(store)
    .map(([key, rawEntry]) => ({ key, entry: normalizeRuntimeContextEntry(rawEntry) }))
    .filter((item) => item.entry)
    .sort((a, b) => {
      const aTs = itemTimestampMs(a.entry?.updatedAt);
      const bTs = itemTimestampMs(b.entry?.updatedAt);
      return bTs - aTs;
    });
}

function itemTimestampMs(iso) {
  const ms = iso ? Date.parse(iso) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function currentAgentRuntimeFingerprint(agent, options = {}) {
  const normalizedAgent = normalizeAgent(agent);
  if (normalizedAgent === 'codex') {
    return getCodexRuntimeFingerprint(options.codexConfig);
  }
  return getClaudeRuntimeFingerprint(options.modelConfig);
}

function canAdoptLegacyRuntimeForCurrentChannel(agent, currentDescriptor, legacy, options = {}) {
  if (!legacy?.runtimeId) return false;
  const currentFingerprint = currentAgentRuntimeFingerprint(agent, options);
  if (legacy.runtimeFingerprint && currentFingerprint) {
    return runtimeFingerprintsCompatible(agent, legacy.runtimeFingerprint, currentFingerprint);
  }
  if (legacy.runtimeFingerprint) return false;
  return currentDescriptor?.mode === 'local';
}

function buildLegacyRuntimeChannelDescriptor(session, agent, _currentDescriptor, legacy) {
  return {
    mode: 'legacy',
    legacy: true,
    importedFrom: String(session?.importedFrom || ''),
    runtimeIdHint: String(legacy?.runtimeId || ''),
    runtimeFingerprintHint: String(legacy?.runtimeFingerprint || ''),
    explicitModel: currentSessionModelOverride(session),
    agent: normalizeAgent(agent),
  };
}

function ensureLegacyRuntimeContextPreserved(session, agent, options = {}) {
  if (!session) return;
  const normalizedAgent = normalizeAgent(agent || session?.agent);
  const legacy = getLegacyRuntimeMirror(session, normalizedAgent);
  if (!legacy.runtimeId) return;
  const existing = listRuntimeContextEntries(session, normalizedAgent)
    .find((item) => item.entry?.runtimeId === legacy.runtimeId);
  if (existing) return;

  const store = ensureRuntimeContextStore(session)[normalizedAgent];
  const currentDescriptor = buildRuntimeChannelDescriptor(session, normalizedAgent, options);
  const useCurrentChannel = canAdoptLegacyRuntimeForCurrentChannel(normalizedAgent, currentDescriptor, legacy, options);
  const descriptor = useCurrentChannel
    ? currentDescriptor
    : buildLegacyRuntimeChannelDescriptor(session, normalizedAgent, currentDescriptor, legacy);
  const key = buildRuntimeChannelKey(normalizedAgent, descriptor);
  const normalized = normalizeRuntimeContextEntry({
    runtimeId: legacy.runtimeId,
    runtimeFingerprint: legacy.runtimeFingerprint,
    updatedAt: session.updated || session.created || new Date().toISOString(),
    model: currentSessionModelOverride(session),
    descriptor,
    legacy: !useCurrentChannel,
  });
  if (normalized) {
    store[key] = normalized;
  }
}

function getRuntimeSessionState(session, options = {}) {
  const normalizedAgent = normalizeAgent(options.agent || session?.agent);
  if (!session) {
    return {
      agent: normalizedAgent,
      key: options.channelKey || null,
      descriptor: options.channelDescriptor || null,
      entry: null,
      store: null,
    };
  }

  ensureRuntimeContextStore(session);
  ensureLegacyRuntimeContextPreserved(session, normalizedAgent, options);

  const descriptor = options.channelDescriptor || buildRuntimeChannelDescriptor(session, normalizedAgent, options);
  const key = options.channelKey || buildRuntimeChannelKey(normalizedAgent, descriptor);
  const store = ensureRuntimeContextStore(session)[normalizedAgent];
  let entry = normalizeRuntimeContextEntry(store[key]);

  if (!entry) {
    const migrated = listRuntimeContextEntries(session, normalizedAgent)
      .find((item) => item.key !== key && runtimeChannelDescriptorsCompatible(normalizedAgent, descriptor, item.entry?.descriptor || null));
    if (migrated?.entry) {
      entry = normalizeRuntimeContextEntry({
        ...migrated.entry,
        descriptor,
        updatedAt: migrated.entry.updatedAt || session.updated || session.created || new Date().toISOString(),
      });
      if (entry) {
        store[key] = entry;
        delete store[migrated.key];
      }
    }
  }

  if (!entry && options.create) {
    entry = normalizeRuntimeContextEntry({
      runtimeId: null,
      runtimeFingerprint: null,
      updatedAt: session.updated || session.created || new Date().toISOString(),
      model: currentSessionModelOverride(session),
      descriptor,
      legacy: false,
    });
  }

  if (entry) {
    if (!entry.descriptor) entry.descriptor = cloneJson(descriptor);
    if (!entry.updatedAt) entry.updatedAt = session.updated || session.created || new Date().toISOString();
    entry.model = currentSessionModelOverride(session);
    store[key] = entry;
  }

  return {
    agent: normalizedAgent,
    key,
    descriptor,
    entry,
    store,
  };
}

function syncLegacyRuntimeMirror(session) {
  if (!session || typeof session !== 'object') return;
  const agent = getSessionAgent(session);
  const state = getRuntimeSessionState(session, { agent });
  if (agent === 'codex') {
    session.codexThreadId = state.entry?.runtimeId || null;
    session.codexRuntimeFingerprint = state.entry?.runtimeFingerprint || null;
    session.claudeSessionId = null;
    session.claudeRuntimeFingerprint = null;
  } else {
    session.claudeSessionId = state.entry?.runtimeId || null;
    session.claudeRuntimeFingerprint = state.entry?.runtimeFingerprint || null;
    session.codexThreadId = null;
    session.codexRuntimeFingerprint = null;
  }
}

function setRuntimeSessionState(session, updates = {}, options = {}) {
  if (!session) return null;
  const state = getRuntimeSessionState(session, { ...options, create: true });
  if (!state.store) return null;
  const nextEntry = {
    ...(state.entry || {}),
    runtimeId: Object.prototype.hasOwnProperty.call(updates, 'runtimeId')
      ? (updates.runtimeId ? String(updates.runtimeId) : null)
      : (state.entry?.runtimeId || null),
    runtimeFingerprint: Object.prototype.hasOwnProperty.call(updates, 'runtimeFingerprint')
      ? (updates.runtimeFingerprint ? String(updates.runtimeFingerprint) : null)
      : (state.entry?.runtimeFingerprint || null),
    updatedAt: new Date().toISOString(),
    model: currentSessionModelOverride(session),
    descriptor: cloneJson(updates.channelDescriptor || state.descriptor),
    legacy: false,
  };
  const normalized = normalizeRuntimeContextEntry(nextEntry);
  if (normalized) {
    state.store[state.key] = normalized;
  } else {
    delete state.store[state.key];
  }
  syncLegacyRuntimeMirror(session);
  return normalized;
}

function getRuntimeSessionId(session, options = {}) {
  if (!session) return null;
  const state = getRuntimeSessionState(session, options);
  syncLegacyRuntimeMirror(session);
  return state.entry?.runtimeId || null;
}

function getRuntimeSessionFingerprint(session, options = {}) {
  if (!session) return null;
  const state = getRuntimeSessionState(session, options);
  return state.entry?.runtimeFingerprint || null;
}

function setRuntimeSessionId(session, runtimeId, options = {}) {
  return setRuntimeSessionState(session, { runtimeId }, options);
}

function setRuntimeSessionFingerprint(session, runtimeFingerprint, options = {}) {
  return setRuntimeSessionState(session, { runtimeFingerprint }, options);
}

function clearRuntimeSessionId(session, options = {}) {
  if (!session) return;
  const normalizedAgent = normalizeAgent(options.agent || session?.agent);
  ensureRuntimeContextStore(session);
  ensureLegacyRuntimeContextPreserved(session, normalizedAgent, options);
  const clearAllChannels = options.allChannels !== false && !options.currentOnly;
  if (clearAllChannels) {
    session.runtimeContexts[normalizedAgent] = {};
  } else {
    const state = getRuntimeSessionState(session, options);
    if (state.store && state.key) {
      delete state.store[state.key];
    }
  }
  syncLegacyRuntimeMirror(session);
}

function getFallbackRuntimeSessionState(session, options = {}) {
  if (!session) return null;
  const normalizedAgent = normalizeAgent(options.agent || session?.agent);
  ensureLegacyRuntimeContextPreserved(session, normalizedAgent, options);
  const currentState = getRuntimeSessionState(session, options);
  const excludedKey = options.excludeChannelKey || currentState.key;
  const fallback = listRuntimeContextEntries(session, normalizedAgent)
    .find((item) => item.entry?.runtimeId && item.key !== excludedKey);
  if (!fallback) return null;
  return {
    agent: normalizedAgent,
    key: fallback.key,
    descriptor: fallback.entry?.descriptor || null,
    entry: fallback.entry,
  };
}

function getAllRuntimeSessionIds(session, agent, options = {}) {
  if (!session) return [];
  const normalizedAgent = normalizeAgent(agent || session?.agent);
  ensureLegacyRuntimeContextPreserved(session, normalizedAgent, options);
  return Array.from(new Set(
    listRuntimeContextEntries(session, normalizedAgent)
      .map((item) => item.entry?.runtimeId || null)
      .filter(Boolean)
  ));
}

function sessionHasRuntimeId(session, agent, runtimeId, options = {}) {
  if (!runtimeId) return false;
  return getAllRuntimeSessionIds(session, agent, options).includes(String(runtimeId));
}

function getPreferredRuntimeSessionId(session, agent, options = {}) {
  if (!session) return null;
  const current = getRuntimeSessionId(session, { ...options, agent });
  if (current) return current;
  const fallback = getFallbackRuntimeSessionState(session, { ...options, agent });
  return fallback?.entry?.runtimeId || null;
}


function normalizeQueuedMessageAttachments(attachments) {
  return normalizeMessageAttachments(Array.isArray(attachments) ? attachments.slice(0, MAX_MESSAGE_ATTACHMENTS) : []);
}

function normalizeQueuedMessageFileRefs(fileRefs) {
  if (!Array.isArray(fileRefs)) return [];
  return fileRefs.slice(0, MAX_CONTEXT_FILE_REFS).map((ref) => {
    if (!ref || typeof ref !== 'object') return null;
    const relativePath = String(ref.relativePath || ref.path || '').trim();
    if (!relativePath) return null;
    const type = ref.type === 'directory' ? 'directory' : 'file';
    return {
      type,
      path: String(ref.path || relativePath),
      relativePath,
      size: type === 'directory' ? 0 : Number(ref.size || 0) || 0,
    };
  }).filter(Boolean);
}

function normalizeQueuedMessagesForSession(session, value) {
  if (!Array.isArray(value)) return [];
  const queued = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text : '';
    const attachments = normalizeQueuedMessageAttachments(raw.attachments);
    const fileRefs = normalizeQueuedMessageFileRefs(raw.fileRefs);
    if (!text.trim() && attachments.length === 0 && fileRefs.length === 0) continue;
    queued.push({
      id: sanitizeId(raw.id || '') || crypto.randomUUID(),
      sessionId: session?.id || (typeof raw.sessionId === 'string' ? sanitizeId(raw.sessionId) : null),
      text,
      attachments,
      fileRefs,
      mode: typeof raw.mode === 'string' ? raw.mode : (session?.permissionMode || 'yolo'),
      reasoningEffort: normalizeCodexReasoningEffort(raw.reasoningEffort),
      agent: normalizeAgent(raw.agent || session?.agent),
      createdAt: typeof raw.createdAt === 'string'
        ? raw.createdAt
        : (Number.isFinite(raw.createdAt) ? new Date(raw.createdAt).toISOString() : new Date().toISOString()),
    });
    if (queued.length >= MAX_SERVER_QUEUED_MESSAGES) break;
  }
  return queued;
}

function buildQueuedMessagesPayload(session) {
  const normalized = normalizeQueuedMessagesForSession(session, session?.queuedMessages || []);
  return normalized.map((item) => ({
    id: item.id,
    sessionId: item.sessionId || session?.id || null,
    text: item.text || '',
    attachments: item.attachments || [],
    fileRefs: item.fileRefs || [],
    mode: item.mode || session?.permissionMode || 'yolo',
    reasoningEffort: item.reasoningEffort || '',
    agent: normalizeAgent(item.agent || session?.agent),
    createdAt: item.createdAt || new Date().toISOString(),
    serverQueued: true,
  }));
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return session;
  session.agent = normalizeAgent(session.agent);
  if (!Object.prototype.hasOwnProperty.call(session, 'claudeSessionId')) session.claudeSessionId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'claudeRuntimeFingerprint')) session.claudeRuntimeFingerprint = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'codexThreadId')) session.codexThreadId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'codexRuntimeFingerprint')) session.codexRuntimeFingerprint = null;
  session.reasoningEffort = normalizeCodexReasoningEffort(session.reasoningEffort);
  if (!Object.prototype.hasOwnProperty.call(session, 'totalCost')) session.totalCost = 0;
  if (!Object.prototype.hasOwnProperty.call(session, 'projectId')) session.projectId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'totalUsage') || !session.totalUsage) {
    session.totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  }
  delete session.currentUsage;
  if (session.lastUsage && typeof session.lastUsage !== 'object') delete session.lastUsage;
  if (session.contextWindowTokens) session.contextWindowTokens = Number(session.contextWindowTokens) || null;
  if (!Object.prototype.hasOwnProperty.call(session, 'queuedMessages')) session.queuedMessages = [];
  session.queuedMessages = normalizeQueuedMessagesForSession(session, session.queuedMessages);
  if (!Object.prototype.hasOwnProperty.call(session, 'messages')) session.messages = [];
  if (Array.isArray(session.messages)) {
    session.messages = session.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      if (message.attachments) {
        return { ...message, attachments: normalizeMessageAttachments(message.attachments) };
      }
      return message;
    });
  }
  const runtimeContexts = ensureRuntimeContextStore(session);
  for (const agentName of ['claude', 'codex']) {
    const store = runtimeContexts[agentName];
    for (const [key, rawEntry] of Object.entries(store)) {
      const normalized = normalizeRuntimeContextEntry(rawEntry);
      if (normalized) store[key] = normalized;
      else delete store[key];
    }
  }
  ensureLegacyRuntimeContextPreserved(session, session.agent);
  syncLegacyRuntimeMirror(session);
  return session;
}

function getSessionAgent(session) {
  return normalizeAgent(session?.agent);
}

function isClaudeSession(session) {
  return getSessionAgent(session) === 'claude';
}

function loadSession(id) {
  try {
    return normalizeSession(JSON.parse(fs.readFileSync(sessionPath(id), 'utf8')));
  } catch {
    return null;
  }
}

function saveSession(session) {
  normalizeSession(session);
  writeJsonAtomic(sessionPath(session.id), session);
  invalidateSessionListCache();
  invalidateImportedSessionIdsCache();
}

function normalizeClaudeModelAliasInput(modelInput) {
  const raw = String(modelInput || '').trim();
  const lower = raw.toLowerCase();
  if (lower === 'opus-1m' || lower === 'opus_1m') return 'opus[1m]';
  if (lower === 'sonnet-1m' || lower === 'sonnet_1m') return 'sonnet[1m]';
  return raw;
}

function modelShortName(fullModel) {
  if (!fullModel) return null;
  const normalized = normalizeClaudeModelAliasInput(fullModel);
  const lower = normalized.toLowerCase();
  if (lower === 'opus' || lower === 'sonnet' || lower === 'haiku' || lower === 'opus[1m]' || lower === 'sonnet[1m]') {
    return lower;
  }
  const isOneM = lower.endsWith('[1m]');
  const baseModel = isOneM ? normalized.slice(0, -4) : normalized;
  const baseLower = baseModel.toLowerCase();
  const entry = Object.entries(MODEL_MAP).find(([, value]) => String(value || '').toLowerCase() === baseLower);
  return entry ? (isOneM ? `${entry[0]}[1m]` : entry[0]) : null;
}

function getClaudeModelMenuLabel(modelOrAlias) {
  if (!modelOrAlias) return null;
  const normalized = normalizeClaudeModelAliasInput(modelOrAlias);
  const lower = normalized.toLowerCase();
  if (lower === 'default') {
    return CLAUDE_MODEL_MENU_ENTRIES.find((entry) => entry.alias === 'default')?.label || '默认';
  }
  const alias = modelShortName(normalized) || normalized;
  const entry = CLAUDE_MODEL_MENU_ENTRIES.find((item) => item.alias.toLowerCase() === String(alias).toLowerCase());
  return entry?.label || null;
}

function getClaudeModelMenuEntries() {
  const config = loadModelConfig();
  const useResolvedIds = config.mode === 'custom' && !!config.activeTemplate;
  return CLAUDE_MODEL_MENU_ENTRIES.map((entry) => {
    if (entry.alias === 'default') {
      return { ...entry, value: 'default' };
    }
    const isOneM = entry.alias.endsWith('[1m]');
    const baseAlias = isOneM ? entry.alias.slice(0, -4) : entry.alias;
    let value = entry.alias;
    if (useResolvedIds && MODEL_MAP[baseAlias]) {
      value = isOneM ? `${MODEL_MAP[baseAlias]}[1m]` : MODEL_MAP[baseAlias];
    }
    return { ...entry, value };
  });
}

function resolveClaudeModelInput(modelInput) {
  const raw = String(modelInput || '').trim();
  if (!raw) return null;
  const normalized = normalizeClaudeModelAliasInput(raw);
  const lower = normalized.toLowerCase();
  if (lower === 'default') {
    return { resolvedModel: null, resolvedAlias: 'default' };
  }
  if (lower.endsWith('[1m]')) {
    const baseAlias = lower.slice(0, -4);
    if (MODEL_MAP[baseAlias]) {
      return {
        resolvedModel: `${MODEL_MAP[baseAlias]}[1m]`,
        resolvedAlias: `${baseAlias}[1m]`,
      };
    }
  }
  if (MODEL_MAP[lower]) {
    return { resolvedModel: MODEL_MAP[lower], resolvedAlias: lower };
  }
  const exactEntry = Object.entries(MODEL_MAP).find(([, value]) => String(value || '').toLowerCase() === lower);
  if (exactEntry) {
    return { resolvedModel: exactEntry[1], resolvedAlias: exactEntry[0] };
  }
  const oneMEntry = Object.entries(MODEL_MAP).find(([, value]) => `${String(value || '').toLowerCase()}[1m]` === lower);
  if (oneMEntry) {
    return {
      resolvedModel: `${oneMEntry[1]}[1m]`,
      resolvedAlias: `${oneMEntry[0]}[1m]`,
    };
  }
  return { resolvedModel: normalized, resolvedAlias: modelShortName(normalized) || normalized };
}

function sessionModelLabel(session) {
  if (!session?.model) return null;
  return isClaudeSession(session) ? (modelShortName(session.model) || session.model) : session.model;
}

function getRuntimeContextCount(session, agent) {
  return listRuntimeContextEntries(session, agent).filter((item) => item.entry?.runtimeId).length;
}

function formatRuntimeChannelLabel(agent, descriptor) {
  const normalizedAgent = normalizeAgent(agent);
  const mode = String(descriptor?.mode || 'local').toLowerCase();
  if (normalizedAgent === 'claude') {
    if (mode === 'custom') return descriptor?.templateName ? `Claude · ${descriptor.templateName}` : 'Claude · AI 提供商';
    if (mode === 'legacy') return 'Claude · 旧线程';
    return 'Claude · 本地配置';
  }
  if (mode === 'unified' || mode === 'custom') {
    return descriptor?.sourceName ? `Codex · ${descriptor.sourceName}` : 'Codex · AI 提供商';
  }
  if (mode === 'legacy') return 'Codex · 旧线程';
  if (mode === 'error') return 'Codex · 配置异常';
  return 'Codex · 本地配置';
}

function buildActiveRuntimeSummary(session, options = {}) {
  if (!session) return null;
  const agent = normalizeAgent(options.agent || session.agent);
  const state = getRuntimeSessionState(session, { ...options, agent });
  const descriptor = state.descriptor || {};
  const explicitModel = String(session?.model || '').trim();
  const fallbackModel = String(descriptor.defaultModel || '').trim();
  const summaryModel = explicitModel || fallbackModel || '';
  const displayModel = sessionModelLabel(session) || summaryModel;
  return {
    agent,
    channelKey: state.key || null,
    channelLabel: formatRuntimeChannelLabel(agent, descriptor),
    mode: String(descriptor.mode || 'local'),
    model: summaryModel,
    displayModel,
    explicitModel,
    defaultModel: fallbackModel,
    runtimeIdPresent: !!state.entry?.runtimeId,
    runtimeId: state.entry?.runtimeId || null,
    runtimeCount: getRuntimeContextCount(session, agent),
  };
}

function buildSessionRuntimeMeta(session, options = {}) {
  const activeRuntime = buildActiveRuntimeSummary(session, options);
  return {
    activeChannelKey: activeRuntime?.channelKey || null,
    activeRuntime,
    runtimeCount: activeRuntime?.runtimeCount || 0,
  };
}

function splitHistoryMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= INITIAL_HISTORY_COUNT) {
    return { recentMessages: list, olderChunks: [] };
  }
  const recentMessages = list.slice(-INITIAL_HISTORY_COUNT);
  const older = list.slice(0, -INITIAL_HISTORY_COUNT);
  const olderChunks = [];
  for (let end = older.length; end > 0; end -= HISTORY_CHUNK_SIZE) {
    const start = Math.max(0, end - HISTORY_CHUNK_SIZE);
    olderChunks.push(older.slice(start, end));
  }
  return { recentMessages, olderChunks };
}

function normalizeReplayText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateReplayText(text, maxLen = CONTEXT_REPLAY_MESSAGE_CHAR_LIMIT) {
  const normalized = normalizeReplayText(text);
  if (!normalized || normalized.length <= maxLen) return normalized;
  if (maxLen <= 24) return `${normalized.slice(0, Math.max(0, maxLen - 1))}…`;
  const headLen = Math.ceil((maxLen - 1) * 0.62);
  const tailLen = Math.max(8, maxLen - headLen - 1);
  return `${normalized.slice(0, headLen)}…${normalized.slice(-tailLen)}`;
}

function pushUniqueCarryoverItem(list, seen, value, limit) {
  const normalized = truncateReplayText(value, CONTEXT_REPLAY_FIELD_CHAR_LIMIT);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  list.push(normalized);
  if (typeof limit === 'number' && limit > 0 && list.length > limit) {
    list.length = limit;
  }
}

function messageTextForCarryover(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [];
  const content = truncateReplayText(message.content || '', CONTEXT_REPLAY_MESSAGE_CHAR_LIMIT);
  if (content) parts.push(content);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length > 0) {
    const names = attachments
      .map((attachment) => String(attachment?.filename || attachment?.id || 'image').trim())
      .filter(Boolean)
      .slice(0, 4);
    parts.push(`附件: ${names.join(', ')}${attachments.length > names.length ? ` 等 ${attachments.length} 项` : ''}`);
  }
  const fileRefs = Array.isArray(message.fileRefs) ? message.fileRefs : [];
  if (fileRefs.length > 0) {
    const names = fileRefs
      .map((ref) => String(ref?.relativePath || ref?.path || '').trim())
      .filter(Boolean)
      .slice(0, 6);
    if (names.length > 0) {
      parts.push(`引用文件: ${names.join(', ')}${fileRefs.length > names.length ? ` 等 ${fileRefs.length} 项` : ''}`);
    }
  }
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  if (toolCalls.length > 0) {
    const names = toolCalls
      .map((tool) => String(tool?.name || tool?.type || '').trim())
      .filter(Boolean)
      .slice(0, 4);
    if (names.length > 0) {
      parts.push(`工具: ${names.join(', ')}${toolCalls.length > names.length ? ` 等 ${toolCalls.length} 个` : ''}`);
    }
  }
  return parts.join('\n');
}

function extractCarryoverLead(text) {
  const normalized = normalizeReplayText(text);
  if (!normalized) return '';
  const lead = normalized
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || normalized;
  return truncateReplayText(lead, CONTEXT_REPLAY_FIELD_CHAR_LIMIT);
}

function collectRecentCarryoverMessages(messages) {
  const recent = Array.isArray(messages) ? messages.slice(-CONTEXT_REPLAY_RECENT_MESSAGE_LIMIT) : [];
  const blocks = [];
  let remaining = CONTEXT_REPLAY_RECENT_CHAR_BUDGET;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    const role = message?.role === 'assistant' ? '助手' : '用户';
    const baseText = messageTextForCarryover(message);
    if (!baseText) continue;
    const allowedBody = Math.max(140, Math.min(CONTEXT_REPLAY_MESSAGE_CHAR_LIMIT, remaining - 24));
    const body = truncateReplayText(baseText, allowedBody);
    if (!body) continue;
    const block = `[${role}]\n${body}`;
    blocks.unshift(block);
    remaining -= block.length;
    if (remaining <= 160) break;
  }
  return blocks;
}

function collectCompletedCarryoverItems(messages) {
  const items = [];
  const seen = new Set();
  const list = Array.isArray(messages) ? messages.slice() : [];
  for (let index = list.length - 1; index >= 0 && items.length < CONTEXT_REPLAY_MAX_COMPLETED_ITEMS; index -= 1) {
    const message = list[index];
    if (message?.role !== 'assistant') continue;
    const summary = extractCarryoverLead(messageTextForCarryover(message));
    if (summary) pushUniqueCarryoverItem(items, seen, summary, CONTEXT_REPLAY_MAX_COMPLETED_ITEMS);
  }
  return items;
}

function collectConstraintCarryoverItems(messages) {
  const items = [];
  const seen = new Set();
  const list = Array.isArray(messages) ? messages : [];
  const matcher = /不要|别|请勿|必须|不能|不可|优先|务必|默认|保留|切换|resume|线程|上下文|配置|路径|模型|报错|配置项/i;
  for (let index = list.length - 1; index >= 0 && items.length < CONTEXT_REPLAY_MAX_CONSTRAINT_ITEMS; index -= 1) {
    const message = list[index];
    if (message?.role !== 'user') continue;
    const text = normalizeReplayText(messageTextForCarryover(message));
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (!matcher.test(line)) continue;
      pushUniqueCarryoverItem(items, seen, line, CONTEXT_REPLAY_MAX_CONSTRAINT_ITEMS);
      if (items.length >= CONTEXT_REPLAY_MAX_CONSTRAINT_ITEMS) break;
    }
  }
  return items;
}

function buildClaudeCarryoverConfigLines(session) {
  const lines = [];
  const config = loadModelConfig();
  const template = getClaudeSelectedTemplate(config);
  if (template) {
    lines.push(`Claude 当前运行配置: provider (${template.name})`);
    if (template.apiBase) lines.push(`Claude API Base: ${template.apiBase}`);
    if (template.defaultModel) lines.push(`Claude 默认模型: ${template.defaultModel}`);
    if (template.upstreamType) lines.push(`Claude 上游类型: ${template.upstreamType}`);
  } else {
    const localCreds = readClaudeSettingsCredentials();
    lines.push('Claude 当前运行配置: local');
    lines.push('Claude 本地配置文件: ~/.claude/settings.json');
    if (localCreds?.apiBase) lines.push(`Claude 本地 API Base: ${localCreds.apiBase}`);
    if (localCreds?.defaultModel) lines.push(`Claude 本地默认模型: ${localCreds.defaultModel}`);
  }
  if (session?.model) lines.push(`当前会话模型覆盖: ${session.model}`);
  lines.push(`当前权限模式: ${session?.permissionMode || 'yolo'}`);
  if (session?.cwd) lines.push(`当前工作目录: ${session.cwd}`);
  return lines;
}

function buildCodexCarryoverConfigLines(session) {
  const lines = [];
  const config = loadCodexConfig();
  if (normalizeCodexMode(config.mode) === 'local') {
    lines.push('Codex 当前运行配置: local');
    lines.push('Codex 本地配置文件: ~/.codex/config.toml');
    lines.push('Codex 本地鉴权文件: ~/.codex/auth.json');
  } else {
    const source = resolveCodexActiveSource(config);
    if (source?.error) {
      lines.push(`Codex 当前运行配置异常: ${source.error}`);
    } else {
      lines.push(`Codex 当前运行配置: ${source?.mode || 'unified'}${source?.name ? ` (${source.name})` : ''}`);
      if (source?.apiBase) lines.push(`Codex API Base: ${source.apiBase}`);
      if (source?.defaultModel) lines.push(`Codex 默认模型: ${source.defaultModel}`);
    }
    if (config.activeProfile) lines.push(`Codex 激活配置: ${config.activeProfile}`);
    if (config.sharedTemplate) lines.push(`Codex AI 提供商: ${config.sharedTemplate}`);
  }
  if (session?.model) lines.push(`当前会话模型覆盖: ${session.model}`);
  lines.push(`当前权限模式: ${session?.permissionMode || 'yolo'}`);
  if (session?.cwd) lines.push(`当前工作目录: ${session.cwd}`);
  return lines;
}

function buildCarryoverConfigLines(session) {
  return isClaudeSession(session)
    ? buildClaudeCarryoverConfigLines(session)
    : buildCodexCarryoverConfigLines(session);
}

function collectCarryoverExactLines(messages, currentInputText, configLines) {
  const buckets = {
    paths: [],
    models: [],
    configs: [],
    errors: [],
  };
  const seen = {
    paths: new Set(),
    models: new Set(),
    configs: new Set(),
    errors: new Set(),
  };
  const pathRegex = /(?:~\/|\/)[^\s"'`<>|]+/g;
  const modelRegexes = [
    /\bclaude-[a-zA-Z0-9._-]+\b/g,
    /\bgpt-[a-zA-Z0-9._-]+\b/g,
    /\b(?:opus|sonnet|haiku)(?:\[1m\])?\b/g,
  ];
  const configRegex = /\b(?:ANTHROPIC_[A-Z0-9_]+|OPENAI_[A-Z0-9_]+|model_provider|preferred_auth_method|base_url|apiBase|apiKey|defaultModel|sharedTemplate|activeTemplate|activeProfile|legacyMode|permissionMode)\b/g;
  const errorLineRegex = /error|failed|failure|失败|报错|超时|not found|invalid|forbidden|exceed|context|退出码/i;
  const sources = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = messageTextForCarryover(message);
    if (text) sources.push(text);
  }
  if (currentInputText) sources.push(String(currentInputText));
  for (const line of Array.isArray(configLines) ? configLines : []) {
    if (line) sources.push(String(line));
  }

  for (const source of sources) {
    const text = normalizeReplayText(source);
    if (!text) continue;
    const pathMatches = text.match(pathRegex) || [];
    for (const match of pathMatches) {
      pushUniqueCarryoverItem(buckets.paths, seen.paths, match, CONTEXT_REPLAY_MAX_EXACT_ITEMS);
    }
    for (const regex of modelRegexes) {
      const matches = text.match(regex) || [];
      for (const match of matches) {
        pushUniqueCarryoverItem(buckets.models, seen.models, match, CONTEXT_REPLAY_MAX_EXACT_ITEMS);
      }
    }
    const configMatches = text.match(configRegex) || [];
    for (const match of configMatches) {
      pushUniqueCarryoverItem(buckets.configs, seen.configs, match, CONTEXT_REPLAY_MAX_EXACT_ITEMS);
    }
    for (const line of text.split('\n')) {
      if (!errorLineRegex.test(line)) continue;
      pushUniqueCarryoverItem(buckets.errors, seen.errors, line, CONTEXT_REPLAY_MAX_EXACT_ITEMS);
    }
  }

  const lines = [];
  if (buckets.paths.length > 0) lines.push(`- 路径/文件: ${buckets.paths.join(' | ')}`);
  if (buckets.models.length > 0) lines.push(`- 模型名: ${buckets.models.join(' | ')}`);
  if (buckets.configs.length > 0) lines.push(`- 配置项: ${buckets.configs.join(' | ')}`);
  if (buckets.errors.length > 0) lines.push(`- 报错/异常: ${buckets.errors.join(' | ')}`);
  return lines;
}

function buildCarryoverSummary(session, historyMessages, currentInputText, attachments) {
  const recentUser = [...(Array.isArray(historyMessages) ? historyMessages : [])]
    .reverse()
    .find((message) => message?.role === 'user' && messageTextForCarryover(message));
  const goal = extractCarryoverLead(recentUser ? messageTextForCarryover(recentUser) : currentInputText)
    || '继续当前会话中的最近任务';
  const pending = extractCarryoverLead(currentInputText)
    || (Array.isArray(attachments) && attachments.length > 0
      ? `继续处理本次新增的 ${attachments.length} 张图片相关请求`
      : '继续处理当前会话的下一步任务');
  const configLines = buildCarryoverConfigLines(session);
  const historyChars = (Array.isArray(historyMessages) ? historyMessages : [])
    .reduce((sum, message) => sum + messageTextForCarryover(message).length, 0);
  const detailed = (Array.isArray(historyMessages) ? historyMessages.length : 0) >= CONTEXT_REPLAY_MIN_DETAILED_SUMMARY_MESSAGES
    || historyChars >= CONTEXT_REPLAY_MIN_DETAILED_SUMMARY_CHARS;

  const lines = [];
  lines.push(`当前目标: ${goal}`);
  if (detailed) {
    const completed = collectCompletedCarryoverItems(historyMessages);
    if (completed.length > 0) {
      lines.push('已完成操作:');
      for (const item of completed) lines.push(`- ${item}`);
    }
    const constraints = collectConstraintCarryoverItems(historyMessages);
    if (constraints.length > 0) {
      lines.push('关键约束:');
      for (const item of constraints) lines.push(`- ${item}`);
    }
  }
  if (configLines.length > 0) {
    lines.push('关键配置状态:');
    for (const item of configLines) lines.push(`- ${truncateReplayText(item, CONTEXT_REPLAY_FIELD_CHAR_LIMIT)}`);
  }
  lines.push(`当前待解决问题: ${pending}`);
  if (detailed) {
    const exactLines = collectCarryoverExactLines(historyMessages, currentInputText, configLines);
    if (exactLines.length > 0) {
      lines.push('必须精确保留的原文:');
      for (const item of exactLines) lines.push(item);
    }
  }

  let text = lines.join('\n');
  if (text.length > CONTEXT_REPLAY_SUMMARY_MAX_CHARS) {
    text = `${text.slice(0, CONTEXT_REPLAY_SUMMARY_MAX_CHARS - 12).trimEnd()}\n[摘要已截断]`;
  }
  return {
    text,
    detailed,
    configLines,
  };
}

function formatCurrentInputForCarryover(text, attachments) {
  const blocks = [];
  const normalized = normalizeReplayText(text);
  if (normalized) blocks.push(normalized);
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length > 0) {
    const names = list
      .map((attachment) => String(attachment?.filename || attachment?.id || 'image').trim())
      .filter(Boolean)
      .slice(0, 4);
    blocks.push(`本次还附带图片: ${names.join(', ')}${list.length > names.length ? ` 等 ${list.length} 项` : ''}`);
  }
  if (blocks.length === 0) {
    blocks.push('请继续处理当前会话中的下一步任务。');
  }
  return blocks.join('\n');
}

function buildThreadCarryoverPayload(session, text, attachments, historyMessages, threadReset) {
  const history = Array.isArray(historyMessages) ? historyMessages.filter(Boolean) : [];
  if (history.length === 0) return null;
  const recentBlocks = collectRecentCarryoverMessages(history);
  if (recentBlocks.length === 0) return null;
  const summary = buildCarryoverSummary(session, history, text, attachments);
  let reasonText = '检测到配置已经变化，当前必须按最新配置重建底层线程。';
  if (threadReset?.reason === 'legacy_runtime') {
    reasonText = '检测到这是旧版线程，当前必须按最新配置重建底层线程。';
  } else if (threadReset?.reason === 'channel_changed') {
    reasonText = '检测到当前会话切换到了新的渠道或模型，当前会在该渠道下建立新线程。';
  }
  const prompt = [
    '[webcoding 自动上下文续接]',
    reasonText,
    '下面依次提供结构化上下文摘要、最近几轮原始消息，以及本次用户新输入。',
    '请先吸收这些内容，不要逐段复述，不要把它们当成需要原样回复给用户的正文；直接继续处理当前任务。',
    '',
    '[结构化上下文摘要]',
    summary.text,
    '',
    '[最近对话原文]',
    recentBlocks.join('\n\n'),
    '',
    '[本次用户新输入]',
    formatCurrentInputForCarryover(text, attachments),
  ].join('\n');
  return {
    prompt,
    summaryDetailed: summary.detailed,
    recentCount: recentBlocks.length,
    historyCount: history.length,
  };
}

function buildThreadCarryoverNotice(carryover) {
  if (!carryover) {
    return '已新开线程；历史较少，本次仅发送当前输入。';
  }
  return carryover.summaryDetailed
    ? `已新开线程，并补充摘要和最近 ${carryover.recentCount} 条消息。`
    : `已新开线程，并补充轻量摘要和最近 ${carryover.recentCount} 条消息。`;
}

function sendHistoryChunks(ws, sessionId, chunks, index = 0) {
  if (!ws || ws.readyState !== 1 || index >= chunks.length) return;
  wsSend(ws, {
    type: 'session_history_chunk',
    sessionId,
    messages: chunks[index],
    remaining: Math.max(0, chunks.length - index - 1),
  });
  if (index >= chunks.length - 1) return;
  const scheduleNext = () => sendHistoryChunks(ws, sessionId, chunks, index + 1);
  if (ws.bufferedAmount > HISTORY_CHUNK_BUFFER_LIMIT) {
    setTimeout(scheduleNext, HISTORY_CHUNK_RETRY_MS);
  } else {
    setImmediate(scheduleNext);
  }
}

const IS_WIN = process.platform === 'win32';

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid, force = false) {
  try {
    if (IS_WIN) {
      const args = ['/T', '/PID', String(pid)];
      if (force) args.unshift('/F');
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {}
}

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readBridgeState() {
  try {
    if (!fs.existsSync(BRIDGE_STATE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(BRIDGE_STATE_PATH, 'utf8'));
    if (!parsed || typeof parsed.port !== 'number' || parsed.port <= 0) return null;
    return {
      ...parsed,
      scriptFingerprint: String(parsed.scriptFingerprint || '').trim(),
    };
  } catch {
    return null;
  }
}

function clearTunnelState() {
  try { fs.unlinkSync(TUNNEL_STATE_PATH); } catch {}
}

function normalizeTunnelState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pid = Number.parseInt(String(raw.pid ?? ''), 10);
  const managerPid = Number.parseInt(String(raw.managerPid ?? ''), 10);
  const port = Number.parseInt(String(raw.port ?? ''), 10);
  const url = String(raw.url || '').trim();
  const startedAt = String(raw.startedAt || '').trim();
  const error = String(raw.error || '').trim();
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    managerPid: Number.isInteger(managerPid) && managerPid > 0 ? managerPid : null,
    port: Number.isInteger(port) && port > 0 ? port : null,
    url: url || null,
    startedAt: startedAt || null,
    error: error || '',
  };
}

function readTunnelState() {
  try {
    if (!fs.existsSync(TUNNEL_STATE_PATH)) return null;
    return normalizeTunnelState(JSON.parse(fs.readFileSync(TUNNEL_STATE_PATH, 'utf8')));
  } catch {
    clearTunnelState();
    return null;
  }
}

function isTunnelStateLive(state) {
  return !!(
    state?.managerPid
    && state?.pid
    && state?.port
    && isProcessRunning(state.managerPid)
    && isProcessRunning(state.pid)
  );
}

// Returns the path where we store the downloaded cloudflared binary
function getCloudflaredLocalPath() {
  const ext = IS_WIN ? '.exe' : '';
  return path.join(CONFIG_DIR, `cloudflared${ext}`);
}

// Check if cloudflared is available (local copy or system PATH)
function getCloudflaredBin() {
  const local = getCloudflaredLocalPath();
  if (fs.existsSync(local)) return local;
  const fromEnv = process.env.CLOUDFLARED_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  // Check system PATH via a quick execFileSync
  try {
    const { execFileSync } = require('child_process');
    execFileSync(IS_WIN ? 'where' : 'which', ['cloudflared'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {
    return null;
  }
}

function getTunnelStatus() {
  const bin = getCloudflaredBin();
  const installed = !!bin;
  const state = readTunnelState();
  if (!state || !isTunnelStateLive(state)) {
    if (state) clearTunnelState();
    return { running: false, url: null, installed };
  }
  return { running: true, url: state.url || null, installed };
}

// Download cloudflared binary from GitHub releases
function installCloudflared(ws) {
  const platform = process.platform; // darwin / linux / win32
  const arch = process.arch;         // x64 / arm64 / arm

  let assetName;
  if (platform === 'darwin') {
    assetName = arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  } else if (platform === 'linux') {
    if (arch === 'arm64') assetName = 'cloudflared-linux-arm64';
    else if (arch === 'arm') assetName = 'cloudflared-linux-arm';
    else assetName = 'cloudflared-linux-amd64';
  } else if (platform === 'win32') {
    assetName = arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
  } else {
    wsSend(ws, { type: 'tunnel_install_progress', done: true, error: `不支持的平台: ${platform}` });
    return;
  }

  function sendProgress(msg) {
    wsSend(ws, { type: 'tunnel_install_progress', message: msg });
  }

  sendProgress('正在查询最新版本...');

  const apiReq = https.request({
    hostname: 'api.github.com',
    path: '/repos/cloudflare/cloudflared/releases/latest',
    headers: { 'User-Agent': 'webcoding-cloudflared-installer' },
    timeout: 10000,
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      let releaseData;
      try { releaseData = JSON.parse(body); } catch {
        wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '解析 GitHub API 响应失败' });
        return;
      }
      const asset = (releaseData.assets || []).find((a) => a.name === assetName);
      if (!asset) {
        wsSend(ws, { type: 'tunnel_install_progress', done: true, error: `未找到资产: ${assetName}` });
        return;
      }
      sendProgress(`下载 ${assetName} (${Math.round(asset.size / 1024 / 1024 * 10) / 10} MB)...`);
      downloadCloudflaredAsset(ws, asset.browser_download_url, assetName);
    });
  });
  apiReq.on('error', (e) => {
    wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '网络错误: ' + e.message });
  });
  apiReq.on('timeout', () => { apiReq.destroy(); wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '请求超时' }); });
  apiReq.end();
}

function downloadCloudflaredAsset(ws, downloadUrl, assetName) {
  const destPath = getCloudflaredLocalPath();
  const tmpPath = destPath + '.tmp';
  const isTgz = assetName.endsWith('.tgz');

  function doDownload(url, redirects) {
    if (redirects > 5) {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '重定向过多' });
      return;
    }
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'webcoding-cloudflared-installer' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        res.resume();
        doDownload(res.headers.location, redirects + 1);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        wsSend(ws, { type: 'tunnel_install_progress', done: true, error: `下载失败 HTTP ${res.statusCode}` });
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastPct = 0;
      const fileStream = fs.createWriteStream(tmpPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor(received / total * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            wsSend(ws, { type: 'tunnel_install_progress', message: `下载中 ${pct}%...` });
          }
        }
      });
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(() => {
          if (isTgz) {
            extractCloudflaredFromTgz(ws, tmpPath, destPath);
          } else {
            try {
              fs.renameSync(tmpPath, destPath);
              if (!IS_WIN) fs.chmodSync(destPath, 0o755);
              wsSend(ws, { type: 'tunnel_install_progress', done: true, message: '安装完成！' });
              wsSend(ws, { type: 'tunnel_status', ...getTunnelStatus() });
            } catch (e) {
              wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '保存失败: ' + e.message });
            }
          }
        });
      });
      fileStream.on('error', (e) => {
        wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '写入失败: ' + e.message });
      });
    }).on('error', (e) => {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '下载失败: ' + e.message });
    });
  }

  doDownload(downloadUrl, 0);
}

function extractCloudflaredFromTgz(ws, tgzPath, destPath) {
  wsSend(ws, { type: 'tunnel_install_progress', message: '解压中...' });
  // Use tar command (available on macOS/Linux)
  const tmpDir = tgzPath + '_extract';
  fs.mkdirSync(tmpDir, { recursive: true });
  const tar = spawn('tar', ['-xzf', tgzPath, '-C', tmpDir], { stdio: 'ignore' });
  tar.on('close', (code) => {
    try { fs.unlinkSync(tgzPath); } catch {}
    if (code !== 0) {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: `解压失败 (exit ${code})` });
      return;
    }
    // Find the cloudflared binary inside extracted dir
    let binSrc = null;
    try {
      const files = fs.readdirSync(tmpDir);
      const found = files.find((f) => f === 'cloudflared' || f.startsWith('cloudflared'));
      if (found) binSrc = path.join(tmpDir, found);
    } catch {}
    if (!binSrc) {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '解压后未找到 cloudflared 二进制' });
      return;
    }
    try {
      fs.copyFileSync(binSrc, destPath);
      fs.chmodSync(destPath, 0o755);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      wsSend(ws, { type: 'tunnel_install_progress', done: true, message: '安装完成！' });
      wsSend(ws, { type: 'tunnel_status', ...getTunnelStatus() });
    } catch (e) {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '安装失败: ' + e.message });
    }
  });
  tar.on('error', (e) => {
    wsSend(ws, { type: 'tunnel_install_progress', done: true, error: 'tar 命令失败: ' + e.message });
  });
}

function startTunnel() {
  const bin = getCloudflaredBin();
  if (!bin) return { running: false, url: null, installed: false, error: 'cloudflared 未安装' };

  const existing = readTunnelState();
  if (existing) {
    if (isTunnelStateLive(existing)) return getTunnelStatus();
    clearTunnelState();
  }

  const child = spawn(process.execPath, [TUNNEL_SCRIPT_PATH], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CF_TUNNEL_STATE_PATH: TUNNEL_STATE_PATH,
      CF_TUNNEL_PORT: String(PORT),
      CF_TUNNEL_BIN: bin,
    },
  });
  child.unref();

  const deadline = Date.now() + TUNNEL_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readTunnelState();
    if (isTunnelStateLive(state) && state.url) return getTunnelStatus();
    sleepSync(200);
  }
  return getTunnelStatus();
}

function stopTunnel() {
  const state = readTunnelState();
  const live = isTunnelStateLive(state);
  if (live && state.managerPid) {
    killProcess(state.managerPid, true);
  }
  if (live && state.pid && state.pid !== state.managerPid) {
    killProcess(state.pid, true);
  }
  clearTunnelState();
  return { running: false, url: null, installed: !!getCloudflaredBin() };
}

function normalizeBridgeRuntimeUpstream(upstream) {
  if (!upstream || typeof upstream !== 'object') return null;
  const apiKey = String(upstream.apiKey || '');
  const apiBase = String(upstream.apiBase || '').trim();
  if (!apiKey || !apiBase) return null;
  return {
    name: String(upstream.name || '').trim() || 'AI Provider',
    apiKey,
    apiBase,
    kind: upstream.kind === 'anthropic' ? 'anthropic' : 'openai',
    defaultModel: String(upstream.defaultModel || '').trim(),
  };
}

function normalizeBridgeRuntimeStore(raw) {
  const runtimes = {};
  const addEntry = (tokenValue, upstreamValue, updatedAtValue = null) => {
    const token = String(tokenValue || '').trim();
    const upstream = normalizeBridgeRuntimeUpstream(upstreamValue);
    if (!token || !upstream) return;
    runtimes[token] = {
      token,
      upstream,
      updatedAt: updatedAtValue ? String(updatedAtValue).trim() : null,
    };
  };

  if (raw && typeof raw === 'object' && raw.runtimes && typeof raw.runtimes === 'object' && !Array.isArray(raw.runtimes)) {
    for (const [token, value] of Object.entries(raw.runtimes)) {
      if (value && typeof value === 'object' && value.upstream) {
        addEntry(value.token || token, value.upstream, value.updatedAt || raw.updatedAt || null);
      } else {
        addEntry(token, value, raw.updatedAt || null);
      }
    }
  }
  if (!Object.keys(runtimes).length) {
    addEntry(raw?.token, raw?.upstream, raw?.updatedAt || null);
  }

  const preferredToken = String(raw?.token || '').trim();
  const token = preferredToken && runtimes[preferredToken]
    ? preferredToken
    : (Object.keys(runtimes)[0] || '');
  const current = token ? runtimes[token] : null;

  return {
    version: 2,
    token,
    upstream: current ? cloneJson(current.upstream) : null,
    updatedAt: current?.updatedAt || null,
    runtimes,
  };
}

function loadBridgeRuntimeStore() {
  return normalizeBridgeRuntimeStore(readCachedJsonConfig(BRIDGE_RUNTIME_PATH));
}

function saveBridgeRuntimeStore(store) {
  const normalized = normalizeBridgeRuntimeStore(store);
  writeCachedJsonConfig(BRIDGE_RUNTIME_PATH, {
    version: normalized.version,
    token: normalized.token || '',
    upstream: normalized.upstream ? cloneJson(normalized.upstream) : null,
    updatedAt: normalized.updatedAt || null,
    runtimes: normalized.runtimes,
  });
}

function loadBridgeRuntime(token = '') {
  const store = loadBridgeRuntimeStore();
  const requestedToken = String(token || store.token || '').trim();
  const entry = (requestedToken && store.runtimes[requestedToken])
    || (store.token && store.runtimes[store.token])
    || Object.values(store.runtimes)[0]
    || null;
  if (!entry) return null;
  return {
    token: entry.token,
    upstream: cloneJson(entry.upstream),
    updatedAt: entry.updatedAt || null,
  };
}

function normalizeBridgeUsageRecordUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usage = {
    inputTokens: Number(raw.inputTokens ?? raw.input_tokens ?? raw.prompt_tokens) || 0,
    cachedInputTokens: Number(raw.cachedInputTokens ?? raw.cached_input_tokens ?? raw.cached_tokens ?? raw.cache_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens) || 0,
    outputTokens: Number(raw.outputTokens ?? raw.output_tokens ?? raw.completion_tokens) || 0,
    reasoningOutputTokens: Number(raw.reasoningOutputTokens ?? raw.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens) || 0,
    totalTokens: Number(raw.totalTokens ?? raw.total_tokens) || 0,
  };
  const total = usage.totalTokens || usage.inputTokens + usage.outputTokens + usage.reasoningOutputTokens;
  return total > 0 ? usage : null;
}

function readLatestBridgeUsageForToken(token, sinceMs = 0) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken || !fs.existsSync(BRIDGE_USAGE_PATH)) return null;
  let content = '';
  try {
    content = fs.readFileSync(BRIDGE_USAGE_PATH, 'utf8');
  } catch {
    return null;
  }
  let latest = null;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record = null;
    try { record = JSON.parse(line); } catch { continue; }
    if (String(record?.token || '').trim() !== normalizedToken) continue;
    const timestampMs = Date.parse(record.timestamp || '');
    if (sinceMs && (!Number.isFinite(timestampMs) || timestampMs < sinceMs)) continue;
    const usage = normalizeBridgeUsageRecordUsage(record.usage);
    if (!usage) continue;
    if (!latest || timestampMs >= latest.timestampMs) {
      latest = { timestampMs, usage, record };
    }
  }
  return latest;
}

function applyBridgeUsageToEntry(sessionId, entry) {
  if (!entry || entry.agent !== 'codex' || entry.bridgeUsageApplied) return null;
  const bridgeToken = String(entry.bridgeToken || '').trim();
  if (!bridgeToken) return null;
  const sinceMs = Number(entry.startedAtMs || 0) ? Math.max(0, Number(entry.startedAtMs) - 5000) : 0;
  const latest = readLatestBridgeUsageForToken(bridgeToken, sinceMs);
  if (!latest?.usage) return null;
  entry.bridgeUsageApplied = true;
  entry.lastUsage = latest.usage;
  const session = loadSession(sessionId);
  if (session) {
    session.lastUsage = latest.usage;
    session.updated = new Date().toISOString();
    saveSession(session);
  }
  sendRuntimeMessage(entry, {
    type: 'usage',
    sessionId,
    totalUsage: session?.totalUsage || null,
    currentUsage: latest.usage,
    contextWindowTokens: session?.contextWindowTokens || null,
  });
  return latest.usage;
}

function listBridgeRuntimeTokens() {
  return Object.keys(loadBridgeRuntimeStore().runtimes);
}

function getBridgeScriptFingerprint() {
  try {
    const stat = fs.statSync(BRIDGE_SCRIPT_PATH);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return '';
  }
}

function canReuseBridgeState(state) {
  if (!state?.pid || !state.port || !isProcessRunning(state.pid)) return false;
  const currentFingerprint = getBridgeScriptFingerprint();
  if (!currentFingerprint) return true;
  return !!state.scriptFingerprint && state.scriptFingerprint === currentFingerprint;
}

function buildLocalBridgeBaseUrl(port, kind) {
  return `http://127.0.0.1:${port}/${kind}`;
}

function getActiveUnifiedTemplate() {
  const tpl = getClaudeSelectedTemplate(loadModelConfig());
  if (!tpl || !tpl.apiKey || !tpl.apiBase) return null;
  return tpl;
}

function isBridgePortReachable(port) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function ensureLocalBridgeRunning() {
  const existing = readBridgeState();
  if (canReuseBridgeState(existing)) {
    return existing;
  }
  if (existing?.pid && isProcessRunning(existing.pid)) {
    killProcess(existing.pid, true);
    sleepSync(100);
  }

  const child = spawn(process.execPath, [BRIDGE_SCRIPT_PATH], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CC_WEB_BRIDGE_RUNTIME_PATH: BRIDGE_RUNTIME_PATH,
      CC_WEB_BRIDGE_STATE_PATH: BRIDGE_STATE_PATH,
      CC_WEB_BRIDGE_USAGE_PATH: BRIDGE_USAGE_PATH,
    },
  });
  child.unref();

  const start = Date.now();
  while (Date.now() - start < BRIDGE_START_TIMEOUT_MS) {
    const state = readBridgeState();
    if (state?.pid && isProcessRunning(state.pid) && state.port) return state;
    sleepSync(50);
  }
  throw new Error('本地 API 桥接服务启动超时');
}

function ensureBridgeRuntimeForTemplate(tpl, options = {}) {
  const defaultModel = String(tpl.defaultModel || '').trim();
  const upstreamType = tpl.upstreamType === 'anthropic' ? 'anthropic' : 'openai';
  const store = loadBridgeRuntimeStore();
  const templateName = String(tpl.name || '').trim();
  if (options.forceNewToken === true) {
    const activeBridgeTokens = new Set(Array.from(activeProcesses.values()).map((entry) => String(entry?.bridgeToken || '').trim()).filter(Boolean));
    for (const [runtimeToken, entry] of Object.entries(store.runtimes || {})) {
      if (entry?.upstream?.name === templateName && !activeBridgeTokens.has(String(runtimeToken || '').trim())) {
        delete store.runtimes[runtimeToken];
      }
    }
  }
  const existing = Object.values(store.runtimes).find((entry) => entry?.upstream?.name === templateName) || null;
  const token = options.forceNewToken === true || !existing?.token ? crypto.randomBytes(24).toString('hex') : existing.token;
  const updatedAt = new Date().toISOString();
  store.runtimes[token] = {
    token,
    upstream: {
      name: String(tpl.name || '').trim() || 'AI Provider',
      apiKey: String(tpl.apiKey || ''),
      apiBase: String(tpl.apiBase || '').trim(),
      kind: upstreamType,
      defaultModel,
    },
    updatedAt,
  };
  store.token = token;
  store.upstream = cloneJson(store.runtimes[token].upstream);
  store.updatedAt = updatedAt;
  saveBridgeRuntimeStore(store);
  const state = ensureLocalBridgeRunning();
  return {
    token,
    defaultModel,
    anthropicBaseUrl: buildLocalBridgeBaseUrl(state.port, 'anthropic'),
    openaiBaseUrl: buildLocalBridgeBaseUrl(state.port, 'openai'),
  };
}

function cleanRunDir(sessionId) {
  const dir = runDir(sessionId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  } catch {}
}

function collectSessionListSnapshot() {
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  const sessions = [];
  for (const f of files) {
    try {
      const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
      const preferredClaudeRuntimeId = getSessionAgent(s) === 'claude'
        ? getPreferredRuntimeSessionId(s, 'claude')
        : null;
      const localMeta = getSessionAgent(s) === 'claude' && preferredClaudeRuntimeId && (!s.cwd || !s.importedFrom)
        ? resolveClaudeSessionLocalMeta(preferredClaudeRuntimeId)
        : null;
      sessions.push({
        id: s.id,
        title: s.title || 'Untitled',
        updated: s.updated,
        hasUnread: !!s.hasUnread,
        agent: getSessionAgent(s),
        reasoningEffort: s.reasoningEffort || '',
        queuedCount: Array.isArray(s.queuedMessages) ? s.queuedMessages.length : 0,
        isRunning: activeProcesses.has(s.id),
        projectId: s.projectId || null,
        cwd: s.cwd || localMeta?.cwd || null,
        importedFrom: s.importedFrom || localMeta?.projectDir || null,
      });
    } catch {}
  }
  sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  return sessions;
}

function getSessionListSnapshot(options = {}) {
  const now = Date.now();
  const forceRefresh = !!options.forceRefresh;
  if (!forceRefresh && sessionListCache.expiresAt > now) {
    return sessionListCache.sessions;
  }
  const sessions = collectSessionListSnapshot();
  sessionListCache.sessions = sessions;
  sessionListCache.expiresAt = now + SESSION_LIST_CACHE_TTL_MS;
  return sessions;
}

function sendSessionList(ws, options = {}) {
  try {
    const sessions = Array.isArray(options.sessions)
      ? options.sessions
      : getSessionListSnapshot(options);
    wsSend(ws, { type: 'session_list', sessions });
  } catch {
    wsSend(ws, { type: 'session_list', sessions: [] });
  }
}


function getSessionViewerClients(sessionId) {
  const viewers = [];
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN || client.isAuthenticated !== true) continue;
    if (wsSessionMap.get(client) === sessionId) viewers.push(client);
  }
  return viewers;
}

function broadcastToSessionViewers(sessionId, data) {
  for (const client of getSessionViewerClients(sessionId)) wsSend(client, data);
}

function sendQueueUpdateForSession(sessionId) {
  const session = loadSession(sessionId);
  if (!session) return;
  const payload = {
    type: 'queue_update',
    sessionId,
    queuedMessages: buildQueuedMessagesPayload(session),
  };
  broadcastToSessionViewers(sessionId, payload);
  const sessions = getSessionListSnapshot({ forceRefresh: true });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated === true) {
      sendSessionList(client, { sessions });
    }
  }
}


// === File Tailer ===
// Tails a file and calls onLine for each new complete line.
class FileTailer {
  constructor(filePath, onLine) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.offset = 0;
    this.buffer = '';
    this.watcher = null;
    this.interval = null;
    this.stopped = false;
    this.readTimer = null;
  }

  start() {
    this.readNew();
    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.scheduleRead();
      });
      this.watcher.on('error', () => {});
    } catch {}
    // Backup poll every 500ms (fs.watch not always reliable on all systems)
    this.interval = setInterval(() => {
      this.scheduleRead();
    }, 500);
  }

  scheduleRead() {
    if (this.stopped || this.readTimer) return;
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      if (!this.stopped) this.readNew();
    }, FILE_TAIL_DEBOUNCE_MS);
  }

  readNew() {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.offset) return;

      const targetSize = stat.size;
      const fd = fs.openSync(this.filePath, 'r');
      try {
        while (!this.stopped && this.offset < targetSize) {
          const remaining = targetSize - this.offset;
          const readLen = Math.min(remaining, FILE_TAIL_MAX_READ_BYTES);
          const buf = Buffer.alloc(readLen);
          const bytesRead = fs.readSync(fd, buf, 0, buf.length, this.offset);
          if (bytesRead <= 0) break;

          this.offset += bytesRead;
          this.buffer += buf.toString('utf8', 0, bytesRead);
          const lines = this.buffer.split('\n');
          this.buffer = lines.pop();
          for (const line of lines) {
            if (line.trim()) this.onLine(line);
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      plog('WARN', 'tailer_read_error', {
        file: this.filePath,
        offset: this.offset,
        error: error?.message || String(error),
      });
    }
  }

  stop() {
    this.stopped = true;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.readTimer) { clearTimeout(this.readTimer); this.readTimer = null; }
  }
}

// === Process Lifecycle ===

function firstMeaningfulLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function condenseRuntimeError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const usageIndex = lines.findIndex((line) => /^Usage:/i.test(line));
  if (usageIndex >= 0) return lines.slice(0, usageIndex).join(' ');
  return lines.slice(0, 3).join(' ');
}

function formatRuntimeError(agent, raw, context = {}) {
  const condensed = condenseRuntimeError(raw);
  const exitInfo = typeof context.exitCode === 'number' ? `（退出码 ${context.exitCode}）` : '';
  if (!condensed) {
    return agent === 'codex'
      ? `Codex 任务异常结束${exitInfo}，但 CLI 没有返回更多错误信息。`
      : `Claude 任务异常结束${exitInfo}，但 CLI 没有返回更多错误信息。`;
  }

  if (agent === 'codex') {
    if (/ENOENT|not found|No such file/i.test(condensed)) {
      return '找不到 Codex CLI。请检查 Codex 设置里的 CLI 路径，或确认系统 PATH 中可直接运行 `codex`。';
    }
    if (/unexpected argument|unexpected option|Usage:\s*codex/i.test(raw || '')) {
      return `Codex CLI 参数不兼容：${firstMeaningfulLine(condensed)}。建议检查当前 CLI 版本与 webcoding 的参数约定是否匹配。`;
    }
    if (/permission denied|EACCES|EPERM/i.test(condensed)) {
      return 'Codex CLI 启动失败：当前环境没有足够权限执行该命令或访问目标目录。';
    }
    if (/authentication|unauthorized|forbidden|login|api key|credential/i.test(condensed)) {
      return 'Codex 鉴权失败。请确认本机 Codex CLI 已完成登录，且当前凭据仍然有效。';
    }
    if (/rate limit|quota|billing|credits/i.test(condensed)) {
      return 'Codex 请求被额度或速率限制拦截。请检查账号配额、计费状态或稍后重试。';
    }
    if (/network|timed out|timeout|ECONNRESET|ENOTFOUND|TLS|certificate|fetch failed/i.test(condensed)) {
      return 'Codex 运行时网络请求失败。请检查当前网络、代理或证书环境后重试。';
    }
    if (/sandbox|approval|read-only|bypass-approvals/i.test(condensed)) {
      return `Codex 当前的审批或沙箱设置阻止了这次执行：${firstMeaningfulLine(condensed)}`;
    }
    return `Codex 任务失败${exitInfo}：${condensed}`;
  }

  if (/ENOENT|not found|No such file/i.test(condensed)) {
    return '找不到 Claude CLI。请检查当前环境是否能直接运行 `claude`。';
  }
  if (/authentication|unauthorized|forbidden|not logged in|\/login|login|api key|credential/i.test(condensed)) {
    return 'Claude 本地认证不可用。请检查本机 Claude CLI 当前是账号登录态还是本地自定义 API 配置，并确认对应凭据仍然有效。';
  }
  return `Claude 任务失败${exitInfo}：${condensed}`;
}

function compactStartMessage(agent) {
  return agent === 'codex'
    ? '正在执行 Codex /compact 压缩上下文，请稍候…'
    : '正在执行 Claude 原生 /compact 压缩上下文，请稍候…';
}

function compactDoneMessage(agent) {
  return agent === 'codex'
    ? '上下文压缩完成。已执行 Codex /compact，下次继续在同一会话发送即可。'
    : '上下文压缩完成。已按 Claude Code 原生策略执行 /compact，下次继续在同一会话发送即可。';
}

function compactAutoStartMessage(agent) {
  return agent === 'codex'
    ? '检测到上下文达到上限，正在按 Codex /compact 自动压缩，然后继续当前任务…'
    : '检测到上下文达到上限，正在按 Claude Code 原版策略自动执行 /compact，然后继续当前任务…';
}

function compactAutoResumeMessage(agent) {
  return agent === 'codex'
    ? '检测到上一条请求因上下文过大失败，现已按 Codex 压缩计划继续执行。'
    : '检测到上一条请求因上下文过大失败，现已自动按压缩计划继续执行。';
}

function isContextLimitError(agent, raw) {
  const text = String(raw || '');
  if (!text) return false;
  if (agent === 'claude') {
    return /Request too large \(max 20MB\)/i.test(text);
  }
  return /context\s+(window|length)|maximum context length|context limit|token limit|too many tokens|input.*too long|prompt.*too long|request too large|please use\s*\/compact|use\s*\/compact|reduce (the )?(input|prompt|message)|exceed(?:ed|s).*(token|context)/i.test(text);
}

function readProcessStderrSnippet(sessionId) {
  try {
    const errPath = path.join(runDir(sessionId), 'error.log');
    const content = fs.readFileSync(errPath, 'utf8').trim();
    if (content) return content.slice(-500);
  } catch {}
  return '';
}

function resolveProcessCompletionState(sessionId, entry, exitCode, signal) {
  const completeTime = new Date().toISOString();
  const wsConnected = isProcessRealtimeConnected(entry);
  const disconnectGap = entry.wsDisconnectTime
    ? ((new Date(completeTime) - new Date(entry.wsDisconnectTime)) / 1000).toFixed(1) + 's'
    : null;
  const pendingRetry = pendingCompactRetries.get(sessionId) || null;
  const stderrSnippet = readProcessStderrSnippet(sessionId);
  const hasNonZeroExit = typeof exitCode === 'number' && exitCode !== 0;
  const hasUnexpectedSignal = !!signal && signal !== 'SIGTERM';
  const rawCompletionError = entry.lastError || (
    (hasNonZeroExit || hasUnexpectedSignal)
      ? (stderrSnippet || null)
      : null
  );
  const loggedCompletionError = rawCompletionError || (
    hasNonZeroExit
      ? `process exited with non-zero status ${exitCode} but returned no stderr`
      : null
  );
  const contextLimitExceeded = isContextLimitError(entry.agent || 'claude', `${entry.fullText || ''}\n${stderrSnippet || ''}\n${rawCompletionError || ''}`);
  const completionError = rawCompletionError
    ? formatRuntimeError(entry.agent || 'claude', rawCompletionError, { exitCode, signal })
    : hasNonZeroExit
      ? formatRuntimeError(entry.agent || 'claude', '', { exitCode, signal })
      : null;
  if (!entry.lastError && rawCompletionError) entry.lastError = rawCompletionError;

  plog(exitCode === 0 || exitCode === null ? 'INFO' : 'WARN', 'process_complete', {
    sessionId: sessionId.slice(0, 8),
    pid: entry.pid,
    agent: entry.agent || 'claude',
    exitCode,
    signal,
    wsConnected,
    wsDisconnectTime: entry.wsDisconnectTime || null,
    disconnectToDeathGap: disconnectGap,
    responseLen: (entry.fullText || '').length,
    toolCallCount: (entry.toolCalls || []).length,
    cost: entry.lastCost,
    usage: entry.lastUsage || null,
    error: loggedCompletionError,
    stderr: stderrSnippet || null,
    requestTooLarge: contextLimitExceeded,
  });

  return { pendingRetry, contextLimitExceeded, completionError };
}

function persistProcessCompletionSession(sessionId, entry, pendingSlash) {
  const session = loadSession(sessionId);
  if (session && (entry.fullText || (entry.toolCalls && entry.toolCalls.length > 0) || (entry.segments && entry.segments.length > 0))) {
    session.messages.push({
      role: 'assistant',
      content: entry.fullText,
      toolCalls: entry.toolCalls || [],
      segments: entry.segments || [],
      timestamp: new Date().toISOString(),
    });
    session.updated = new Date().toISOString();
    if (!isProcessRealtimeConnected(entry)) session.hasUnread = true;
    saveSession(session);
  }

  if (pendingSlash?.kind === 'compact' && session) {
    if (entry.lastCost) {
      session.totalCost = Math.max(0, (session.totalCost || 0) - entry.lastCost);
    }
    session.updated = new Date().toISOString();
    saveSession(session);
  }
  return session;
}

function handleConnectedProcessCompletion(sessionId, entry, session, pendingSlash, pendingRetry, contextLimitExceeded, completionError) {
  let shouldReturnForFollowup = false;
  let shouldAutoCompact = false;

  if (pendingSlash?.kind === 'compact') {
    const retry = pendingCompactRetries.get(sessionId);
    const autoRetryRequested = !!(retry?.text && retry?.reason === 'auto');
    if (autoRetryRequested) {
      if (contextLimitExceeded) {
        pendingCompactRetries.delete(sessionId);
        sendRuntimeMessage(entry, { type: 'system_message', sessionId, message: '已尝试执行 /compact，但仍未成功解除上下文超限。请手动缩小输入范围后重试。' });
      } else {
        sendRuntimeMessage(entry, { type: 'system_message', sessionId, message: compactDoneMessage(entry.agent || 'claude') });
        sendRuntimeMessage(entry, { type: 'system_message', sessionId, message: compactAutoResumeMessage(entry.agent || 'claude') });
        shouldReturnForFollowup = true;
      }
    } else {
      sendRuntimeMessage(entry, { type: 'system_message', sessionId, message: compactDoneMessage(entry.agent || 'claude') });
    }
  }

  // Webcoding-level auto /compact is intentionally disabled.
  // Codex has its own context compaction policy; when Codex/upstream returns a
  // context-limit error, Webcoding should surface the error instead of sending a
  // hidden `/compact` on the user's behalf. Manual `/compact` still works via
  // the pendingSlash branch above.
  //
  // if (contextLimitExceeded && !pendingSlash && session && getRuntimeSessionId(session)) {
  //   const nextRetryCount = Number(pendingRetry?.autoRetryCount || 0) + 1;
  //   if (nextRetryCount > MAX_AUTO_COMPACT_RETRIES) {
  //     pendingCompactRetries.delete(sessionId);
  //     sendRuntimeMessage(entry, { type: 'system_message', sessionId, message: '自动 /compact 重试已达到上限，请手动缩短输入内容后再试。' });
  //   } else {
  //     pendingCompactRetries.set(sessionId, {
  //       text: pendingRetry?.text || '',
  //       mode: pendingRetry?.mode || session.permissionMode || 'yolo',
  //       reason: 'auto',
  //       autoRetryCount: nextRetryCount,
  //     });
  //     sendRuntimeMessage(entry, { type: 'system_message', sessionId, message: compactAutoStartMessage(entry.agent || 'claude') });
  //     shouldAutoCompact = true;
  //   }
  // }

  if (completionError && !entry.errorSent && !shouldAutoCompact) {
    entry.errorSent = true;
    sendRuntimeMessage(entry, { type: 'error', sessionId, message: completionError });
  }

  sendRuntimeMessage(entry, { type: 'done', sessionId, costUsd: entry.lastCost ?? null });
  sendSessionListToProcessClients(entry);
  return { shouldReturnForFollowup, shouldAutoCompact };
}

function handleDisconnectedProcessCompletion(sessionId, entry) {
  const session = loadSession(sessionId);
  const title = session?.title || 'Untitled';
  const sessions = getSessionListSnapshot();
  for (const client of wss.clients) {
    if (client.readyState !== 1 || client.isAuthenticated !== true) continue;
    sendSessionList(client, { sessions });
    if (wsSessionMap.get(client) !== sessionId) continue;
    wsSend(client, {
      type: 'background_done',
      sessionId,
      title,
      costUsd: entry.lastCost ?? null,
      responseLen: (entry.fullText || '').length,
    });
  }
  const cost = entry.lastCost !== null && entry.lastCost !== undefined ? `$${entry.lastCost.toFixed(4)}` : '';
  const respLen = (entry.fullText || '').length;
  sendNotification(
    'webcoding 任务完成',
    `会话: ${title}\n字数: ${respLen}\n费用: ${cost}`
  );
}

function runProcessCompletionFollowup(sessionId, entry, session, pendingSlash, pendingRetry, contextLimitExceeded, shouldReturnForFollowup, shouldAutoCompact) {
  if (!shouldReturnForFollowup && !shouldAutoCompact && !contextLimitExceeded && pendingRetry && pendingRetry.text === (entry.fullText || '').trim()) {
    pendingCompactRetries.delete(sessionId);
  }

  const followupWs = getPrimaryProcessWs(entry);
  if (shouldReturnForFollowup && followupWs && session && pendingSlash?.kind === 'compact') {
    const retry = pendingCompactRetries.get(sessionId);
    if (retry?.text) {
      pendingCompactRetries.delete(sessionId);
      handleMessage(followupWs, { text: retry.text, sessionId, mode: retry.mode || session.permissionMode || 'yolo' });
    }
    return;
  }

  // Webcoding-level auto /compact is disabled; do not send hidden `/compact`.
  // const autoCompactWs = getPrimaryProcessWs(entry);
  // if (shouldAutoCompact && autoCompactWs && session) {
  //   pendingSlashCommands.set(sessionId, { kind: 'compact' });
  //   handleMessage(autoCompactWs, { text: '/compact', sessionId, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
  // }
}

function handleProcessComplete(sessionId, exitCode, signal) {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  if (entry.tailer) {
    entry.tailer.readNew();
    entry.tailer.stop();
  }

  applyBridgeUsageToEntry(sessionId, entry);

  const pendingSlash = pendingSlashCommands.get(sessionId) || null;
  clearPendingSlashCommand(sessionId, pendingSlash);
  const { pendingRetry, contextLimitExceeded, completionError } = resolveProcessCompletionState(sessionId, entry, exitCode, signal);
  const session = persistProcessCompletionSession(sessionId, entry, pendingSlash);

  removeActiveProcess(sessionId);
  cleanRunDir(sessionId);

  const { shouldReturnForFollowup, shouldAutoCompact } = isProcessRealtimeConnected(entry)
    ? handleConnectedProcessCompletion(sessionId, entry, session, pendingSlash, pendingRetry, contextLimitExceeded, completionError)
    : (handleDisconnectedProcessCompletion(sessionId, entry), { shouldReturnForFollowup: false, shouldAutoCompact: false });

  runProcessCompletionFollowup(
    sessionId,
    entry,
    session,
    pendingSlash,
    pendingRetry,
    contextLimitExceeded,
    shouldReturnForFollowup,
    shouldAutoCompact
  );
  setTimeout(() => dispatchNextServerQueuedMessage(sessionId), 50);
}

// Global PID monitor: detect process completion (especially after server restart)
setInterval(() => {
  for (const [sessionId, entry] of activeProcesses) {
    if (entry.pendingProcessComplete) continue;
    if (entry.pid && !isProcessRunning(entry.pid)) {
      plog('INFO', 'pid_monitor_detected_exit', {
        sessionId: sessionId.slice(0, 8),
        pid: entry.pid,
        wsConnected: isProcessRealtimeConnected(entry),
      });
      handleProcessComplete(sessionId, null, 'unknown (detected by monitor)');
    }
  }
}, 2000);

cleanupExpiredAttachments();
setInterval(cleanupExpiredAttachments, 6 * 60 * 60 * 1000);
setInterval(() => cleanupExpiredTokens(), AUTH_TOKEN_CLEANUP_MS);
setInterval(() => cleanupAuthAttempts(), AUTH_TOKEN_CLEANUP_MS);

// Recover processes that were running before server restart
function recoverProcesses() {
  try {
    const runDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('-run'))
      .map((entry) => entry.name);
    if (runDirs.length === 0) return;
    plog('INFO', 'recovery_start', { runDirs: runDirs.length });
    for (const dirName of runDirs) {
      const sessionId = dirName.replace('-run', '');
      const dir = path.join(SESSIONS_DIR, dirName);
      const pidPath = path.join(dir, 'pid');
      const outputPath = path.join(dir, 'output.jsonl');
      const session = loadSession(sessionId);
      const agent = getSessionAgent(session);

      if (!fs.existsSync(pidPath)) {
        try { fs.rmSync(dir, { recursive: true }); } catch {}
        continue;
      }

      const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));

      if (isProcessRunning(pid)) {
        console.log(`[recovery] Re-attaching to session ${sessionId} (PID ${pid})`);
        plog('INFO', 'recovery_alive', { sessionId: sessionId.slice(0, 8), pid, agent });
        const entry = { pid, ws: null, agent, fullText: '', toolCalls: [], segments: [], lastCost: null, lastUsage: null, lastError: null, errorSent: false, tailer: null };
        setActiveProcess(sessionId, entry);

        if (fs.existsSync(outputPath)) {
          entry.tailer = new FileTailer(outputPath, (line) => {
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(entry, event, sessionId);
            } catch {}
          });
          entry.tailer.start();
        }
      } else {
        // Process finished while server was down — read all output and save
        console.log(`[recovery] Processing completed output for session ${sessionId}`);
        plog('INFO', 'recovery_dead', { sessionId: sessionId.slice(0, 8), pid, agent });
        if (fs.existsSync(outputPath)) {
          const tempEntry = { pid: 0, ws: null, agent, fullText: '', toolCalls: [], segments: [], lastCost: null, lastUsage: null, lastError: null, errorSent: false, tailer: null };
          const content = fs.readFileSync(outputPath, 'utf8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(tempEntry, event, sessionId);
            } catch {}
          }
          if (session && (tempEntry.fullText || (tempEntry.toolCalls && tempEntry.toolCalls.length > 0) || (tempEntry.segments && tempEntry.segments.length > 0))) {
            session.messages.push({
              role: 'assistant',
              content: tempEntry.fullText,
              toolCalls: tempEntry.toolCalls || [],
              segments: tempEntry.segments || [],
              timestamp: new Date().toISOString(),
            });
            session.updated = new Date().toISOString();
            saveSession(session);
          }
        }
        try { fs.rmSync(dir, { recursive: true }); } catch {}
        setTimeout(() => dispatchNextServerQueuedMessage(sessionId), 50);
      }
    }
  } catch (err) {
    console.error('[recovery] Error:', err.message);
  }
}

// === HTTP Static File Server ===
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname.startsWith('/api/generated-image/')) {
    const prefix = '/api/generated-image/';
    const rest = url.pathname.slice(prefix.length);
    const parts = rest.split('/').filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch { return ''; }
    });
    const rootKey = parts.shift() || '';
    const roots = Object.fromEntries(generatedImageRootEntries().map(([key, dir]) => [key, path.resolve(dir)]));
    const rootDir = roots[rootKey] || null;
    if (!rootDir || parts.length === 0 || parts.some((part) => !part || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0'))) {
      writeHeadWithSecurity(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Invalid generated image path');
    }
    const filePath = path.resolve(rootDir, ...parts);
    if (!isPathInside(filePath, rootDir) || !isGeneratedImageExtension(filePath)) {
      writeHeadWithSecurity(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        writeHeadWithSecurity(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      writeHeadWithSecurity(res, 200, {
        'Content-Type': getFileMime(filePath),
        'Content-Length': String(stat.size),
        'Content-Disposition': `inline; filename="${path.basename(filePath).replace(/[^A-Za-z0-9._-]+/g, '_')}"`,
        'Cache-Control': 'private, max-age=86400',
      });
      fs.createReadStream(filePath).on('error', () => {
        try { res.destroy(); } catch {}
      }).pipe(res);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/attachments') {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let rawName = 'image';
    try {
      rawName = decodeURIComponent(String(req.headers['x-filename'] || 'image'));
    } catch {
      rawName = String(req.headers['x-filename'] || 'image');
    }
    const filename = safeFilename(rawName);
    if (!IMAGE_MIME_TYPES.has(mime)) {
      return jsonResponse(res, 400, { ok: false, message: '仅支持 PNG/JPG/WEBP/GIF 图片' });
    }

    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_ATTACHMENT_SIZE) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) {
        return jsonResponse(res, 413, { ok: false, message: '图片大小不能超过 10MB' });
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        return jsonResponse(res, 400, { ok: false, message: '图片内容为空' });
      }
      const actualMime = detectMimeFromMagic(buffer);
      if (!actualMime || actualMime !== mime) {
        return jsonResponse(res, 400, { ok: false, message: '图片内容与声明类型不一致或文件已损坏' });
      }
      const id = crypto.randomUUID();
      const ext = extFromMime(mime) || path.extname(filename) || '';
      const dataPath = attachmentDataPath(id, ext);
      const now = new Date();
      const meta = {
        id,
        kind: 'image',
        filename,
        mime,
        size: buffer.length,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ATTACHMENT_TTL_MS).toISOString(),
        path: dataPath,
      };
      try {
        fs.writeFileSync(dataPath, buffer);
        saveAttachmentMeta(meta);
        return jsonResponse(res, 200, {
          ok: true,
          attachment: {
            id,
            kind: 'image',
            filename,
            mime,
            size: buffer.length,
            createdAt: meta.createdAt,
            expiresAt: meta.expiresAt,
            storageState: 'available',
          },
        });
      } catch (err) {
        try { if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath); } catch {}
        try { if (fs.existsSync(attachmentMetaPath(id))) fs.unlinkSync(attachmentMetaPath(id)); } catch {}
        return jsonResponse(res, 500, { ok: false, message: '保存附件失败，请稍后重试' });
      }
    });
    req.on('error', () => {
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, message: '上传过程中断' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/files') {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    try {
      const cwd = url.searchParams.get('cwd') || '';
      const requestedPath = url.searchParams.get('path') || cwd;
      const depthRaw = Number.parseInt(url.searchParams.get('depth') || '2', 10);
      const depth = Math.max(1, Math.min(FILE_TREE_MAX_DEPTH, Number.isFinite(depthRaw) ? depthRaw : 2));
      const { root, resolved } = resolvePathWithinCwd(cwd, requestedPath);
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return jsonResponse(res, 400, { ok: false, message: '目标不是目录' });
      }
      const state = { count: 0 };
      return jsonResponse(res, 200, {
        ok: true,
        cwd: root,
        path: resolved,
        truncated: state.count >= FILE_TREE_MAX_ENTRIES,
        items: buildFileTree(root, resolved, depth, state),
      });
    } catch (err) {
      return jsonResponse(res, 400, { ok: false, message: err.message || '无法读取目录' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/file-view') {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    (async () => {
      try {
        const cwd = url.searchParams.get('cwd') || '';
        const requestedPath = url.searchParams.get('path') || '';
        const { root, resolved } = resolvePathWithinCwd(cwd, requestedPath);
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
          return jsonResponse(res, 400, { ok: false, message: '目标不是文件' });
        }
        const viewType = getFileViewType(resolved, stat);
        const base = buildFileIdentity(root, resolved, stat, viewType);
        const rawParams = new URLSearchParams({ cwd: root, path: path.relative(root, resolved) || path.basename(resolved) });
        const rawUrl = `/api/file-raw?${rawParams.toString()}`;
        if (viewType === 'xlsx') {
          return jsonResponse(res, 200, { ...base, ...buildWorkbookView(resolved, stat), rawUrl });
        }
        if (viewType === 'docx') {
          return jsonResponse(res, 200, { ...base, ...(await buildDocxView(resolved, stat)), rawUrl });
        }
        if (viewType === 'image' || viewType === 'pdf' || viewType === 'binary') {
          return jsonResponse(res, 200, { ...base, rawUrl });
        }
        const content = readTextFileForView(resolved, stat);
        return jsonResponse(res, 200, { ...base, content, rawUrl });
      } catch (err) {
        return jsonErrorResponse(res, err, '无法读取文件');
      }
    })();
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/file-view') {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body, 'utf8') > FILE_VIEW_TEXT_MAX_SIZE + 4096) {
        tooLarge = true;
        try { req.destroy(); } catch {}
      }
    });
    req.on('end', () => {
      try {
        if (tooLarge) return jsonResponse(res, 413, { ok: false, message: '保存内容超过 1MB' });
        const payload = body ? JSON.parse(body) : {};
        const cwd = String(payload.cwd || '');
        const requestedPath = String(payload.path || '');
        const content = String(payload.content ?? '');
        if (Buffer.byteLength(content, 'utf8') > FILE_VIEW_TEXT_MAX_SIZE) {
          return jsonResponse(res, 413, { ok: false, message: '保存内容超过 1MB' });
        }
        const { root, resolved } = resolvePathWithinCwd(cwd, requestedPath);
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) return jsonResponse(res, 400, { ok: false, message: '目标不是文件' });
        const viewType = getFileViewType(resolved, stat);
        if (!['markdown', 'csv', 'tsv', 'json', 'code', 'text'].includes(viewType)) {
          return jsonResponse(res, 400, { ok: false, message: '该文件类型不能文本编辑保存' });
        }
        fs.writeFileSync(resolved, content, 'utf8');
        const nextStat = fs.statSync(resolved);
        return jsonResponse(res, 200, {
          ...buildFileIdentity(root, resolved, nextStat, getFileViewType(resolved, nextStat)),
          content,
          saved: true,
        });
      } catch (err) {
        return jsonErrorResponse(res, err, '保存失败');
      }
    });
    req.on('error', () => {
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, message: '保存请求中断' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/file-raw') {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      writeHeadWithSecurity(res, 401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not authenticated');
    }
    try {
      const cwd = url.searchParams.get('cwd') || '';
      const requestedPath = url.searchParams.get('path') || '';
      const { resolved } = resolvePathWithinCwd(cwd, requestedPath);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        writeHeadWithSecurity(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Target is not a file');
      }
      if (stat.size > FILE_VIEW_BINARY_MAX_SIZE) {
        writeHeadWithSecurity(res, 413, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('File is too large');
      }
      const asciiFilename = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '_') || 'file';
      writeHeadWithSecurity(res, 200, {
        'Content-Type': getFileMime(resolved),
        'Content-Length': String(stat.size),
        'Content-Disposition': `inline; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(resolved).pipe(res);
    } catch (err) {
      writeHeadWithSecurity(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err?.message || 'Unable to read file');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/localfile') {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      writeHeadWithSecurity(res, 401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not authenticated');
    }
    let rawPath = url.searchParams.get('path') || '';
    try { rawPath = decodeURIComponent(rawPath); } catch {}
    rawPath = rawPath.trim();
    if (!rawPath || !path.isAbsolute(rawPath)) {
      writeHeadWithSecurity(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Invalid path');
    }
    const absPath = path.resolve(rawPath);
    fs.readFile(absPath, 'utf8', (err, data) => {
      if (err) {
        writeHeadWithSecurity(res, 404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>文件未找到</title><style>body{font-family:system-ui,sans-serif;padding:40px;color:#333}h2{color:#c00}</style></head><body><h2>文件未找到</h2><p>${absPath.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p></body></html>`);
      }
      const ext = path.extname(absPath).toLowerCase();
      if (ext === '.md' || ext === '.markdown') {
        // Render markdown to HTML
        const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${path.basename(absPath).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>body{font-family:system-ui,sans-serif;font-size:15px;line-height:1.7;max-width:860px;margin:0 auto;padding:32px 24px;color:#222}pre{background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto}code{background:#f0f0f0;padding:1px 5px;border-radius:3px;font-size:0.9em}pre code{background:none;padding:0}img{max-width:100%}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px}th{background:#f5f5f5}blockquote{border-left:3px solid #ccc;margin:0;padding-left:14px;color:#666}a{color:#0066cc}hr{border:none;border-top:1px solid #ddd}</style>
</head><body><div id="content"></div>
<script>document.getElementById('content').innerHTML=marked.parse(${JSON.stringify(data)});</script>
</body></html>`;
        writeHeadWithSecurity(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(htmlContent);
      }
      // Plain text / other text files
      const mime = MIME_TYPES[ext] || 'text/plain; charset=utf-8';
      writeHeadWithSecurity(res, 200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/attachments/')) {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const id = sanitizeId(url.pathname.split('/').pop() || '');
    if (!id) {
      return jsonResponse(res, 400, { ok: false, message: '缺少附件 ID' });
    }
    removeAttachmentById(id);
    return jsonResponse(res, 200, { ok: true });
  }

  let filePath = path.join(PUBLIC_ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  filePath = path.resolve(filePath);

  if (!isPathInside(filePath, PUBLIC_ROOT)) {
    writeHeadWithSecurity(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = renderIndexHtml();
      writeHeadWithSecurity(res, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      return res.end(html);
    } catch {
      writeHeadWithSecurity(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Internal Server Error');
    }
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      writeHeadWithSecurity(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath);
    writeHeadWithSecurity(res, 200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// === WebSocket Server ===
function isAllowedWsOrigin(origin, req) {
  if (!origin) return true; // CLI / non-browser clients may not send Origin
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(parsedOrigin.protocol)) return false;

  const reqHost = String(req?.headers?.host || '').toLowerCase();
  const originHost = String(parsedOrigin.host || '').toLowerCase();
  if (reqHost && originHost === reqHost) return true;

  const allowedHosts = new Set([
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
    `[::1]:${PORT}`,
  ]);
  if (HOST && HOST !== '0.0.0.0' && HOST !== '::') {
    allowedHosts.add(`${HOST}:${PORT}`);
  }
  return allowedHosts.has(originHost);
}

const wss = new WebSocketServer({
  server,
  verifyClient: (info) => isAllowedWsOrigin(info.origin || info.req?.headers?.origin || '', info.req),
});

wss.on('connection', (ws, req) => {
  ws.isAuthenticated = false;
  ws.authToken = null;
  const wsId = crypto.randomBytes(4).toString('hex'); // short id for log correlation
  const clientIp = getWsClientIp(req);
  plog('INFO', 'ws_connect', { wsId, ip: clientIp });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return wsSend(ws, { type: 'error', message: 'Invalid JSON' });
    }

    if (msg.type === 'auth') {
      if (!hasConfiguredPassword()) {
        plog('ERROR', 'auth_no_password_configured', { wsId, ip: clientIp });
        wsSend(ws, { type: 'auth_result', success: false, error: '服务器密码未配置' });
        return;
      }
      const tokenValid = hasActiveToken(msg.token);
      if (tokenValid) {
        clearAuthFailures(clientIp);
        const nextAuthToken = msg.token;
        rememberActiveToken(nextAuthToken);
        ws.isAuthenticated = true;
        ws.authToken = nextAuthToken;
        wsSend(ws, { type: 'auth_result', success: true, token: nextAuthToken, mustChangePassword: !!authConfig.mustChange });
        sendSessionList(ws);
        return;
      }
      const lockState = getAuthLockState(clientIp);
      if (lockState.locked) {
        const waitSeconds = Math.ceil(lockState.remainingMs / 1000);
        wsSend(ws, { type: 'auth_result', success: false, error: `登录失败次数过多，请 ${waitSeconds} 秒后重试` });
        return;
      }
      const passwordValid = verifyConfiguredPassword(msg.password);
      if (passwordValid) {
        clearAuthFailures(clientIp);
        const nextAuthToken = crypto.randomBytes(32).toString('hex');
        rememberActiveToken(nextAuthToken);
        ws.isAuthenticated = true;
        ws.authToken = nextAuthToken;
        wsSend(ws, { type: 'auth_result', success: true, token: nextAuthToken, mustChangePassword: !!authConfig.mustChange });
        sendSessionList(ws);
      } else {
        const authState = recordAuthFailure(clientIp);
        ws.isAuthenticated = false;
        ws.authToken = null;
        const error = authState.locked
          ? `登录失败次数过多，请 ${Math.ceil(authState.remainingMs / 1000)} 秒后重试`
          : '认证失败';
        wsSend(ws, { type: 'auth_result', success: false, error });
      }
      return;
    }

    if (!ws.isAuthenticated) {
      return wsSend(ws, { type: 'error', message: 'Not authenticated' });
    }

    switch (msg.type) {
      case 'message':
        if (msg.text && msg.text.trim().startsWith('/')) {
          handleSlashCommand(ws, msg.text.trim(), msg.sessionId, msg.agent);
        } else {
          handleMessage(ws, msg);
        }
        break;
      case 'enqueue_message':
        handleEnqueueMessage(ws, msg);
        break;
      case 'cancel_queued_message':
        handleCancelQueuedMessage(ws, msg);
        break;
      case 'abort':
        handleAbort(ws);
        break;
      case 'new_session':
        handleNewSession(ws, msg);
        break;
      case 'handoff_session':
        handleHandoffSession(ws, msg).catch((error) => {
          wsSend(ws, { type: 'error', sessionId: msg.sessionId || msg.sourceSessionId || undefined, message: `接力失败：${error?.message || String(error)}` });
        });
        break;
      case 'load_session':
        handleLoadSession(ws, msg.sessionId);
        break;
      case 'delete_session':
        handleDeleteSession(ws, msg.sessionId);
        break;
      case 'rename_session':
        handleRenameSession(ws, msg.sessionId, msg.title);
        break;
      case 'set_mode':
        handleSetMode(ws, msg.sessionId, msg.mode, msg.agent);
        break;
      case 'set_reasoning_effort':
        handleSetReasoningEffort(ws, msg.sessionId, msg.reasoningEffort);
        break;
      case 'list_sessions':
        sendSessionList(ws);
        break;
      case 'detach_view':
        handleDetachView(ws);
        break;
      case 'get_notify_config':
        wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
        break;
      case 'save_notify_config':
        handleSaveNotifyConfig(ws, msg.config);
        break;
      case 'test_notify':
        handleTestNotify(ws);
        break;
      case 'get_tunnel_status':
        wsSend(ws, { type: 'tunnel_status', ...getTunnelStatus() });
        break;
      case 'tunnel_start': {
        const status = startTunnel();
        wsSend(ws, { type: 'tunnel_status', ...status });
        break;
      }
      case 'tunnel_stop': {
        const status = stopTunnel();
        wsSend(ws, { type: 'tunnel_status', ...status });
        break;
      }
      case 'install_cloudflared':
        installCloudflared(ws);
        break;
      case 'change_password':
        handleChangePassword(ws, msg);
        break;
      case 'get_model_config':
        wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
        break;
      case 'save_model_config':
        handleSaveModelConfig(ws, msg.config);
        break;
      case 'get_codex_config':
        wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
        break;
      case 'get_slash_commands': {
        const slashAgent = normalizeAgent(msg.agent || 'claude');
        if (slashAgent === 'claude') {
          // Claude: spawn CLI to capture init event (real-time discovery)
          discoverClaudeSlashCommands().then(() => {
            wsSend(ws, { type: 'slash_commands_list', agent: slashAgent, commands: buildSlashCommandList(slashAgent) });
          }).catch(() => {
            wsSend(ws, { type: 'slash_commands_list', agent: slashAgent, commands: buildSlashCommandList(slashAgent) });
          });
        } else {
          // Codex: scan filesystem for skills/plugins (real-time discovery)
          discoverCodexSlashCommands();
          wsSend(ws, { type: 'slash_commands_list', agent: slashAgent, commands: buildSlashCommandList(slashAgent) });
        }
        break;
      }
      case 'save_codex_config':
        handleSaveCodexConfig(ws, msg.config);
        break;
      case 'fetch_models':
        handleFetchModels(ws, msg);
        break;
      case 'get_model_list':
        wsSend(ws, { type: 'model_list', models: MODEL_MAP });
        break;
      case 'check_update':
        handleCheckUpdate(ws);
        break;
      case 'list_native_sessions':
        handleListNativeSessions(ws);
        break;
      case 'import_native_session':
        handleImportNativeSession(ws, msg);
        break;
      case 'list_codex_sessions':
        handleListCodexSessions(ws);
        break;
      case 'import_codex_session':
        handleImportCodexSession(ws, msg);
        break;
      case 'list_cwd_suggestions':
        handleListCwdSuggestions(ws);
        break;
      case 'browse_directory':
        handleBrowseDirectory(ws, msg);
        break;
      case 'get_projects':
        wsSend(ws, { type: 'projects_config', projects: loadProjectsConfig().projects });
        break;
      case 'save_project':
        handleSaveProject(ws, msg);
        break;
      case 'delete_project':
        handleDeleteProject(ws, msg);
        break;
      case 'rename_project':
        handleRenameProject(ws, msg);
        break;
      case 'reorder_projects':
        handleReorderProjects(ws, msg);
        break;
      case 'git_command':
        handleGitCommand(ws, msg);
        break;
      default:
        wsSend(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  });

  ws.on('close', () => handleDisconnect(ws, wsId));
  ws.on('error', (err) => {
    plog('WARN', 'ws_error', { wsId, error: err.message });
    handleDisconnect(ws, wsId);
  });
});

// === Notify Config Handlers ===
function handleSaveNotifyConfig(ws, newConfig) {
  if (!newConfig || !newConfig.provider) {
    return wsSend(ws, { type: 'error', message: '无效的通知配置' });
  }
  if (newConfig.provider === 'feishu') {
    const candidateWebhook = String(newConfig.feishu?.webhook || '').trim();
    if (candidateWebhook && !candidateWebhook.includes('****')) {
      const validation = validateFeishuWebhook(candidateWebhook);
      if (!validation.ok) {
        return wsSend(ws, { type: 'error', message: validation.error });
      }
    }
  }
  const current = loadNotifyConfig();
  // Merge: only update fields that are not masked (contain ****)
  const merged = { provider: newConfig.provider };
  merged.pushplus = { token: mergeSecretField(newConfig.pushplus?.token, current.pushplus?.token) };
  merged.telegram = {
    botToken: mergeSecretField(newConfig.telegram?.botToken, current.telegram?.botToken),
    chatId: newConfig.telegram?.chatId !== undefined ? newConfig.telegram.chatId : current.telegram?.chatId || '',
  };
  merged.serverchan = { sendKey: mergeSecretField(newConfig.serverchan?.sendKey, current.serverchan?.sendKey) };
  merged.feishu = { webhook: mergeSecretField(newConfig.feishu?.webhook, current.feishu?.webhook) };
  merged.qqbot = { qmsgKey: mergeSecretField(newConfig.qqbot?.qmsgKey, current.qqbot?.qmsgKey) };

  saveNotifyConfig(merged);
  plog('INFO', 'notify_config_saved', { provider: merged.provider });
  wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '通知配置已保存' });
}

function handleTestNotify(ws) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') {
    return wsSend(ws, { type: 'notify_test_result', success: false, message: '通知已关闭，无法测试' });
  }
  sendNotification('webcoding 测试通知', '这是一条测试消息，如果你收到了说明通知配置正确！').then((result) => {
    wsSend(ws, { type: 'notify_test_result', success: result.ok, message: result.ok ? '测试消息已发送，请检查是否收到' : `发送失败: ${result.error || result.body || '未知错误'}` });
  });
}

function handleChangePassword(ws, msg) {
  const currentPassword = String(msg?.currentPassword || '');
  const newPassword = String(msg?.newPassword || '');

  // For regular password changes, verify current password. For first-run mustChange flow,
  // the user has just authenticated with the initial password so we can skip re-check.
  if (!authConfig?.mustChange) {
    if (!currentPassword) {
      return wsSend(ws, { type: 'password_changed', success: false, message: '请输入当前密码' });
    }
    if (!verifyConfiguredPassword(currentPassword)) {
      return wsSend(ws, { type: 'password_changed', success: false, message: '当前密码错误' });
    }
  }

  // Validate new password strength
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return wsSend(ws, { type: 'password_changed', success: false, message: strength.message });
  }

  // Save new password
  authConfig = { passwordHash: hashPassword(newPassword), mustChange: false };
  saveAuthConfig(authConfig);
  PASSWORD_HASH = authConfig.passwordHash;
  plog('INFO', 'password_changed', {});

  // Clear all tokens so every existing login must re-authenticate.
  activeTokens.clear();

  // Generate new token for current connection
  const newToken = crypto.randomBytes(32).toString('hex');
  rememberActiveToken(newToken);
  ws.authToken = newToken;
  ws.isAuthenticated = true;

  for (const client of wss.clients) {
    if (client === ws) continue;
    if (client.isAuthenticated !== true) continue;
    forceLogoutClient(client, '密码已修改，当前登录状态已失效，请重新登录。');
  }

  wsSend(ws, { type: 'password_changed', success: true, token: newToken, message: '密码修改成功' });
}

// === Model Config Handler ===
function handleSaveModelConfig(ws, newConfig) {
  if (!newConfig || !['local', 'custom'].includes(newConfig.mode)) {
    return wsSend(ws, { type: 'error', message: '无效的模型配置' });
  }
  const current = loadModelConfig();
  const previousTemplate = current.mode === 'custom' && current.activeTemplate
    ? (Array.isArray(current.templates) ? current.templates.find((item) => item.name === current.activeTemplate) : null)
    : null;
  const merged = {
    mode: newConfig.mode,
    activeTemplate: newConfig.activeTemplate || '',
    templates: [],
  };

  // Merge templates: keep existing secrets if masked
  const newTemplates = Array.isArray(newConfig.templates) ? newConfig.templates : [];
  const oldTemplates = Array.isArray(current.templates) ? current.templates : [];
  for (const nt of newTemplates) {
    if (!nt.name || !nt.name.trim()) continue;
    const originalName = String(nt.originalName || nt.name).trim();
    const old = oldTemplates.find(t => t.name === originalName);
    merged.templates.push({
      name: nt.name.trim(),
      apiKey: mergeSecretField(nt.apiKey, old?.apiKey),
      apiBase: nt.apiBase || '',
      upstreamType: nt.upstreamType === 'anthropic' ? 'anthropic' : 'openai',
      defaultModel: nt.defaultModel || '',
      opusModel: nt.opusModel || '',
      sonnetModel: nt.sonnetModel || '',
      haikuModel: nt.haikuModel || '',
    });
  }
  if (merged.mode === 'custom' && !selectTemplateByName(merged.templates, merged.activeTemplate)) {
    merged.activeTemplate = merged.templates[0]?.name || '';
  }
  if (merged.mode === 'local') {
    merged.activeTemplate = '';
  }

  saveModelConfig(merged);

  // Re-apply at runtime
  MODEL_MAP = { ...DEFAULT_CLAUDE_MODEL_MAP };
  applyModelConfig();
  // custom mode: write to ~/.claude/settings.json immediately on save
  if (merged.mode === 'custom' && merged.activeTemplate) {
    const tpl = merged.templates.find(t => t.name === merged.activeTemplate);
    if (tpl) applyCustomTemplateToSettings(tpl);
  } else {
    restoreManagedClaudeSettings(previousTemplate);
  }
  refreshCodexGeneratedRuntimeSnapshot('codex_runtime_refresh_after_model_save');
  plog('INFO', 'model_config_saved', { mode: merged.mode, activeTemplate: merged.activeTemplate });
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '模型配置已保存' });
}

function handleSaveCodexConfig(ws, newConfig) {
  if (!newConfig || typeof newConfig !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的 Codex 配置' });
  }
  const current = loadCodexConfig();
  const incomingMode = normalizeCodexMode(newConfig.mode);
  const incomingLegacyMode = resolveCodexLegacyMode(newConfig.legacyMode || newConfig.mode);
  const profilesProvided = Array.isArray(newConfig.profiles);
  const newProfiles = profilesProvided ? newConfig.profiles : (Array.isArray(current.profiles) ? current.profiles : []);
  const oldProfiles = Array.isArray(current.profiles) ? current.profiles : [];
  const mergedProfiles = [];
  for (const profile of newProfiles) {
    const name = String(profile?.name || '').trim();
    if (!name) continue;
    const originalName = String(profile?.originalName || name).trim();
    const old = oldProfiles.find((item) => item.name === originalName);
    const rawApiKey = String(profile?.apiKey || '');
    mergedProfiles.push({
      name,
      apiKey: mergeSecretField(rawApiKey, old?.apiKey),
      apiBase: String(profile?.apiBase || '').trim(),
      defaultModel: String(profile?.defaultModel || '').trim(),
    });
  }
  const requestedSearch = !!newConfig.enableSearch;
  const merged = {
    mode: incomingMode,
    legacyMode: incomingLegacyMode,
    activeProfile: String(profilesProvided ? (newConfig.activeProfile || '') : (current.activeProfile || '')).trim(),
    sharedTemplate: String(newConfig.sharedTemplate !== undefined ? newConfig.sharedTemplate : (current.sharedTemplate || '')).trim(),
    profiles: mergedProfiles,
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: requestedSearch,
  };
  if (merged.legacyMode === 'custom' && merged.profiles.length > 0 && !merged.profiles.some((profile) => profile.name === merged.activeProfile)) {
    merged.activeProfile = merged.profiles[0].name;
  }
  if (merged.mode === 'unified' && !merged.sharedTemplate) {
    const modelConfig = loadModelConfig();
    const templates = Array.isArray(modelConfig.templates) ? modelConfig.templates : [];
    merged.sharedTemplate = modelConfig.activeTemplate || templates[0]?.name || '';
  }
  if (merged.mode === 'unified') {
    const modelConfig = loadModelConfig();
    const template = getCodexSelectedTemplate(merged, modelConfig);
    merged.sharedTemplate = template?.name || '';
  } else {
    merged.sharedTemplate = '';
  }
  saveCodexConfig(merged);
  refreshCodexGeneratedRuntimeSnapshot('codex_runtime_refresh_after_codex_save');
  plog('INFO', 'codex_config_saved', {
    mode: merged.mode,
    legacyMode: merged.legacyMode || null,
    activeProfile: merged.activeProfile || null,
    sharedTemplate: merged.sharedTemplate || null,
    profileCount: merged.profiles.length,
    enableSearchRequested: requestedSearch,
    enableSearchEffective: false,
  });
  wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
  wsSend(ws, {
    type: 'system_message',
    message: requestedSearch
      ? 'Codex 配置已保存。当前 webcoding 的 Codex exec 路径暂未接入 Web Search，已自动忽略该开关。'
      : 'Codex 配置已保存',
  });
}

// === Fetch Upstream Models ===
function handleFetchModels(ws, msg) {
  const { apiBase, apiKey } = msg;
  if (!apiBase || !apiKey) {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '需要填写 API Base 和 API Key' });
  }
  const agent = msg.agent === 'codex' ? 'codex' : 'claude';
  const upstreamType = msg.upstreamType === 'anthropic' ? 'anthropic' : 'openai';
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  let fullUrl = '';
  try {
    const spec = buildModelsRequestSpec(base, apiKey, upstreamType);
    fullUrl = spec.fullUrl;
  } catch (error) {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: error.message || '无效的 API Base URL' });
  }

  let parsed;
  try { parsed = new URL(fullUrl); } catch {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '无效的 URL: ' + fullUrl });
  }

  // Resolve real apiKey (if masked, look up saved config by template name or apiBase)
  let realKey = apiKey;
  if (apiKey.includes('****')) {
    if (msg.templateName) {
      const config = loadModelConfig();
      const saved = Array.isArray(config.templates) ? config.templates : [];
      const template = saved.find((item) => item.name === msg.templateName)
        || saved.find((item) => item.apiBase && item.apiBase.replace(/\/+$/, '') === base)
        || null;
      if (template && template.apiKey && !template.apiKey.includes('****')) {
        realKey = template.apiKey;
      } else {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: 'API Key 已脱敏，请重新输入完整 Key' });
      }
    } else if (agent === 'codex') {
      const config = loadCodexConfig();
      const saved = Array.isArray(config.profiles) ? config.profiles : [];
      const profile = (msg.profileName && saved.find((item) => item.name === msg.profileName))
        || saved.find((item) => item.apiBase && item.apiBase.replace(/\/+$/, '') === base)
        || null;
      if (profile && profile.apiKey && !profile.apiKey.includes('****')) {
        realKey = profile.apiKey;
      } else {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: 'API Key 已脱敏，请重新输入完整 Key' });
      }
    } else {
      const config = loadModelConfig();
      const saved = config.templates || [];
      const tpl = (msg.templateName && saved.find((item) => item.name === msg.templateName))
        || saved.find((item) => item.apiBase && item.apiBase.replace(/\/+$/, '') === base)
        || null;
      if (tpl && tpl.apiKey && !tpl.apiKey.includes('****')) {
        realKey = tpl.apiKey;
      } else {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: 'API Key 已脱敏，请重新输入完整 Key' });
      }
    }
  }

  const mod = parsed.protocol === 'https:' ? require('https') : require('http');
  const reqOptions = {
    method: 'GET',
    headers: buildModelsRequestSpec(base, realKey, upstreamType).headers,
    timeout: 15000,
  };

  const req = mod.request(parsed, reqOptions, (res) => {
    let body = '';
    let bodyBytes = 0;
    res.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > HTTP_BODY_MAX_BYTES) {
        req.destroy(new Error('response too large'));
        return;
      }
      body += chunk;
    });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
      }
      try {
        const json = JSON.parse(body);
        const models = agent === 'codex'
          ? normalizeCodexModelEntries(json.data || json.models || []).map((entry) => entry.value)
          : (json.data || json.models || []).map((item) => typeof item === 'string' ? item : item.id || item.name || '').filter(Boolean).sort();
        wsSend(ws, { type: 'fetch_models_result', success: true, models });
      } catch (e) {
        wsSend(ws, { type: 'fetch_models_result', success: false, message: '解析响应失败: ' + e.message });
      }
    });
  });

  req.on('error', (e) => {
    if (agent === 'claude' && upstreamType === 'anthropic' && isTlsHandshakeFailure(e)) {
      const fallbackModels = getClaudeFallbackModels();
      if (fallbackModels.length) {
        return wsSend(ws, {
          type: 'fetch_models_result',
          success: true,
          models: fallbackModels,
          fallback: true,
          message: `上游拒绝了当前直连探测，已改用内置 Claude 模型列表（${fallbackModels.length} 个）。这类只面向官方 Claude Code CLI 的服务常会这样；你也可以直接手填模型 ID。`,
        });
      }
    }
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求超时 (15s)' });
  });
  req.end();
}

// === Slash Command Handler ===
function handleSlashCommand(ws, text, sessionId, fallbackAgent) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  let session = sessionId ? loadSession(sessionId) : null;
  const agent = session ? getSessionAgent(session) : normalizeAgent(fallbackAgent);

  switch (cmd) {
    case '/clear': {
      if (session) {
        if (activeProcesses.has(sessionId)) {
          const entry = activeProcesses.get(sessionId);
          killProcess(entry.pid);
          if (entry.tailer) entry.tailer.stop();
          removeActiveProcess(sessionId);
          cleanRunDir(sessionId);
        }
        session.messages = [];
        clearRuntimeSessionId(session);
        session.updated = new Date().toISOString();
        saveSession(session);
        wsSend(ws, {
          type: 'session_info',
          sessionId: session.id,
          messages: [],
          title: session.title,
          mode: session.permissionMode || 'yolo',
          reasoningEffort: session.reasoningEffort || '',
          model: sessionModelLabel(session),
          agent: getSessionAgent(session),
          cwd: session.cwd || null,
          totalCost: session.totalCost || 0,
          totalUsage: session.totalUsage || null,
          lastUsage: session.lastUsage || null,
          contextWindowTokens: session.contextWindowTokens || null,
          queuedMessages: buildQueuedMessagesPayload(session),
          ...buildSessionRuntimeMeta(session),
        });
      }
      wsSend(ws, { type: 'system_message', message: '会话已清除，上下文已重置。' });
      break;
    }

    case '/model': {
      const modelInput = parts.slice(1).join(' ').trim();
      if (agent === 'codex') {
        if (!modelInput) {
          getCodexModelMenuPayload(session).then((payload) => {
            wsSend(ws, payload);
          }).catch((error) => {
            plog('WARN', 'codex_model_menu_failed', { error: error.message });
            wsSend(ws, {
              type: 'model_list',
              agent: 'codex',
              entries: [{
                value: 'default',
                label: '默认模型（Codex）',
                desc: '使用当前 Codex 默认模型',
              }],
              current: session?.model || 'default',
              currentFull: session?.model || '',
              source: null,
            });
          });
        } else {
          const normalizedInput = modelInput.toLowerCase();
          if (session) {
            session.model = normalizedInput === 'default' ? null : modelInput;
            session.updated = new Date().toISOString();
            saveSession(session);
          }
          wsSend(ws, {
          type: 'model_changed',
          model: normalizedInput === 'default' ? '' : modelInput,
          reasoningEffort: session?.reasoningEffort || '',
          ...(session ? buildSessionRuntimeMeta(session) : {}),
          });
          wsSend(ws, {
            type: 'system_message',
            message: normalizedInput === 'default'
              ? 'Codex 模型已切换为: 默认模型（Codex，跟随当前配置）'
              : `Codex 模型已切换为: ${modelInput}`,
          });
        }
      } else if (!modelInput) {
        const currentAlias = session?.model ? modelShortName(session.model) || session.model : 'default';
        const currentFull = session?.model || '';
        wsSend(ws, {
          type: 'model_list',
          agent: 'claude',
          models: MODEL_MAP,
          entries: getClaudeModelMenuEntries(),
          current: currentAlias,
          currentFull,
          source: 'claude-cli',
        });
      } else {
        const resolved = resolveClaudeModelInput(modelInput);
        if (!resolved) {
          wsSend(ws, { type: 'system_message', message: '模型名称不能为空' });
          break;
        }
        const { resolvedModel, resolvedAlias } = resolved;

        // Handle 'default' — use CLI default (no --model flag)
        if (!resolvedModel) {
          if (session) {
            session.model = null;
            session.updated = new Date().toISOString();
            saveSession(session);
          }
          wsSend(ws, {
            type: 'model_changed',
            model: '',
            reasoningEffort: session?.reasoningEffort || '',
            ...(session ? buildSessionRuntimeMeta(session) : {}),
          });
          wsSend(ws, { type: 'system_message', message: '模型已切换为: 默认（使用 CLI 默认模型）' });
          break;
        }

        if (session) {
          session.model = resolvedModel;
          session.updated = new Date().toISOString();
          saveSession(session);
          sendSessionList(ws, { forceRefresh: true });
        }
        const displayName = getClaudeModelMenuLabel(resolvedModel) || getClaudeModelMenuLabel(resolvedAlias) || modelShortName(resolvedModel) || resolvedModel;
        wsSend(ws, {
          type: 'model_changed',
          model: resolvedAlias,
          reasoningEffort: session?.reasoningEffort || '',
          ...(session ? buildSessionRuntimeMeta(session) : {}),
        });
        wsSend(ws, { type: 'system_message', message: `模型已切换为: ${displayName} (${resolvedModel})` });
      }
      break;
    }

    case '/cost': {
      if (agent === 'codex') {
        const usage = session?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
        const inputTotal = Number(usage.inputTokens || 0) || 0;
        const cached = Number(usage.cachedInputTokens || 0) || 0;
        const displayedInput = cached > 0 && inputTotal >= cached ? inputTotal - cached : inputTotal;
        wsSend(ws, {
          type: 'system_message',
          message: `当前会话累计 Token: 输入 ${displayedInput}，缓存 ${cached}，输出 ${usage.outputTokens}`,
        });
      } else {
        const cost = session?.totalCost || 0;
        wsSend(ws, { type: 'system_message', message: `当前会话累计费用: $${cost.toFixed(4)}` });
      }
      break;
    }

    case '/compact': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '当前没有可压缩的会话。请先进入一个已进行过对话的会话后再执行 /compact。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止，再执行 /compact。' });
        break;
      }
      const runtimeId = getRuntimeSessionId(session);
      if (!runtimeId) {
        wsSend(ws, {
          type: 'system_message',
          message: agent === 'codex'
            ? '当前会话尚未建立 Codex 上下文，暂时无需压缩。'
            : '当前会话尚未建立 Claude 上下文，暂时无需压缩。',
        });
        break;
      }

      wsSend(ws, { type: 'system_message', message: compactStartMessage(agent) });
      pendingSlashCommands.set(session.id, { kind: 'compact' });
      handleMessage(ws, { text: '/compact', sessionId: session.id, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
      break;
    }

    case '/mode': {
      const modeInput = parts[1];
      const VALID_MODES = ['default', 'plan', 'yolo'];
      const MODE_DESC = { default: '默认（需权限审批，受限操作）', plan: 'Plan（需确认计划后执行）', yolo: 'YOLO（跳过所有权限检查）' };
      if (!modeInput) {
        const cur = session?.permissionMode || 'yolo';
        wsSend(ws, { type: 'system_message', message: `当前模式: ${MODE_DESC[cur] || cur}\n可选: default, plan, yolo` });
      } else if (VALID_MODES.includes(modeInput.toLowerCase())) {
        const requested = modeInput.toLowerCase();
        const resolved = resolvePermissionModeForAgent(agent, requested);
        const mode = resolved.mode;
        if (session) {
          session.permissionMode = mode;
          clearRuntimeSessionId(session);
          session.updated = new Date().toISOString();
          saveSession(session);
        }
        if (resolved.downgraded) {
          wsSend(ws, { type: 'system_message', message: resolved.message });
        }
        wsSend(ws, { type: 'system_message', message: `权限模式已切换为: ${MODE_DESC[mode]}` });
        wsSend(ws, { type: 'mode_changed', mode });
      } else {
        wsSend(ws, { type: 'system_message', message: `无效模式: ${modeInput}\n可选: default, plan, yolo` });
      }
      break;
    }

    case '/reasoning':
    case '/effort': {
      if (agent !== 'codex') {
        wsSend(ws, { type: 'system_message', message: '思考级别仅对 Codex 会话生效。' });
        break;
      }
      const effortInput = parts[1];
      if (!effortInput) {
        const currentEffort = normalizeCodexReasoningEffort(session?.reasoningEffort);
        wsSend(ws, {
          type: 'system_message',
          message: `当前思考级别: ${currentEffort ? codexReasoningEffortLabel(currentEffort) : '默认（跟随 Codex / 模型默认）'}\n可选: default, ${CODEX_REASONING_EFFORTS.join(', ')}`,
        });
      } else {
        const normalizedInput = effortInput.toLowerCase();
        const effort = normalizedInput === 'default' || normalizedInput === 'auto'
          ? ''
          : normalizeCodexReasoningEffort(normalizedInput);
        if (effort || normalizedInput === 'default' || normalizedInput === 'auto') {
          if (session) {
            session.reasoningEffort = effort;
            clearRuntimeSessionId(session);
            session.updated = new Date().toISOString();
            saveSession(session);
            sendSessionList(ws, { forceRefresh: true });
          }
          wsSend(ws, {
            type: 'reasoning_effort_changed',
            reasoningEffort: effort,
            ...(session ? buildSessionRuntimeMeta(session) : {}),
          });
          wsSend(ws, {
            type: 'system_message',
            message: effort
              ? `Codex 思考级别已切换为: ${codexReasoningEffortLabel(effort)}`
              : 'Codex 思考级别已切换为: 默认（跟随 Codex / 模型默认）',
          });
        } else {
          wsSend(ws, { type: 'system_message', message: `无效思考级别: ${effortInput}\n可选: default, ${CODEX_REASONING_EFFORTS.join(', ')}` });
        }
      }
      break;
    }

    case '/help': {
      const base = '可用指令:\n' +
        '/clear — 清除当前会话（含上下文）\n' +
        '/mode [模式] — 查看/切换权限模式（default, plan, yolo）\n' +
        '/cost — 查看当前会话累计统计\n' +
        '/help — 显示本帮助';
      wsSend(ws, {
        type: 'system_message',
        message: agent === 'codex'
          ? base + '\n/model [名称] — 查看/切换 Codex 模型（自由输入）\n/reasoning [级别] — 查看/切换 Codex 思考级别\n/compact — 执行 Codex /compact 压缩上下文'
          : base + '\n/model [名称] — 查看/切换模型（支持别名或完整模型 ID）\n/compact — 执行 Claude 原生上下文压缩（保留压缩计划并可自动续跑）',
      });
      break;
    }

    default: {
      // For unrecognized slash commands, pass through to the CLI process if a session is active
      if (sessionId && activeProcesses.has(sessionId)) {
        handleMessage(ws, { text, sessionId, mode: session?.permissionMode || 'yolo' }, { hideInHistory: false });
      } else {
        wsSend(ws, { type: 'system_message', message: `未知指令: ${cmd}\n输入 /help 查看可用指令` });
      }
    }
  }
}

// === Session Handlers ===
function handleNewSession(ws, msg) {
  // Creating a new session changes what this browser is viewing. Make sure
  // any previous running process stops streaming to this WebSocket first.
  detachWebSocketFromActiveProcesses(ws, { markDisconnect: true });
  const cwd = (msg && msg.cwd) ? String(msg.cwd) : null;
  const agent = normalizeAgent(msg?.agent);
  const resolvedMode = resolvePermissionModeForAgent(agent, msg?.mode);
  const requestedMode = resolvedMode.mode;
  const requestedReasoningEffort = agent === 'codex' ? normalizeCodexReasoningEffort(msg?.reasoningEffort) : '';
  let projectId = msg?.projectId || null;
  let resolvedCwd = cwd;
  if (!resolvedCwd && projectId) {
    const proj = loadProjectsConfig().projects.find(p => p.id === projectId);
    if (proj) resolvedCwd = proj.path;
  }
  if (!resolvedCwd) {
    resolvedCwd = agent === 'claude' ? (process.env.HOME || process.env.USERPROFILE || process.cwd()) : null;
  }
  if (resolvedCwd) {
    resolvedCwd = normalizeProjectPathKey(resolvedCwd);
  }
  let projectsChanged = false;
  if (!projectId && cwd && resolvedCwd) {
    const ensured = ensureProjectForPath(resolvedCwd);
    if (ensured.project?.id) {
      projectId = ensured.project.id;
      projectsChanged = !!ensured.created;
    }
  }
  const id = crypto.randomUUID();
  const session = {
    id,
    title: 'New Chat',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    agent,
    claudeSessionId: null,
    codexThreadId: null,
    codexRuntimeFingerprint: null,
    runtimeContexts: { claude: {}, codex: {} },
    model: null,
    reasoningEffort: requestedReasoningEffort,
    permissionMode: requestedMode,
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    messages: [],
    cwd: resolvedCwd,
    projectId,
  };
  saveSession(session);
  wsSessionMap.set(ws, id);
  if (projectsChanged) {
    wsSend(ws, { type: 'projects_config', projects: loadProjectsConfig().projects });
  }
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: [],
    title: session.title,
    mode: session.permissionMode,
    reasoningEffort: session.reasoningEffort || '',
    model: sessionModelLabel(session),
    agent,
    cwd: session.cwd,
    projectId: session.projectId,
    totalCost: 0,
    totalUsage: session.totalUsage,
    lastUsage: session.lastUsage || null,
    contextWindowTokens: session.contextWindowTokens || null,
    queuedMessages: buildQueuedMessagesPayload(session),
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    ...buildSessionRuntimeMeta(session),
  });
  if (resolvedMode.downgraded) {
    wsSend(ws, { type: 'system_message', message: resolvedMode.message });
    wsSend(ws, { type: 'mode_changed', mode: resolvedMode.mode });
  }
  sendSessionList(ws);
}



function handoffRoleLabel(role) {
  if (role === 'assistant') return '助手';
  if (role === 'system') return '系统';
  return '用户';
}

function messageTextForAiHandoff(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [];
  if (typeof message.content === 'string' && message.content.trim()) {
    parts.push(message.content.trim());
  }
  if (Array.isArray(message.segments) && message.segments.length > 0) {
    const segmentText = message.segments
      .map((segment) => {
        if (!segment || typeof segment !== 'object') return '';
        if (typeof segment.text === 'string' && segment.text.trim()) return segment.text.trim();
        if (segment.type === 'tool_call') {
          const name = segment.name || 'Tool';
          const status = segment.done === false ? 'running' : 'done';
          const result = typeof segment.result === 'string' ? truncateReplayText(segment.result, 500) : '';
          return `[工具 ${name} ${status}]${result ? ` ${result}` : ''}`;
        }
        if (segment.type === 'image') return `[图片] ${segment.prompt || segment.alt || ''}`.trim();
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (segmentText) parts.push(segmentText);
  }
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length > 0) {
    parts.push(`附件: ${attachments.map((item) => item?.filename || item?.id || 'image').filter(Boolean).join(', ')}`);
  }
  const fileRefs = Array.isArray(message.fileRefs) ? message.fileRefs : [];
  if (fileRefs.length > 0) {
    parts.push(`引用文件: ${fileRefs.map((item) => item?.relativePath || item?.path || '').filter(Boolean).join(', ')}`);
  }
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  if (toolCalls.length > 0 && !parts.some((part) => /\[工具 /.test(part))) {
    parts.push(`工具调用: ${toolCalls.map((tool) => tool?.name || tool?.type || 'tool').filter(Boolean).join(', ')}`);
  }
  return truncateReplayText(parts.join('\n'), HANDOFF_AI_MESSAGE_CHAR_LIMIT);
}

function buildAiHandoffTranscript(messages) {
  const blocks = (Array.isArray(messages) ? messages : [])
    .map((message, index) => {
      const text = messageTextForAiHandoff(message);
      if (!text) return '';
      const ts = message.timestamp ? ` @ ${message.timestamp}` : '';
      return `#${index + 1} [${handoffRoleLabel(message.role)}${ts}]\n${text}`;
    })
    .filter(Boolean);
  const full = blocks.join('\n\n');
  if (full.length <= HANDOFF_AI_TRANSCRIPT_CHAR_BUDGET) return full;

  const headBudget = Math.min(18000, Math.floor(HANDOFF_AI_TRANSCRIPT_CHAR_BUDGET * 0.25));
  const tailBudget = HANDOFF_AI_TRANSCRIPT_CHAR_BUDGET - headBudget - 240;
  const head = [];
  let headChars = 0;
  for (const block of blocks) {
    const next = block.length + 2;
    if (headChars + next > headBudget) break;
    head.push(block);
    headChars += next;
  }
  const tail = [];
  let tailChars = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const next = block.length + 2;
    if (tailChars + next > tailBudget) break;
    tail.unshift(block);
    tailChars += next;
  }
  const skipped = Math.max(0, blocks.length - head.length - tail.length);
  return [
    ...head,
    `[中间有 ${skipped} 条较早消息因长度限制省略；请主要依据首尾上下文，尤其是最近消息判断当前状态。]`,
    ...tail,
  ].join('\n\n');
}

function buildAiHandoffSummaryPrompt(sourceSession, newTask, attachments = []) {
  const transcript = buildAiHandoffTranscript(sourceSession?.messages || []);
  const sourceTitle = sourceSession?.title || '旧窗口';
  const taskText = formatCurrentInputForCarryover(newTask, attachments);
  return [
    '你是 Webcoding 的“新窗口接力分析器”。你的任务不是聊天回复，而是阅读旧窗口记录，并针对用户输入的新任务生成一份交接分析文档。',
    '',
    '重要要求：',
    '- 不要直接复制聊天记录。',
    '- 必须根据“新任务”判断哪些旧上下文重要、哪些可以忽略。',
    '- 重点还原当前进度、已确定方案、未完成事项、风险/坑、下一步可执行计划。',
    '- 如果旧记录里有冲突，以最新消息和新任务为准。',
    '- 写给即将在新窗口继续工作的 AI，要求它能不问用户就继续干活。',
    '- 使用中文，结构清晰，尽量精炼但不要遗漏关键事实。',
    '',
    '请严格输出以下 Markdown 结构：',
    '## 接力目标',
    '## 与新任务最相关的旧窗口结论',
    '## 当前进度和状态',
    '## 已修改/涉及的文件、接口或命令',
    '## 未完成事项和下一步执行计划',
    '## 风险、坑和不要重复做的事',
    '## 给新窗口 AI 的执行指令',
    '',
    '[来源窗口元信息]',
    `标题: ${sourceTitle}`,
    `Agent: ${getSessionAgent(sourceSession)}`,
    sourceSession?.cwd ? `工作目录: ${sourceSession.cwd}` : '工作目录: 未记录',
    sourceSession?.projectId ? `项目ID: ${sourceSession.projectId}` : '',
    '',
    '[用户输入的新任务]',
    taskText,
    '',
    '[旧窗口聊天记录]',
    transcript || '旧窗口没有可用聊天记录。',
  ].filter((line) => line !== '').join('\n');
}

function runAgentOnceForText(session, inputText, options = {}) {
  return new Promise((resolve, reject) => {
    const agent = getSessionAgent(session);
    const spawnSpec = agent === 'codex'
      ? buildCodexSpawnSpec(session, { attachments: [] })
      : buildClaudeSpawnSpec(session, { attachments: [] });
    if (spawnSpec?.error) return reject(new Error(spawnSpec.error));

    let proc;
    const entry = {
      pid: 0,
      ws: null,
      clients: new Set(),
      agent,
      fullText: '',
      toolCalls: [],
      segments: [],
      lastCost: null,
      lastUsage: null,
      lastError: null,
      errorSent: false,
      claudeRuntimeFingerprint: agent === 'claude' ? (spawnSpec.runtimeFingerprint || null) : null,
      codexRuntimeFingerprint: agent === 'codex' ? (spawnSpec.runtimeFingerprint || null) : null,
      runtimeChannelKey: spawnSpec.channelKey || null,
      runtimeChannelDescriptor: spawnSpec.channelDescriptor || null,
    };
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = Number(options.timeoutMs || HANDOFF_AI_TIMEOUT_MS) || HANDOFF_AI_TIMEOUT_MS;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }

    function consumeLine(line) {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        processRuntimeEvent(entry, event, session.id);
      } catch {
        entry.fullText += `${trimmed}\n`;
      }
    }

    const timer = setTimeout(() => {
      try { if (proc?.pid) killProcess(proc.pid, true); } catch {}
      settle(reject, new Error('AI 交接分析超时'));
    }, timeoutMs);

    try {
      proc = spawn(spawnSpec.command, spawnSpec.args, {
        env: spawnSpec.env,
        cwd: spawnSpec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        shell: !!spawnSpec.useShell,
      });
    } catch (error) {
      clearTimeout(timer);
      return reject(error);
    }
    entry.pid = proc.pid;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (error) => settle(reject, error));
    proc.on('exit', (code, signal) => {
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
      const text = normalizeReplayText(entry.fullText);
      if (code === 0 && text) return settle(resolve, text);
      if (text) return settle(resolve, text);
      const reason = entry.lastError || stderr.trim() || `AI 交接分析进程退出：${code ?? signal ?? 'unknown'}`;
      settle(reject, new Error(reason));
    });
    proc.stdin.end(inputText);
  });
}

async function generateAiHandoffSummary(sourceSession, newTask, attachments = [], options = {}) {
  const agent = normalizeAgent(options.agent || sourceSession?.agent);
  const requestedMode = resolvePermissionModeForAgent(agent, 'plan').mode;
  const scratchSession = {
    id: `handoff-ai-${crypto.randomUUID()}`,
    title: 'handoff-ai-summary',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    agent,
    claudeSessionId: null,
    codexThreadId: null,
    codexRuntimeFingerprint: null,
    runtimeContexts: { claude: {}, codex: {} },
    model: sourceSession?.model || null,
    reasoningEffort: agent === 'codex' ? normalizeCodexReasoningEffort(sourceSession?.reasoningEffort) : '',
    permissionMode: requestedMode,
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    messages: [],
    cwd: sourceSession?.cwd || null,
    projectId: sourceSession?.projectId || null,
  };
  const prompt = buildAiHandoffSummaryPrompt(sourceSession, newTask, attachments);
  const summary = await runAgentOnceForText(scratchSession, prompt, { timeoutMs: HANDOFF_AI_TIMEOUT_MS });
  const normalized = normalizeReplayText(summary);
  if (!normalized) throw new Error('AI 没有返回交接分析');
  return normalized.length > HANDOFF_AI_SUMMARY_MAX_CHARS
    ? `${normalized.slice(0, HANDOFF_AI_SUMMARY_MAX_CHARS - 16).trimEnd()}\n[AI 交接分析已截断]`
    : normalized;
}

function buildHandoffRuntimePrompt(sourceSession, newTask, attachments = []) {
  const history = Array.isArray(sourceSession?.messages) ? sourceSession.messages.filter(Boolean) : [];
  const recentBlocks = collectRecentCarryoverMessages(history);
  const summary = buildCarryoverSummary(sourceSession, history, newTask, attachments);
  const sourceTitle = sourceSession?.title || '旧窗口';
  const sourceCwd = sourceSession?.cwd || '';
  const taskText = formatCurrentInputForCarryover(newTask, attachments);
  const lines = [
    '[webcoding 接力新窗口]',
    '当前会话是从另一个旧窗口自动接力创建的。旧窗口上下文较长，下面是系统整理出的交接内容。',
    '请先吸收这些内容，不要逐段复述，不要让用户重新整理进度；直接基于交接内容继续完成“新任务”。',
    '如果交接摘要、最近对话和新任务之间有冲突，以“新任务”和用户最近明确要求为准。',
    '',
    '[来源窗口]',
    `标题: ${sourceTitle}`,
    sourceCwd ? `工作目录: ${sourceCwd}` : '',
    `Agent: ${getSessionAgent(sourceSession)}`,
    '',
    '[结构化交接摘要]',
    summary.text,
  ].filter((line) => line !== '');

  if (recentBlocks.length > 0) {
    lines.push('', '[最近对话原文]', recentBlocks.join('\n\n'));
  }

  lines.push('', '[新任务]', taskText);
  return {
    prompt: lines.join('\n'),
    summaryText: summary.text,
    summaryDetailed: summary.detailed,
    recentCount: recentBlocks.length,
    historyCount: history.length,
  };
}

function handoffSessionTitle(newTask, sourceSession) {
  const lead = extractCarryoverLead(newTask) || sourceSession?.title || '继续当前任务';
  return `接力: ${lead}`.slice(0, 80);
}

async function handleHandoffSession(ws, msg) {
  const sourceSessionId = String(msg?.sourceSessionId || msg?.sessionId || '').trim();
  const sourceSession = loadSession(sourceSessionId);
  if (!sourceSession) {
    return wsSend(ws, { type: 'error', sessionId: sourceSessionId || undefined, message: '接力失败：找不到来源会话。' });
  }
  if (activeProcesses.has(sourceSessionId)) {
    return wsSend(ws, { type: 'error', sessionId: sourceSessionId, message: '接力失败：当前窗口仍在运行，请等待完成或停止后再接力。' });
  }

  const sourceAgent = getSessionAgent(sourceSession);
  const requestedAgent = normalizeAgent(msg?.agent || sourceAgent);
  const agent = requestedAgent || sourceAgent;
  const resolvedMode = resolvePermissionModeForAgent(agent, msg?.mode || sourceSession.permissionMode || 'yolo');
  const requestedReasoningEffort = agent === 'codex'
    ? normalizeCodexReasoningEffort(Object.prototype.hasOwnProperty.call(msg || {}, 'reasoningEffort') ? msg.reasoningEffort : sourceSession.reasoningEffort)
    : '';
  const newTask = typeof msg?.newTask === 'string'
    ? msg.newTask
    : (typeof msg?.text === 'string' ? msg.text : '');
  const normalizedTask = normalizeReplayText(newTask);
  const attachments = Array.isArray(msg?.attachments) ? msg.attachments.slice(0, MAX_MESSAGE_ATTACHMENTS) : [];
  const resolvedAttachments = resolveMessageAttachments(attachments);
  if (attachments.length > 0 && resolvedAttachments.length === 0) {
    return wsSend(ws, { type: 'error', sessionId: sourceSessionId, message: '接力失败：图片附件已过期或不可用，请重新上传后再接力。' });
  }
  const cwdForFileRefs = sourceSession.cwd || process.cwd();
  const resolvedFileRefResult = normalizeContextFileRefs(msg?.fileRefs, cwdForFileRefs);
  if (resolvedFileRefResult.error) {
    return wsSend(ws, { type: 'error', sessionId: sourceSessionId, message: `接力失败：${resolvedFileRefResult.error}` });
  }
  if (!normalizedTask && resolvedAttachments.length === 0 && resolvedFileRefResult.refs.length === 0) {
    return wsSend(ws, { type: 'error', sessionId: sourceSessionId, message: '接力失败：请输入要在新窗口继续的新任务。' });
  }

  wsSend(ws, {
    type: 'system_message',
    sessionId: sourceSessionId,
    message: '正在调用 AI 分析旧窗口，并根据新任务生成交接文档…',
  });

  let aiSummary = '';
  try {
    aiSummary = await generateAiHandoffSummary(sourceSession, normalizedTask, resolvedAttachments, { agent });
  } catch (error) {
    return wsSend(ws, {
      type: 'error',
      sessionId: sourceSessionId,
      message: `接力失败：AI 交接分析没有完成（${error?.message || String(error)}）`,
    });
  }

  detachWebSocketFromActiveProcesses(ws, { markDisconnect: true });

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const sourceTitle = sourceSession.title || '旧窗口';
  const taskText = formatCurrentInputForCarryover(normalizedTask, resolvedAttachments);
  const handoff = {
    prompt: [
      '[webcoding 接力新窗口]',
      '这是 AI 已经根据旧窗口聊天记录和用户新任务分析出的交接文档。',
      '请不要再要求用户重新整理进度；直接基于交接文档和新任务继续执行。',
      '',
      '[来源窗口]',
      `标题: ${sourceTitle}`,
      sourceSession.cwd ? `工作目录: ${sourceSession.cwd}` : '',
      `Agent: ${getSessionAgent(sourceSession)}`,
      '',
      '[AI 交接分析文档]',
      aiSummary,
      '',
      '[新任务]',
      taskText,
    ].filter((line) => line !== '').join('\n'),
    summaryText: aiSummary,
    summaryDetailed: true,
    recentCount: 0,
    historyCount: Array.isArray(sourceSession.messages) ? sourceSession.messages.length : 0,
  };
  const handoffNotice = `已创建接力新窗口：AI 已根据新任务分析 ${handoff.historyCount} 条旧窗口消息，并生成交接文档。`;
  const handoffSummaryMessage = [
    `接力来源：${sourceTitle}`,
    sourceSession.cwd ? `工作目录：${sourceSession.cwd}` : '',
    '',
    '自动交接摘要：',
    handoff.summaryText || '已自动生成交接摘要。',
    '',
    '新任务：',
    normalizedTask || '请继续处理接力任务。',
  ].filter((line) => line !== '').join('\n');
  const session = {
    id,
    title: handoffSessionTitle(normalizedTask, sourceSession),
    created: now,
    updated: now,
    agent,
    claudeSessionId: null,
    codexThreadId: null,
    codexRuntimeFingerprint: null,
    runtimeContexts: { claude: {}, codex: {} },
    model: sourceSession.model || null,
    reasoningEffort: requestedReasoningEffort,
    permissionMode: resolvedMode.mode,
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    messages: [{ role: 'system', content: handoffSummaryMessage, timestamp: now }],
    cwd: sourceSession.cwd || null,
    projectId: sourceSession.projectId || null,
    handoff: {
      sourceSessionId,
      sourceTitle: sourceSession.title || '',
      createdAt: now,
    },
  };
  saveSession(session);
  wsSessionMap.set(ws, id);

  handleMessage(ws, {
    type: 'message',
    sessionId: id,
    text: normalizedTask || '请继续处理接力任务。',
    attachments,
    fileRefs: msg?.fileRefs,
    mode: resolvedMode.mode,
    reasoningEffort: requestedReasoningEffort,
    agent,
  }, {
    runtimeInputText: handoff.prompt,
    emitSessionInfo: true,
  });

  wsSend(ws, { type: 'system_message', sessionId: id, message: handoffNotice });

  if (resolvedMode.downgraded) {
    wsSend(ws, { type: 'system_message', sessionId: id, message: resolvedMode.message });
    wsSend(ws, { type: 'mode_changed', sessionId: id, mode: resolvedMode.mode });
  }
}

function handleLoadSession(ws, sessionId) {
  const session = loadSession(sessionId);
  if (!session) {
    return wsSend(ws, { type: 'error', message: 'Session not found' });
  }
  const preferredClaudeRuntimeId = getSessionAgent(session) === 'claude'
    ? getPreferredRuntimeSessionId(session, 'claude')
    : null;
  if (getSessionAgent(session) === 'claude' && !session.cwd && preferredClaudeRuntimeId) {
    const localMeta = resolveClaudeSessionLocalMeta(preferredClaudeRuntimeId);
    if (localMeta?.cwd) {
      session.cwd = localMeta.cwd;
      if (!session.importedFrom && localMeta.projectDir) session.importedFrom = localMeta.projectDir;
      saveSession(session);
    }
  }
  if (session.cwd && !session.projectId) {
    const ensured = ensureProjectForPath(session.cwd);
    if (ensured.project?.id) {
      session.projectId = ensured.project.id;
      saveSession(session);
      if (ensured.created) {
        wsSend(ws, { type: 'projects_config', projects: loadProjectsConfig().projects });
      }
    }
  }
  const { recentMessages, olderChunks } = splitHistoryMessages(session.messages);
  const effectiveCwd = session.cwd || activeProcesses.get(sessionId)?.cwd || null;

  // Detach ws from any previous session's process
  detachWebSocketFromActiveProcesses(ws, { markDisconnect: true });

  wsSessionMap.set(ws, sessionId);

  // Read and clear unread flag
  const hadUnread = !!session.hasUnread;
  if (session.hasUnread) {
    session.hasUnread = false;
    saveSession(session);
  }

  wsSend(ws, {
    type: 'session_info',
    sessionId: session.id,
    messages: recentMessages,
    title: session.title,
    mode: session.permissionMode || 'yolo',
    reasoningEffort: session.reasoningEffort || '',
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    hasUnread: hadUnread,
    cwd: effectiveCwd,
    projectId: session.projectId || null,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    lastUsage: session.lastUsage || null,
    contextWindowTokens: session.contextWindowTokens || null,
    queuedMessages: buildQueuedMessagesPayload(session),
    historyTotal: session.messages.length,
    historyBuffered: recentMessages.length,
    historyPending: olderChunks.length > 0,
    updated: session.updated,
    isRunning: activeProcesses.has(sessionId),
    ...buildSessionRuntimeMeta(session),
  });

  if (olderChunks.length > 0) {
    sendHistoryChunks(ws, session.id, olderChunks);
  }

  // Resume streaming if process is still active
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    attachWebSocketToProcess(entry, ws); // clear disconnect marker
    plog('INFO', 'ws_resume_attach', {
      sessionId: sessionId.slice(0, 8),
      pid: entry.pid,
      responseLen: (entry.fullText || '').length,
    });
    wsSend(ws, {
      type: 'resume_generating',
      sessionId,
      text: entry.fullText || '',
      toolCalls: entry.toolCalls || [],
      segments: entry.segments || [],
    });
  }
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function deleteClaudeLocalSession(claudeSessionId) {
  const safeId = sanitizeId(claudeSessionId);
  if (!safeId) return;
  const projectsDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const target = path.join(projectsDir, proj, `${safeId}.jsonl`);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  } catch {}
}

async function deleteCodexLocalSession(threadId, importedRolloutPath = null) {
  if (!threadId || !/^[a-zA-Z0-9\-]+$/.test(String(threadId))) {
    return { removedFiles: 0, removedDbRows: false };
  }

  const rolloutPaths = new Set();
  if (importedRolloutPath) rolloutPaths.add(path.resolve(importedRolloutPath));
  try {
    for (const filePath of getCodexRolloutFiles()) {
      if (filePath.includes(threadId)) rolloutPaths.add(path.resolve(filePath));
    }
  } catch {}

  let removedFiles = 0;
  for (const filePath of rolloutPaths) {
    try {
      if ((filePath.startsWith(CODEX_SESSIONS_DIR) || filePath.startsWith(CODEX_RUNTIME_SESSIONS_DIR)) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removedFiles++;
      }
    } catch {}
  }

  let removedDbRows = false;
  try {
    const sqliteAvailable = await execFileQuiet('sqlite3', ['-version']);
    if (sqliteAvailable.ok) {
      const quotedThreadId = sqlQuote(threadId);
      const stateSql = [
        'PRAGMA foreign_keys = ON;',
        `DELETE FROM thread_dynamic_tools WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM stage1_outputs WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM logs WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM threads WHERE id = ${quotedThreadId};`,
      ].join(' ');
      const stateResult = await execFileQuiet('sqlite3', [CODEX_STATE_DB_PATH, stateSql]);
      if (stateResult.ok) removedDbRows = true;

      if (fs.existsSync(CODEX_LOG_DB_PATH)) {
        await execFileQuiet('sqlite3', [CODEX_LOG_DB_PATH, `DELETE FROM logs WHERE thread_id = ${quotedThreadId};`]);
      }
    }
  } catch {}

  return { removedFiles, removedDbRows };
}

function deleteSessionById(sessionId) {
  pendingSlashCommands.delete(sessionId);
  pendingCompactRetries.delete(sessionId);
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    try { killProcess(entry.pid); } catch {}
    if (entry.tailer) entry.tailer.stop();
    removeActiveProcess(sessionId);
    sendRuntimeMessage(entry, { type: 'done', sessionId });
  }
  cleanRunDir(sessionId);
  const p = sessionPath(sessionId);
  const session = loadSession(sessionId);
  const sessionAgent = getSessionAgent(session);
  for (const attachmentId of collectSessionAttachmentIds(session)) {
    removeAttachmentById(attachmentId);
  }
  let deleted = false;
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    invalidateImportedSessionIdsCache();
    deleted = true;
  }
  invalidateSessionListCache();
  if (sessionAgent === 'codex') {
    const codexThreadIds = getAllRuntimeSessionIds(session, 'codex');
    Promise.all(codexThreadIds.map((threadId) => deleteCodexLocalSession(
      threadId,
      session?.importedRolloutPath || null
    ).then((result) => ({ threadId, result })))).then((results) => {
      for (const item of results) {
        plog('INFO', 'codex_local_session_deleted', {
          sessionId: sessionId.slice(0, 8),
          threadId: item.threadId,
          removedFiles: item.result.removedFiles,
          removedDbRows: item.result.removedDbRows,
        });
      }
    }).catch((error) => {
      plog('WARN', 'codex_local_session_delete_failed', {
        sessionId: sessionId.slice(0, 8),
        threadIds: codexThreadIds,
        error: error?.message || String(error),
      });
    });
  } else {
    for (const runtimeId of getAllRuntimeSessionIds(session, 'claude')) {
      deleteClaudeLocalSession(runtimeId);
    }
  }
  return { deleted, session, sessionAgent };
}

function handleDeleteSession(ws, sessionId) {
  try {
    deleteSessionById(sessionId);
    sendSessionList(ws);
  } catch {
    wsSend(ws, { type: 'error', message: 'Failed to delete session' });
  }
}

function handleRenameSession(ws, sessionId, title) {
  const safeSessionId = sanitizeId(sessionId);
  if (!safeSessionId || !title) return;
  const session = loadSession(safeSessionId);
  if (session) {
    session.title = String(title).slice(0, 100);
    session.updated = new Date().toISOString();
    saveSession(session);
    sendSessionList(ws);
    wsSend(ws, { type: 'session_renamed', sessionId: safeSessionId, title: session.title });
  }
}

function handleSetMode(ws, sessionId, mode, rawAgent = null) {
  if (!mode || !VALID_PERMISSION_MODES.has(mode)) return;
  let resolved = resolvePermissionModeForAgent(rawAgent, mode);
  if (sessionId) {
    const session = loadSession(sessionId);
    if (session) {
      resolved = resolvePermissionModeForAgent(getSessionAgent(session), mode);
      session.permissionMode = resolved.mode;
      clearRuntimeSessionId(session);
      session.updated = new Date().toISOString();
      saveSession(session);
    }
  }
  if (resolved.downgraded) {
    wsSend(ws, { type: 'system_message', message: resolved.message });
  }
  wsSend(ws, { type: 'mode_changed', mode: resolved.mode });
}

function handleSetReasoningEffort(ws, sessionId, rawEffort) {
  const normalizedInput = String(rawEffort || '').trim().toLowerCase();
  const effort = normalizedInput === 'default' || normalizedInput === 'auto'
    ? ''
    : normalizeCodexReasoningEffort(normalizedInput);
  if (normalizedInput && !effort && normalizedInput !== 'default' && normalizedInput !== 'auto') return;
  if (sessionId) {
    const session = loadSession(sessionId);
    if (session && getSessionAgent(session) === 'codex') {
      session.reasoningEffort = effort;
      clearRuntimeSessionId(session);
      session.updated = new Date().toISOString();
      saveSession(session);
      sendSessionList(ws, { forceRefresh: true });
    }
  }
  wsSend(ws, { type: 'reasoning_effort_changed', reasoningEffort: effort });
}

function handleDisconnect(ws, wsId) {
  const affectedSessions = [];
  for (const [sid, entry] of activeProcesses) {
    if (detachWebSocketFromProcess(entry, ws, { markDisconnect: true })) {
      affectedSessions.push({
        sessionId: sid.slice(0, 8),
        pid: entry.pid,
        stillConnected: isProcessRealtimeConnected(entry),
      });
    }
  }
  wsSessionMap.delete(ws);
  plog('INFO', 'ws_disconnect', { wsId, activeProcessesAffected: affectedSessions });
}

function detachWebSocketFromActiveProcesses(ws, options = {}) {
  const markDisconnect = options.markDisconnect === true;
  for (const [, entry] of activeProcesses) {
    detachWebSocketFromProcess(entry, ws, { markDisconnect });
  }
}

function handleDetachView(ws) {
  detachWebSocketFromActiveProcesses(ws, { markDisconnect: true });
  wsSessionMap.delete(ws);
}

function forceLogoutClient(ws, message) {
  if (!ws) return;
  handleDetachView(ws);
  ws.isAuthenticated = false;
  ws.authToken = null;
  if (ws.readyState === 1) {
    wsSend(ws, { type: 'force_logout', message: message || '登录状态已失效，请重新登录。' });
  }
}

function handleAbort(ws) {
  const sessionId = wsSessionMap.get(ws);
  if (!sessionId) return;
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  plog('INFO', 'user_abort', { sessionId: sessionId.slice(0, 8), pid: entry.pid });
  killProcess(entry.pid);
  setTimeout(() => {
    const activeEntry = activeProcesses.get(sessionId);
    if (activeEntry && activeEntry.pid === entry.pid) {
      killProcess(entry.pid, true);
    }
  }, 3000);
  // handleProcessComplete will be triggered by the PID monitor
}


function buildQueueItemFromClientMessage(session, msg) {
  const textValue = typeof msg.text === 'string' ? msg.text : '';
  const normalizedText = textValue.trim();
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, MAX_MESSAGE_ATTACHMENTS) : [];
  const resolvedAttachments = resolveMessageAttachments(attachments);
  if (attachments.length > 0 && resolvedAttachments.length === 0) {
    return { error: '图片附件已过期或不可用，请重新上传后再发送。' };
  }
  const cwdForFileRefs = session?.cwd || process.cwd();
  const resolvedFileRefResult = normalizeContextFileRefs(msg.fileRefs, cwdForFileRefs);
  if (resolvedFileRefResult.error) return { error: resolvedFileRefResult.error };
  const resolvedFileRefs = resolvedFileRefResult.refs;
  if (!normalizedText && resolvedAttachments.length === 0 && resolvedFileRefs.length === 0) return { error: '消息内容为空。' };
  if (normalizedText.startsWith('/') && (resolvedAttachments.length > 0 || resolvedFileRefs.length > 0)) {
    return { error: '命令消息暂不支持同时附带图片或文件引用。请先发送普通消息，再单独使用命令。' };
  }
  const savedAttachments = resolvedAttachments.map((attachment) => ({
    id: attachment.id,
    kind: 'image',
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    createdAt: attachment.createdAt,
    expiresAt: attachment.expiresAt,
    storageState: attachment.storageState,
  }));
  return {
    item: {
      id: sanitizeId(msg.id || '') || crypto.randomUUID(),
      sessionId: session.id,
      text: textValue,
      attachments: savedAttachments,
      fileRefs: resolvedFileRefs.map(fileRefHistoryMeta),
      mode: typeof msg.mode === 'string' ? msg.mode : (session.permissionMode || 'yolo'),
      reasoningEffort: normalizeCodexReasoningEffort(msg.reasoningEffort),
      agent: normalizeAgent(msg.agent || session.agent),
      createdAt: new Date().toISOString(),
    },
  };
}

function handleEnqueueMessage(ws, msg) {
  const sessionId = sanitizeId(msg.sessionId || '');
  const session = sessionId ? loadSession(sessionId) : null;
  if (!session) return wsSend(ws, { type: 'error', message: '当前会话尚未建立，无法加入服务端队列。' });
  if (!Array.isArray(session.queuedMessages)) session.queuedMessages = [];
  if (session.queuedMessages.length >= MAX_SERVER_QUEUED_MESSAGES) {
    return wsSend(ws, { type: 'error', message: `最多排队 ${MAX_SERVER_QUEUED_MESSAGES} 条消息，请先撤销一部分。` });
  }
  const built = buildQueueItemFromClientMessage(session, msg);
  if (built.error) return wsSend(ws, { type: 'error', message: built.error });
  session.queuedMessages.push(built.item);
  session.updated = new Date().toISOString();
  saveSession(session);
  sendQueueUpdateForSession(session.id);
  wsSend(ws, { type: 'queue_update', sessionId: session.id, queuedMessages: buildQueuedMessagesPayload(session) });
  plog('INFO', 'server_queue_enqueue', { sessionId: session.id.slice(0, 8), queueLen: session.queuedMessages.length });
  if (!activeProcesses.has(session.id)) {
    setTimeout(() => dispatchNextServerQueuedMessage(session.id), 20);
  }
}

function handleCancelQueuedMessage(ws, msg) {
  const sessionId = sanitizeId(msg.sessionId || '');
  const id = sanitizeId(msg.id || '');
  const session = sessionId ? loadSession(sessionId) : null;
  if (!session || !id) return;
  const before = Array.isArray(session.queuedMessages) ? session.queuedMessages.length : 0;
  session.queuedMessages = (session.queuedMessages || []).filter((item) => item.id !== id);
  if (session.queuedMessages.length !== before) {
    session.updated = new Date().toISOString();
    saveSession(session);
    sendQueueUpdateForSession(session.id);
    wsSend(ws, { type: 'queue_update', sessionId: session.id, queuedMessages: buildQueuedMessagesPayload(session) });
    plog('INFO', 'server_queue_cancel', { sessionId: session.id.slice(0, 8), queueLen: session.queuedMessages.length });
  }
}

function createClosedQueueWs() {
  return {
    readyState: 0,
    isAuthenticated: true,
    isServerQueueClient: true,
    send() {},
  };
}

function dispatchNextServerQueuedMessage(sessionId) {
  if (!sessionId || activeProcesses.has(sessionId)) return false;
  const session = loadSession(sessionId);
  if (!session || !Array.isArray(session.queuedMessages) || session.queuedMessages.length === 0) return false;
  const [item] = session.queuedMessages;
  session.queuedMessages = session.queuedMessages.slice(1);
  session.updated = new Date().toISOString();
  saveSession(session);
  sendQueueUpdateForSession(sessionId);

  const viewers = getSessionViewerClients(sessionId);
  const dispatchWs = viewers[0] || createClosedQueueWs();
  const payload = {
    ...item,
    sessionId,
    type: 'message',
    mode: item.mode || session.permissionMode || 'yolo',
    reasoningEffort: item.reasoningEffort || session.reasoningEffort || '',
    agent: normalizeAgent(item.agent || session.agent),
  };
  const text = String(payload.text || '').trim();
  if (!text.startsWith('/')) {
    broadcastToSessionViewers(sessionId, { type: 'queued_message_dispatched', sessionId, message: buildQueuedMessagesPayload({ ...session, queuedMessages: [item] })[0] });
  }
  plog('INFO', 'server_queue_dispatch', { sessionId: sessionId.slice(0, 8), remaining: session.queuedMessages.length });
  try {
    if (text.startsWith('/')) handleSlashCommand(dispatchWs, text, sessionId, payload.agent);
    else handleMessage(dispatchWs, payload);
  } finally {
    if (dispatchWs.isServerQueueClient) wsSessionMap.delete(dispatchWs);
  }
  const sessions = getSessionListSnapshot({ forceRefresh: true });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated === true) {
      sendSessionList(client, { sessions });
    }
  }
  setTimeout(() => {
    if (!activeProcesses.has(sessionId)) dispatchNextServerQueuedMessage(sessionId);
  }, 200);
  return true;
}

// === Runtime Message Handler ===
function handleMessage(ws, msg, options = {}) {
  const { text, sessionId, mode } = msg;
  const { hideInHistory = false, runtimeInputText = null, emitSessionInfo = false } = options;
  const textValue = typeof text === 'string' ? text : '';
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, MAX_MESSAGE_ATTACHMENTS) : [];
  const normalizedText = textValue.trim();
  const resolvedAttachments = resolveMessageAttachments(attachments);
  if (attachments.length > 0 && resolvedAttachments.length === 0) {
    return wsSend(ws, { type: 'error', message: '图片附件已过期或不可用，请重新上传后再发送。' });
  }
  const pendingSession = sessionId ? loadSession(sessionId) : null;
  const cwdForFileRefs = pendingSession?.cwd || process.cwd();
  const resolvedFileRefResult = normalizeContextFileRefs(msg.fileRefs, cwdForFileRefs);
  if (resolvedFileRefResult.error) {
    return wsSend(ws, { type: 'error', message: resolvedFileRefResult.error });
  }
  const resolvedFileRefs = resolvedFileRefResult.refs;
  if (!normalizedText && resolvedAttachments.length === 0 && resolvedFileRefs.length === 0) return;

  const savedAttachments = resolvedAttachments.map((attachment) => ({
    id: attachment.id,
    kind: 'image',
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    createdAt: attachment.createdAt,
    expiresAt: attachment.expiresAt,
    storageState: attachment.storageState,
  }));
  const savedFileRefs = resolvedFileRefs.map(fileRefHistoryMeta);
  const effectiveInputText = buildContextFilePrompt(textValue, resolvedFileRefs);
  const runtimeInputBaseText = typeof runtimeInputText === 'string'
    ? buildContextFilePrompt(runtimeInputText, resolvedFileRefs)
    : effectiveInputText;
  const messageAgent = normalizeAgent(msg.agent);

  if (sessionId && activeProcesses.has(sessionId)) {
    const runningSession = loadSession(sessionId);
    if (
      runningSession &&
      isClaudeSession(runningSession) &&
      runningSession.permissionMode === 'plan' &&
      (normalizedText || resolvedFileRefs.length > 0) &&
      resolvedAttachments.length === 0
    ) {
      // Plan mode: forward user input to the waiting process via stdin (input.txt append)
      const inputPath = path.join(runDir(sessionId), 'input.txt');
      try {
        fs.appendFileSync(inputPath, effectiveInputText + '\n');
        if (!hideInHistory) {
          runningSession.messages.push({ role: 'user', content: textValue, attachments: [], fileRefs: savedFileRefs, timestamp: new Date().toISOString() });
          runningSession.updated = new Date().toISOString();
          saveSession(runningSession);
          const entry = activeProcesses.get(sessionId);
          if (entry) attachWebSocketToProcess(entry, ws);
        }
      } catch (err) {
        wsSend(ws, { type: 'error', message: '无法写入确认输入：' + err.message });
      }
      return;
    }
    return handleEnqueueMessage(ws, { ...msg, sessionId });
  }

  const derivedTitle = normalizedText
    ? textValue.slice(0, 60).replace(/\n/g, ' ')
    : (savedFileRefs.length > 0
      ? `引用文件: ${savedFileRefs[0]?.relativePath || 'file'}`
      : `图片: ${savedAttachments[0]?.filename || 'image'}`);

  let session;
  if (sessionId) session = loadSession(sessionId);
  if (!session) {
    const id = crypto.randomUUID();
    const agent = messageAgent;
    const resolvedCwd = agent === 'claude' ? (process.env.HOME || process.env.USERPROFILE || process.cwd()) : null;
    session = {
      id,
      title: derivedTitle,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      agent,
      claudeSessionId: null,
      codexThreadId: null,
      runtimeContexts: { claude: {}, codex: {} },
      model: null,
      reasoningEffort: agent === 'codex' ? normalizeCodexReasoningEffort(msg.reasoningEffort) : '',
      permissionMode: resolvePermissionModeForAgent(agent, mode).mode,
      totalCost: 0,
      totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      messages: [],
      cwd: resolvedCwd,
    };
  }
  normalizeSession(session);

  if (normalizedText.startsWith('/') && (resolvedAttachments.length > 0 || resolvedFileRefs.length > 0)) {
    return wsSend(ws, { type: 'error', message: '命令消息暂不支持同时附带图片或文件引用。请先发送普通消息，再单独使用命令。' });
  }

  let permissionModeNotice = null;
  if (mode && VALID_PERMISSION_MODES.has(mode)) {
    const resolved = resolvePermissionModeForAgent(getSessionAgent(session), mode);
    session.permissionMode = resolved.mode;
    if (resolved.downgraded) permissionModeNotice = resolved.message;
  } else {
    const resolved = resolvePermissionModeForAgent(getSessionAgent(session), session.permissionMode || 'yolo');
    if (resolved.downgraded) {
      session.permissionMode = resolved.mode;
      permissionModeNotice = resolved.message;
    }
  }
  if (getSessionAgent(session) === 'codex' && Object.prototype.hasOwnProperty.call(msg, 'reasoningEffort')) {
    session.reasoningEffort = normalizeCodexReasoningEffort(msg.reasoningEffort);
  }

  if (!hideInHistory && normalizedText !== '/compact' && getRuntimeSessionId(session)) {
    pendingCompactRetries.set(session.id, { text: normalizedText, mode: session.permissionMode || 'yolo', reason: 'normal', autoRetryCount: 0 });
  }

  if (session.title === 'New Chat' || session.title === 'Untitled') {
    session.title = derivedTitle;
  }

  if (!hideInHistory) {
    session.messages.push({
      role: 'user',
      content: textValue,
      attachments: savedAttachments,
      fileRefs: savedFileRefs,
      timestamp: new Date().toISOString(),
    });
  }
  session.updated = new Date().toISOString();
  saveSession(session);

  const currentSessionId = session.id;

  detachWebSocketFromActiveProcesses(ws, { markDisconnect: true });
  wsSessionMap.set(ws, currentSessionId);

  if (!sessionId || emitSessionInfo) {
    wsSend(ws, {
      type: 'session_info',
      sessionId: currentSessionId,
      messages: session.messages,
      title: session.title,
      mode: session.permissionMode || 'yolo',
      reasoningEffort: session.reasoningEffort || '',
      model: sessionModelLabel(session),
      agent: getSessionAgent(session),
      cwd: session.cwd || null,
      projectId: session.projectId || null,
      totalCost: session.totalCost || 0,
      totalUsage: session.totalUsage || null,
      lastUsage: session.lastUsage || null,
      contextWindowTokens: session.contextWindowTokens || null,
      queuedMessages: buildQueuedMessagesPayload(session),
      updated: session.updated,
      hasUnread: false,
      historyPending: false,
      isRunning: false,
      ...buildSessionRuntimeMeta(session),
    });
  }
  sendSessionList(ws);

  const spawnSpec = isClaudeSession(session)
    ? buildClaudeSpawnSpec(session, { attachments: resolvedAttachments })
    : buildCodexSpawnSpec(session, { attachments: resolvedAttachments });
  if (spawnSpec?.error) {
    return wsSend(ws, { type: 'error', message: spawnSpec.error });
  }
  const shouldInjectCarryover = !!(spawnSpec?.threadReset && !hideInHistory && !normalizedText.startsWith('/'));
  const carryoverHistory = shouldInjectCarryover
    ? (Array.isArray(session.messages) ? session.messages.slice(0, -1) : [])
    : [];
  const threadCarryover = shouldInjectCarryover
    ? buildThreadCarryoverPayload(session, runtimeInputBaseText, resolvedAttachments, carryoverHistory, spawnSpec.threadReset)
    : null;
  if (permissionModeNotice) {
    wsSend(ws, { type: 'system_message', message: permissionModeNotice });
    wsSend(ws, { type: 'mode_changed', mode: session.permissionMode || 'default' });
  }
  if (spawnSpec?.warningMessage) {
    wsSend(ws, { type: 'system_message', message: spawnSpec.warningMessage });
  }
  if (spawnSpec?.threadReset) {
    wsSend(ws, { type: 'system_message', message: buildThreadCarryoverNotice(threadCarryover) });
  }
  const runtimeProcessInputText = threadCarryover?.prompt || runtimeInputBaseText;

  // === Detached process with file-based I/O ===
  const dir = runDir(currentSessionId);
  fs.mkdirSync(dir, { recursive: true });

  const inputPath = path.join(dir, 'input.txt');
  const outputPath = path.join(dir, 'output.jsonl');
  const errorPath = path.join(dir, 'error.log');

  if (isClaudeSession(session) && resolvedAttachments.length > 0) {
    const content = [];
    if (runtimeProcessInputText) content.push({ type: 'text', text: runtimeProcessInputText });
    for (const attachment of resolvedAttachments) {
      const data = fs.readFileSync(attachment.path).toString('base64');
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mime,
          data,
        },
      });
    }
    fs.writeFileSync(inputPath, `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    })}\n`);
  } else {
    fs.writeFileSync(inputPath, runtimeProcessInputText);
  }

  const inputFd = fs.openSync(inputPath, 'r');
  const outputFd = fs.openSync(outputPath, 'w');
  const errorFd = fs.openSync(errorPath, 'w');

  let proc;
  let entry = null;
  try {
    proc = spawn(spawnSpec.command, spawnSpec.args, {
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      stdio: [inputFd, outputFd, errorFd],
      detached: !IS_WIN,
      windowsHide: true,
      shell: !!spawnSpec.useShell,
    });
  } catch (err) {
    fs.closeSync(inputFd);
    fs.closeSync(outputFd);
    fs.closeSync(errorFd);
    cleanRunDir(currentSessionId);
    plog('ERROR', 'process_spawn_fail', { sessionId: currentSessionId.slice(0, 8), error: err.message });
    const agent = getSessionAgent(session);
    return wsSend(ws, { type: 'error', message: formatRuntimeError(agent, err.message, { exitCode: null, signal: null }) });
  }

  fs.closeSync(inputFd);
  fs.closeSync(outputFd);
  fs.closeSync(errorFd);

  // Handle spawn errors (e.g. ENOENT when CLI binary not found) — must be registered
  // immediately after spawn, before any async work, to avoid unhandled 'error' event crash.
  proc.on('error', (err) => {
    plog('ERROR', 'process_spawn_fail', { sessionId: currentSessionId.slice(0, 8), error: err.message });
    cleanRunDir(currentSessionId);
    const agent = getSessionAgent(session);
    wsSend(ws, { type: 'error', message: formatRuntimeError(agent, err.message, { exitCode: null, signal: null }) });
  });

  fs.writeFileSync(path.join(dir, 'pid'), String(proc.pid));
  proc.unref(); // Process survives Node.js exit

  plog('INFO', 'process_spawn', {
    sessionId: currentSessionId.slice(0, 8),
    pid: proc.pid,
    agent: getSessionAgent(session),
    mode: spawnSpec.mode,
    model: session.model || 'default',
    resume: spawnSpec.resume,
    threadResetReason: spawnSpec.threadReset?.reason || null,
    carryover: threadCarryover
      ? {
          summaryDetailed: threadCarryover.summaryDetailed,
          recentCount: threadCarryover.recentCount,
          historyCount: threadCarryover.historyCount,
        }
      : null,
    args: spawnSpec.args.join(' '),
  });

  // Fast exit detection (while Node.js is running)
  proc.on('exit', (code, signal) => {
    if (entry) {
      entry.pendingProcessComplete = true;
      entry.pendingExitCode = code;
      entry.pendingSignal = signal;
    }
    plog('INFO', 'process_exit_event', {
      sessionId: currentSessionId.slice(0, 8),
      pid: proc.pid,
      exitCode: code,
      signal: signal,
    });
    // Small delay to ensure file is fully flushed
    setTimeout(() => handleProcessComplete(currentSessionId, code, signal), 300);
  });

  entry = {
    pid: proc.pid,
    ws,
    clients: new Set([ws]),
    agent: getSessionAgent(session),
    cwd: spawnSpec.cwd,
    startedAtMs: Date.now(),
    bridgeToken: spawnSpec.bridgeToken || null,
    bridgeUsageApplied: false,
    claudeRuntimeFingerprint: isClaudeSession(session) ? (spawnSpec.runtimeFingerprint || null) : null,
    codexRuntimeFingerprint: getSessionAgent(session) === 'codex' ? (spawnSpec.runtimeFingerprint || null) : null,
    runtimeChannelKey: spawnSpec.channelKey || null,
    runtimeChannelDescriptor: spawnSpec.channelDescriptor || null,
    claudeRuntimeSessionId: isClaudeSession(session)
      ? (getRuntimeSessionId(session, {
          agent: 'claude',
          channelKey: spawnSpec.channelKey || null,
          channelDescriptor: spawnSpec.channelDescriptor || null,
        }) || null)
      : null,
    persistedClaudeSessionId: isClaudeSession(session)
      ? (getRuntimeSessionId(session, {
          agent: 'claude',
          channelKey: spawnSpec.channelKey || null,
          channelDescriptor: spawnSpec.channelDescriptor || null,
        }) || null)
      : null,
    claudePendingCostDelta: 0,
    claudeSessionTotalCost: session.totalCost || 0,
    fullText: '',
    attachments: resolvedAttachments,
    toolCalls: [],
    segments: [],
    lastCost: null,
    lastUsage: null,
    lastError: null,
    errorSent: false,
    pendingProcessComplete: false,
    pendingExitCode: null,
    pendingSignal: null,
    tailer: null,
  };
  setActiveProcess(currentSessionId, entry);
  sendSessionList(ws);

  // Tail the output file for real-time streaming
  entry.tailer = new FileTailer(outputPath, (line) => {
    try {
      const event = JSON.parse(line);
      processRuntimeEvent(entry, event, currentSessionId);
    } catch {}
  });
  entry.tailer.start();
}

function truncateObj(obj, maxLen) {
  const s = JSON.stringify(obj);
  if (s.length <= maxLen) return obj;
  return s.slice(0, maxLen) + '...';
}

function safeJsonParse(input) {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return input;
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    return input;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

function sanitizeToolInput(toolName, input) {
  const parsed = safeJsonParse(input);
  if (toolName === 'AskUserQuestion') {
    return parsed;
  }
  return truncateObj(parsed, 500);
}

const {
  buildClaudeSpawnSpec,
  buildCodexSpawnSpec,
  processRuntimeEvent,
} = createAgentRuntime({
  processEnv: process.env,
  CLAUDE_PATH,
  CODEX_PATH,
  MODEL_MAP,
  loadModelConfig,
  applyCustomTemplateToSettings,
  getClaudeRuntimeFingerprint,
  loadCodexConfig,
  prepareCodexCustomRuntime,
  getCodexRuntimeFingerprint,
  wsSend,
  sendRuntimeMessage,
  truncateObj,
  sanitizeToolInput,
  loadSession,
  saveSession,
  getRuntimeSessionState,
  getFallbackRuntimeSessionState,
  setRuntimeSessionState,
  setRuntimeSessionId,
  getRuntimeSessionId,
  clearRuntimeSessionId,
  runtimeFingerprintsCompatible,
  onSlashCommandsDiscovered,
  createGeneratedImageSegmentFromCodexEvent,
});

// === Check Update ===
function handleCheckUpdate(ws) {
  const localVersion = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; } catch {}
    try {
      const cl = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
      const m = cl.match(/##\s*v([\d.]+)/) || cl.match(/\*\*v([\d.]+)\*\*/);
      if (m) return m[1];
    } catch {}
    return 'unknown';
  })();

  const https = require('https');
  const options = {
    hostname: 'raw.githubusercontent.com',
    path: '/HsMirage/webcoding/main/CHANGELOG.md',
    headers: { 'User-Agent': 'webcoding-update-check' },
    timeout: 10000,
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'update_info', localVersion, error: `HTTP ${res.statusCode}` });
      }
      const m = body.match(/##\s*v([\d.]+)/) || body.match(/\*\*v([\d.]+)\*\*/);
      const latest = m ? m[1] : null;
      if (!latest) {
        return wsSend(ws, { type: 'update_info', localVersion, error: '无法解析远端版本号' });
      }
      const hasUpdate = latest !== localVersion;
      wsSend(ws, {
        type: 'update_info',
        localVersion,
        latestVersion: latest,
        hasUpdate,
        releaseUrl: 'https://github.com/HsMirage/webcoding',
      });
    });
  });
  req.on('error', (e) => {
    wsSend(ws, { type: 'update_info', localVersion, error: '网络请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'update_info', localVersion, error: '请求超时' });
  });
  req.end();
}

// === Native Session Import ===

const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'sessions');
const CODEX_RUNTIME_SESSIONS_DIR = path.join(CODEX_RUNTIME_HOME, 'sessions');
const CODEX_STATE_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'state_5.sqlite');
const CODEX_LOG_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'logs_1.sqlite');

function resolveClaudeSessionLocalMeta(claudeSessionId) {
  if (!claudeSessionId) return null;
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter((dir) => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, dir)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const filePath = path.join(CLAUDE_PROJECTS_DIR, dir, `${sanitizeId(claudeSessionId)}.jsonl`);
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        let cwd = null;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed);
            if (entry.type === 'user' && entry.cwd) {
              cwd = entry.cwd;
              break;
            }
          } catch {}
        }
        return { cwd, projectDir: dir, filePath };
      } catch {}
    }
  } catch {}
  return null;
}

function parseJsonlToMessages(lines) {
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.type === 'user') {
      const raw = entry.message?.content;
      let content = '';
      if (typeof raw === 'string') {
        content = raw;
      } else if (Array.isArray(raw)) {
        // skip tool_result blocks, only take text blocks
        content = raw
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('');
      }
      if (content.trim()) {
        messages.push({ role: 'user', content, timestamp: entry.timestamp || null });
      }
    } else if (entry.type === 'assistant') {
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) continue;
      let content = '';
      const toolCalls = [];
      const segments = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          content += b.text;
          const last = segments[segments.length - 1];
          if (last && last.type === 'text') last.text = `${last.text || ''}${b.text}`;
          else segments.push({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          const tc = { name: b.name, id: b.id, input: b.input, done: true };
          toolCalls.push(tc);
          segments.push({ type: 'tool_call', ...tc });
        } else if (b.type === 'tool_result') {
          const resultText = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((item) => item.text || '').join('\n')
              : JSON.stringify(b.content || '');
          const tc = toolCalls.find((item) => item.id === b.tool_use_id);
          if (tc) tc.result = resultText.slice(0, 2000);
          const segment = segments.find((item) => item.type === 'tool_call' && item.id === b.tool_use_id);
          if (segment) segment.result = resultText.slice(0, 2000);
        }
        // skip thinking blocks
      }
      if (content.trim() || toolCalls.length > 0) {
        messages.push({ role: 'assistant', content, toolCalls, segments, timestamp: entry.timestamp || null });
      }
    }
    // skip other types
  }
  return messages;
}

const {
  getCodexRolloutFiles,
  getImportedCodexThreadIds,
  parseCodexRolloutFile,
} = createCodexRolloutStore({
  codexSessionsDir: CODEX_SESSIONS_DIR,
  codexRuntimeSessionsDir: CODEX_RUNTIME_SESSIONS_DIR,
  sessionsDir: SESSIONS_DIR,
  normalizeSession,
  sanitizeToolInput,
  createGeneratedImageSegmentFromCodexEvent,
});

function getImportedSessionIds() {
  const now = Date.now();
  if (importedSessionIdsCache.expiresAt > now) {
    return importedSessionIdsCache.ids;
  }
  const imported = new Set();
  try {
    const files = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
    for (const f of files) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        for (const runtimeId of getAllRuntimeSessionIds(s, 'claude')) {
          imported.add(String(runtimeId));
        }
      } catch {}
    }
  } catch {}
  importedSessionIdsCache.ids = imported;
  importedSessionIdsCache.expiresAt = now + IMPORTED_SESSION_IDS_CACHE_TTL_MS;
  return imported;
}

function readFileSliceUtf8(filePath, start, length) {
  const safeStart = Math.max(0, Number(start) || 0);
  const safeLength = Math.max(0, Number(length) || 0);
  if (safeLength <= 0) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(safeLength);
    const bytesRead = fs.readSync(fd, buffer, 0, safeLength, safeStart);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function extractNativeSessionHeadMeta(filePath, sessionId) {
  const fallbackTitle = sessionId.slice(0, 20);
  const headText = readFileSliceUtf8(filePath, 0, JSONL_HEAD_READ_BYTES);
  const lines = headText.split('\n');
  let title = fallbackTitle;
  let cwd = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.type !== 'user') continue;
      if (!cwd) cwd = e.cwd || null;
      const raw = e.message?.content;
      let text = '';
      if (typeof raw === 'string') text = raw;
      else if (Array.isArray(raw)) text = raw.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (text.trim()) {
        title = text.trim().slice(0, 80).replace(/\n/g, ' ');
        break;
      }
    } catch {}
  }
  return { title, cwd };
}

function extractNativeSessionUpdatedAt(filePath, fileSize, fallbackIso) {
  const size = Number(fileSize) || 0;
  if (size <= 0) return fallbackIso || null;
  const readBytes = Math.min(size, JSONL_TAIL_READ_BYTES);
  const start = size - readBytes;
  const tailText = readFileSliceUtf8(filePath, start, readBytes);
  const lines = tailText.split('\n');
  if (start > 0 && lines.length > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e?.timestamp) return e.timestamp;
    } catch {}
  }
  return fallbackIso || null;
}

function handleListNativeSessions(ws) {
  const groups = [];
  try {
    const imported = getImportedSessionIds();
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    // Decode dir name to real path and merge duplicates
    const mergedMap = new Map(); // decodedKey -> { dir, sessions[] }
    for (const dirEntry of dirs) {
      const dir = dirEntry.name;
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
      // Decode: Claude encodes /a/b/c as -a-b-c
      let decodedKey = dir;
      if (dir.startsWith('-') && !dir.includes('/') && !dir.includes('\\')) {
        decodedKey = '/' + dir.split('-').filter(Boolean).join('/');
      }
      const sessionItems = [];
      try {
        const files = fs.readdirSync(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
        for (const fileEntry of files) {
          const sessionId = fileEntry.name.replace('.jsonl', '');
          const filePath = path.join(dirPath, fileEntry.name);
          try {
            const stat = fs.statSync(filePath);
            const fallbackUpdatedAt = stat.mtime ? stat.mtime.toISOString() : null;
            const meta = extractNativeSessionHeadMeta(filePath, sessionId);
            const updatedAt = extractNativeSessionUpdatedAt(filePath, stat.size, fallbackUpdatedAt);
            sessionItems.push({
              sessionId,
              title: meta.title,
              cwd: meta.cwd,
              updatedAt,
              alreadyImported: imported.has(sessionId),
            });
          } catch {}
        }
      } catch {}
      if (sessionItems.length > 0) {
        if (mergedMap.has(decodedKey)) {
          mergedMap.get(decodedKey).sessions.push(...sessionItems);
        } else {
          mergedMap.set(decodedKey, { dir, sessions: sessionItems });
        }
      }
    }
    for (const { dir, sessions } of mergedMap.values()) {
      sessions.sort((a, b) => {
        if (!a.updatedAt) return 1;
        if (!b.updatedAt) return -1;
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });
      groups.push({ dir, sessions });
    }
  } catch {}
  wsSend(ws, { type: 'native_sessions', groups });
}

function handleImportNativeSession(ws, msg) {
  const { sessionId, projectDir } = msg;
  if (!sessionId || !projectDir) {
    return wsSend(ws, { type: 'error', message: '缺少 sessionId 或 projectDir' });
  }
  const filePath = path.join(CLAUDE_PROJECTS_DIR, String(projectDir), `${sanitizeId(sessionId)}.jsonl`);
  if (!filePath.startsWith(CLAUDE_PROJECTS_DIR)) {
    return wsSend(ws, { type: 'error', message: '非法路径' });
  }
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch {
    return wsSend(ws, { type: 'error', message: '无法读取会话文件' });
  }
  const lines = content.split('\n');
  const messages = parseJsonlToMessages(lines);

  // Find or create webcoding session with this claudeSessionId
  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (sessionHasRuntimeId(s, 'claude', sessionId)) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  // Determine title and cwd from messages/raw
  let title = sessionId.slice(0, 20);
  let cwd = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === 'user') {
        if (!cwd) cwd = e.cwd || null;
        const raw = e.message?.content;
        let text = '';
        if (typeof raw === 'string') text = raw;
        else if (Array.isArray(raw)) text = raw.filter(b => b.type === 'text').map(b => b.text || '').join('');
        if (text.trim()) { title = text.trim().slice(0, 60).replace(/\n/g, ' '); break; }
      }
    } catch {}
  }

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const session = {
    id,
    title,
    created: existingSession?.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    agent: 'claude',
    claudeSessionId: sessionId,
    codexThreadId: null,
    runtimeContexts: existingSession?.runtimeContexts || { claude: {}, codex: {} },
    importedFrom: projectDir,
    model: existingSession?.model || null,
    reasoningEffort: existingSession?.reasoningEffort || '',
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages,
    cwd: cwd || existingSession?.cwd || null,
  };
  if (session.cwd && !session.projectId) {
    const ensured = ensureProjectForPath(session.cwd);
    if (ensured.project?.id) session.projectId = ensured.project.id;
  }
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    reasoningEffort: session.reasoningEffort || '',
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    lastUsage: session.lastUsage || null,
    contextWindowTokens: session.contextWindowTokens || null,
    queuedMessages: buildQueuedMessagesPayload(session),
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    imported: true,
    ...buildSessionRuntimeMeta(session),
  });
  sendSessionList(ws);
}

function handleListCodexSessions(ws) {
  const imported = getImportedCodexThreadIds();
  const cwdMap = new Map(); // cwd -> items[]
  const seen = new Set();
  for (const filePath of getCodexRolloutFiles()) {
    const parsed = parseCodexRolloutFile(filePath);
    if (!parsed?.meta?.threadId) continue;
    if (seen.has(parsed.meta.threadId)) continue;
    seen.add(parsed.meta.threadId);
    const title = parsed.meta.title || parsed.meta.threadId.slice(0, 20);
    const cwd = parsed.meta.cwd || '/unknown';
    if (!cwdMap.has(cwd)) cwdMap.set(cwd, []);
    cwdMap.get(cwd).push({
      threadId: parsed.meta.threadId,
      title,
      cwd: parsed.meta.cwd || null,
      updatedAt: parsed.meta.updatedAt || null,
      cliVersion: parsed.meta.cliVersion || '',
      source: (() => {
        const s = parsed.meta.source;
        if (typeof s === 'string') return s;
        if (s && typeof s === 'object') return s.name || s.type || JSON.stringify(s);
        return '';
      })(),
      rolloutPath: filePath,
      alreadyImported: imported.has(parsed.meta.threadId),
    });
  }
  const groups = [];
  for (const [cwd, sessions] of cwdMap.entries()) {
    sessions.sort((a, b) => {
      if (!a.updatedAt) return 1;
      if (!b.updatedAt) return -1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    groups.push({ cwd, sessions });
  }
  wsSend(ws, { type: 'codex_sessions', groups });
}

function handleImportCodexSession(ws, msg) {
  const threadId = String(msg?.threadId || '').trim();
  if (!threadId) {
    return wsSend(ws, { type: 'error', message: '缺少 threadId' });
  }

  let parsed = null;
  const requestedPath = msg?.rolloutPath ? path.resolve(String(msg.rolloutPath)) : '';
  if (requestedPath && (requestedPath.startsWith(CODEX_SESSIONS_DIR) || requestedPath.startsWith(CODEX_RUNTIME_SESSIONS_DIR)) && fs.existsSync(requestedPath)) {
    parsed = parseCodexRolloutFile(requestedPath);
  }
  if (!parsed) {
    for (const filePath of getCodexRolloutFiles()) {
      const candidate = parseCodexRolloutFile(filePath);
      if (candidate?.meta?.threadId === threadId) {
        parsed = candidate;
        break;
      }
    }
  }

  if (!parsed || parsed.meta.threadId !== threadId) {
    return wsSend(ws, { type: 'error', message: '未找到对应的 Codex 会话文件' });
  }

  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (sessionHasRuntimeId(s, 'codex', threadId)) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const session = {
    id,
    title: parsed.meta.title || existingSession?.title || threadId.slice(0, 20),
    created: existingSession?.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    agent: 'codex',
    claudeSessionId: null,
    codexThreadId: threadId,
    runtimeContexts: existingSession?.runtimeContexts || { claude: {}, codex: {} },
    importedFrom: 'codex',
    importedRolloutPath: parsed.filePath,
    model: existingSession?.model || null,
    reasoningEffort: existingSession?.reasoningEffort || '',
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: parsed.totalUsage || existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    lastUsage: parsed.lastUsage || existingSession?.lastUsage || null,
    contextWindowTokens: parsed.contextWindowTokens || existingSession?.contextWindowTokens || null,
    messages: parsed.messages,
    cwd: parsed.meta.cwd || existingSession?.cwd || null,
  };
  if (session.cwd && !session.projectId) {
    const ensured = ensureProjectForPath(session.cwd);
    if (ensured.project?.id) session.projectId = ensured.project.id;
  }
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    reasoningEffort: session.reasoningEffort || '',
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    lastUsage: session.lastUsage || null,
    contextWindowTokens: session.contextWindowTokens || null,
    queuedMessages: buildQueuedMessagesPayload(session),
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    imported: true,
    ...buildSessionRuntimeMeta(session),
  });
  sendSessionList(ws);
}

function handleListCwdSuggestions(ws) {
  const paths = new Set();
  // Always include HOME
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) paths.add(home);
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const session = loadSession(file.replace(/\.json$/, ''));
      if (!session) continue;
      const preferredClaudeRuntimeId = getSessionAgent(session) === 'claude'
        ? getPreferredRuntimeSessionId(session, 'claude')
        : null;
      const localMeta = getSessionAgent(session) === 'claude' && preferredClaudeRuntimeId && !session.cwd
        ? resolveClaudeSessionLocalMeta(preferredClaudeRuntimeId)
        : null;
      const cwd = session.cwd || localMeta?.cwd || activeProcesses.get(session.id)?.cwd || null;
      if (cwd) paths.add(cwd);
    }
  } catch {}
  for (const entry of activeProcesses.values()) {
    if (entry.cwd) paths.add(entry.cwd);
  }
  wsSend(ws, { type: 'cwd_suggestions', paths: Array.from(paths).sort() });
}

// === Project Handlers ===
function handleSaveProject(ws, msg) {
  const config = loadProjectsConfig();
  const projectPath = msg.path ? normalizeProjectPathKey(msg.path) : null;
  const projectName = msg.name ? String(msg.name).trim() : null;
  if (!projectPath) {
    return wsSend(ws, { type: 'error', message: '项目路径不能为空' });
  }
  try {
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) {
      return wsSend(ws, { type: 'error', message: '指定路径不是目录' });
    }
  } catch {
    return wsSend(ws, { type: 'error', message: '路径不存在或无法访问' });
  }
  const id = msg.id || crypto.randomUUID();
  const existing = config.projects.find(p => p.id === id)
    || config.projects.find(p => normalizeProjectPathKey(p.path) === projectPath);
  if (existing) {
    if (projectName) existing.name = projectName;
    existing.path = projectPath;
  } else {
    const name = projectName || path.basename(projectPath) || projectPath;
    config.projects.push({ id, name, path: projectPath });
  }
  saveProjectsConfig(config);
  wsSend(ws, { type: 'projects_config', projects: config.projects });
}

function decodeClaudeProjectDirName(projectDir) {
  const raw = String(projectDir || '').trim();
  if (!raw) return null;
  if (raw.startsWith('-') && !raw.includes('/') && !raw.includes('\\')) {
    const parts = raw.split('-').filter(Boolean);
    if (parts.length > 0) return `/${parts.join('/')}`;
  }
  return raw;
}

function getSessionProjectPath(session) {
  if (!session) return null;
  if (session.cwd) return session.cwd;
  const preferredClaudeRuntimeId = getSessionAgent(session) === 'claude'
    ? getPreferredRuntimeSessionId(session, 'claude')
    : null;
  if (preferredClaudeRuntimeId) {
    const localMeta = resolveClaudeSessionLocalMeta(preferredClaudeRuntimeId);
    if (localMeta?.cwd) return localMeta.cwd;
  }
  return decodeClaudeProjectDirName(session.importedFrom);
}

function sessionBelongsToConfiguredProject(session, targetProject, projects) {
  if (!session || !targetProject?.id) return false;
  const projectsById = new Map((Array.isArray(projects) ? projects : []).map((project) => [project.id, project]));
  if (session.projectId && projectsById.has(session.projectId)) {
    return session.projectId === targetProject.id;
  }
  const sessionProjectPath = getSessionProjectPath(session);
  if (!sessionProjectPath) return false;
  const matchedProject = findBestProjectForPath(projects, sessionProjectPath);
  return matchedProject?.id === targetProject.id;
}

function collectProjectSessionIds(targetProject, projects) {
  const ids = [];
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const sessionId = file.replace(/\.json$/, '');
      const session = loadSession(sessionId);
      if (sessionBelongsToConfiguredProject(session, targetProject, projects)) ids.push(session.id || sessionId);
    }
  } catch {}
  return ids;
}

function handleDeleteProject(ws, msg) {
  const config = loadProjectsConfig();
  const project = config.projects.find(p => p.id === msg.projectId);
  if (project) {
    const sessionIds = collectProjectSessionIds(project, config.projects);
    let deletedSessions = 0;
    for (const sessionId of sessionIds) {
      try {
        const result = deleteSessionById(sessionId);
        if (result.deleted) deletedSessions++;
      } catch (err) {
        plog('WARN', 'project_session_delete_failed', {
          projectId: project.id,
          sessionId: String(sessionId || '').slice(0, 8),
          error: err?.message || String(err),
        });
      }
    }
    plog('INFO', 'project_deleted', {
      projectId: project.id,
      projectPath: project.path,
      sessions: deletedSessions,
    });
  }
  config.projects = config.projects.filter(p => p.id !== msg.projectId);
  saveProjectsConfig(config);
  sendSessionList(ws, { forceRefresh: true });
  wsSend(ws, { type: 'projects_config', projects: config.projects });
}

function handleRenameProject(ws, msg) {
  const config = loadProjectsConfig();
  const project = config.projects.find(p => p.id === msg.projectId);
  if (project && msg.name) {
    project.name = String(msg.name).trim();
    saveProjectsConfig(config);
  }
  wsSend(ws, { type: 'projects_config', projects: config.projects });
}

function handleReorderProjects(ws, msg) {
  const config = loadProjectsConfig();
  const projectIds = Array.isArray(msg.projectIds) ? msg.projectIds.map((id) => String(id || '')).filter(Boolean) : [];
  if (projectIds.length === 0) {
    return wsSend(ws, { type: 'projects_config', projects: config.projects });
  }
  const byId = new Map(config.projects.map((project) => [project.id, project]));
  const seen = new Set();
  const reordered = [];
  for (const id of projectIds) {
    const project = byId.get(id);
    if (!project || seen.has(id)) continue;
    seen.add(id);
    reordered.push(project);
  }
  for (const project of config.projects) {
    if (!seen.has(project.id)) reordered.push(project);
  }
  config.projects = reordered;
  saveProjectsConfig(config);
  wsSend(ws, { type: 'projects_config', projects: config.projects });
}

async function handleGitCommand(ws, msg) {
  const action = String(msg?.action || '').trim();
  const requestId = msg?.requestId || null;
  let responseCwd = typeof msg?.cwd === 'string' ? String(msg.cwd).trim() : '';

  function sendGitResult(success, data = null, error = '') {
    wsSend(ws, {
      type: 'git_result',
      requestId,
      action,
      success: !!success,
      data: success ? data : null,
      error: success ? null : (error || 'Git 操作失败'),
      cwd: responseCwd || null,
    });
  }

  function execGit(args, cwd) {
    return new Promise((resolve) => {
      execFile('git', args, {
        cwd,
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout = '', stderr = '') => {
        resolve({
          ok: !error,
          error,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      });
    });
  }

  function formatGitError(result, fallback = 'Git 操作失败') {
    if (result?.error?.code === 'ENOENT') {
      return '找不到 git 命令，请先确认本机已经安装 Git。';
    }
    const merged = [result?.stderr, result?.stdout, result?.error?.message]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!merged) return fallback;
    return merged
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');
  }

  function sanitizeGitRelativePath(rawValue, repoRoot) {
    const raw = String(rawValue || '.').trim();
    if (!raw || raw === '.') return '.';
    if (raw.includes('\u0000')) throw new Error('文件路径不合法。');
    if (path.isAbsolute(raw)) throw new Error('文件路径必须是仓库内相对路径。');
    const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
    if (normalized === '.' || normalized === '') return '.';
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new Error('不允许访问仓库外部路径。');
    }
    if (normalized.startsWith('-')) throw new Error('文件路径不能以 - 开头。');
    const resolved = path.resolve(repoRoot, normalized.split('/').join(path.sep));
    if (!isPathInside(resolved, repoRoot)) throw new Error('文件路径超出仓库范围。');
    return normalized;
  }

  function sanitizeGitBranchName(rawValue) {
    const name = String(rawValue || '').trim();
    if (!name) throw new Error('分支名不能为空。');
    if (name.includes('\u0000') || name.startsWith('-') || /\s/.test(name)) {
      throw new Error('分支名不合法。');
    }
    if (
      name.startsWith('/') ||
      name.endsWith('/') ||
      name.includes('//') ||
      name.includes('..') ||
      name.endsWith('.lock') ||
      name.includes('@{') ||
      name === '@'
    ) {
      throw new Error('分支名不合法。');
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
      throw new Error('分支名只允许字母、数字、点、下划线、中划线和斜杠。');
    }
    return name;
  }

  function ensureGitCwdAllowed(targetPath) {
    return BROWSE_ROOTS.some((root) => isPathInside(targetPath, root));
  }

  async function hasActiveProcessInRepo(targetRepoRoot) {
    for (const [, entry] of activeProcesses) {
      const entryCwd = String(entry?.cwd || '').trim();
      if (!entryCwd) continue;
      let resolvedEntryCwd;
      try {
        resolvedEntryCwd = fs.realpathSync(path.resolve(entryCwd));
      } catch {
        continue;
      }
      const repoProbe = await execGit(['rev-parse', '--show-toplevel'], resolvedEntryCwd);
      const activeRepoRoot = repoProbe.ok ? (String(repoProbe.stdout || '').trim() || resolvedEntryCwd) : null;
      if (activeRepoRoot && activeRepoRoot === targetRepoRoot) return true;
    }
    return false;
  }

  const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

  function parseGitStatusPorcelain(rawText) {
    const lines = String(rawText || '').split(/\r?\n/).filter(Boolean);
    const files = [];
    let branch = '';
    let upstream = '';
    let ahead = 0;
    let behind = 0;
    let detached = false;

    for (const line of lines) {
      if (line.startsWith('## ')) {
        const head = line.slice(3).trim();
        if (/^No commits yet on /i.test(head)) {
          branch = head.replace(/^No commits yet on /i, '').trim();
          continue;
        }
        const bracketMatch = head.match(/\[(.+)\]$/);
        const trackingPart = bracketMatch ? bracketMatch[1] : '';
        const refPart = bracketMatch ? head.slice(0, head.lastIndexOf(' [')).trim() : head;
        const refPieces = refPart.split('...');
        branch = refPieces[0] || '';
        upstream = refPieces[1] || '';
        detached = branch.startsWith('HEAD');
        const aheadMatch = trackingPart.match(/ahead (\d+)/);
        const behindMatch = trackingPart.match(/behind (\d+)/);
        ahead = aheadMatch ? parseInt(aheadMatch[1], 10) || 0 : 0;
        behind = behindMatch ? parseInt(behindMatch[1], 10) || 0 : 0;
        continue;
      }

      const x = line[0] || ' ';
      const y = line[1] || ' ';
      const code = `${x}${y}`;
      let filePath = line.slice(3).trim();
      if (filePath.includes(' -> ')) filePath = filePath.split(' -> ').pop().trim();
      const conflicted = conflictCodes.has(code);
      const untracked = code === '??';
      const staged = !conflicted && x !== ' ' && x !== '?';
      const modified = !conflicted && y !== ' ' && y !== '?';

      files.push({
        path: filePath,
        code,
        indexStatus: x,
        worktreeStatus: y,
        staged,
        modified,
        untracked,
        conflicted,
        renamed: x === 'R' || y === 'R',
        added: x === 'A' || y === 'A',
        deleted: x === 'D' || y === 'D',
      });
    }

    return {
      branch: branch || 'HEAD',
      upstream: upstream || '',
      ahead,
      behind,
      detached,
      clean: files.length === 0,
      summary: {
        staged: files.filter((file) => file.staged).length,
        modified: files.filter((file) => file.modified).length,
        untracked: files.filter((file) => file.untracked).length,
        conflicted: files.filter((file) => file.conflicted).length,
      },
      files,
    };
  }

  function parseGitLog(rawText) {
    return String(rawText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(' ');
        if (firstSpace < 0) return { hash: line, subject: '' };
        return {
          hash: line.slice(0, firstSpace),
          subject: line.slice(firstSpace + 1),
        };
      });
  }

  function parseGitBranchList(rawText) {
    const branches = [];
    let current = '';
    for (const rawLine of String(rawText || '').split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const isCurrent = rawLine.startsWith('*');
      const name = rawLine.slice(2).trim();
      if (!name) continue;
      branches.push({ name, current: isCurrent });
      if (isCurrent) current = name;
    }
    return { current, branches };
  }

  try {
    let requestedCwd = typeof msg?.cwd === 'string' ? String(msg.cwd).trim() : '';
    if (!requestedCwd && msg?.sessionId) {
      requestedCwd = String(loadSession(msg.sessionId)?.cwd || '').trim();
    }
    if (!requestedCwd) {
      return sendGitResult(false, null, '缺少工作目录，无法执行 Git 操作。');
    }

    let targetCwd;
    try {
      targetCwd = fs.realpathSync(path.resolve(requestedCwd));
      responseCwd = targetCwd;
    } catch {
      return sendGitResult(false, null, '工作目录不存在或无法访问。');
    }

    if (!ensureGitCwdAllowed(targetCwd)) {
      return sendGitResult(false, null, '工作目录不在允许范围内。');
    }

    const repoProbe = await execGit(['rev-parse', '--show-toplevel'], targetCwd);
    if (!repoProbe.ok) {
      return sendGitResult(false, null, '当前目录不是 Git 仓库。');
    }
    const repoRoot = String(repoProbe.stdout || '').trim() || targetCwd;
    if (!ensureGitCwdAllowed(repoRoot)) {
      return sendGitResult(false, null, 'Git 仓库根目录不在允许范围内。');
    }

    const isWriteAction = action === 'add'
      || action === 'commit'
      || action === 'checkout'
      || (action === 'branch' && String(msg?.name || '').trim());
    if (isWriteAction && await hasActiveProcessInRepo(repoRoot)) {
      return sendGitResult(false, null, '当前仓库有正在运行的会话，暂时禁止 Git 写操作。');
    }

    switch (action) {
      case 'status': {
        const result = await execGit(['status', '--porcelain=1', '--branch'], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '读取 Git 状态失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          ...parseGitStatusPorcelain(result.stdout),
        });
      }
      case 'log': {
        const headCheck = await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot);
        if (!headCheck.ok) {
          return sendGitResult(true, {
            cwd: responseCwd,
            repoRoot,
            entries: [],
          });
        }
        const result = await execGit(['log', '--no-color', '--oneline', '-20'], repoRoot);
        if (!result.ok) {
          return sendGitResult(false, null, formatGitError(result, '读取 Git 历史失败。'));
        }
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          entries: parseGitLog(result.stdout),
        });
      }
      case 'diff': {
        const staged = msg?.staged === true || msg?.staged === '1' || msg?.staged === 1;
        const file = msg?.file ? sanitizeGitRelativePath(msg.file, repoRoot) : '';
        const args = ['diff', '--no-color'];
        if (staged) args.push('--staged');
        if (file) args.push('--', file);
        const result = await execGit(args, repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '读取 Git diff 失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          staged,
          file: file || '',
          diff: result.stdout || '',
        });
      }
      case 'add': {
        const file = sanitizeGitRelativePath(msg?.file || '.', repoRoot);
        const result = await execGit(['add', '--', file], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '暂存文件失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          file,
          output: (result.stdout || result.stderr || '').trim(),
        });
      }
      case 'commit': {
        const message = String(msg?.message || '').trim();
        if (!message) return sendGitResult(false, null, '提交说明不能为空。');
        const result = await execGit(['commit', '-m', message], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, 'Git 提交失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          message,
          output: (result.stdout || result.stderr || '').trim(),
        });
      }
      case 'branch': {
        const name = String(msg?.name || '').trim();
        if (name) {
          const safeName = sanitizeGitBranchName(name);
          const result = await execGit(['branch', safeName], repoRoot);
          if (!result.ok) return sendGitResult(false, null, formatGitError(result, '创建分支失败。'));
          return sendGitResult(true, {
            cwd: responseCwd,
            repoRoot,
            created: true,
            branch: safeName,
            output: (result.stdout || result.stderr || '').trim(),
          });
        }
        const result = await execGit(['branch', '--list', '--no-color'], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '读取分支列表失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          ...parseGitBranchList(result.stdout),
        });
      }
      case 'checkout': {
        const branch = sanitizeGitBranchName(msg?.branch || '');
        const result = await execGit(['checkout', branch], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '切换分支失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          branch,
          output: (result.stdout || result.stderr || '').trim(),
        });
      }
      default:
        return sendGitResult(false, null, `不支持的 Git 操作：${action || 'unknown'}`);
    }
  } catch (error) {
    return sendGitResult(false, null, error?.message || 'Git 操作失败。');
  }
}

function handleBrowseDirectory(ws, msg) {
  const home = USER_HOME || '/';
  const requestedPath = msg && typeof msg.path === 'string' ? msg.path : '';
  let targetPath;
  try {
    targetPath = requestedPath ? path.resolve(String(requestedPath)) : home;
    targetPath = fs.realpathSync(targetPath);
  } catch (e) {
    return wsSend(ws, {
      type: 'directory_listing',
      path: requestedPath || home,
      parent: requestedPath ? path.dirname(path.resolve(String(requestedPath))) : null,
      dirs: [],
      error: '路径不存在或无法访问',
    });
  }

  if (!BROWSE_ROOTS.some((root) => isPathInside(targetPath, root))) {
    return wsSend(ws, {
      type: 'directory_listing',
      path: targetPath,
      parent: null,
      dirs: [],
      error: '路径不在允许浏览范围内',
    });
  }

  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return wsSend(ws, {
        type: 'directory_listing',
        path: targetPath,
        parent: path.dirname(targetPath),
        dirs: [],
        error: '指定路径不是目录',
      });
    }
  } catch (e) {
    return wsSend(ws, {
      type: 'directory_listing',
      path: targetPath,
      parent: null,
      dirs: [],
      error: '无法读取路径信息',
    });
  }

  const showHidden = !!(msg && msg.showHidden);
  let entries;
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch (e) {
    const parentPath = path.dirname(targetPath);
    return wsSend(ws, {
      type: 'directory_listing',
      path: targetPath,
      parent: parentPath !== targetPath ? parentPath : null,
      dirs: [],
      error: e.code === 'EACCES' ? '权限不足，无法读取此目录' : '读取目录失败',
    });
  }

  const dirs = entries
    .filter(e => {
      if (!e.isDirectory()) return false;
      if (!showHidden && e.name.startsWith('.')) return false;
      return true;
    })
    .map(e => e.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const parentPath = path.dirname(targetPath);
  wsSend(ws, {
    type: 'directory_listing',
    path: targetPath,
    parent: parentPath !== targetPath ? parentPath : null,
    dirs,
    error: null,
  });
}

// === Startup ===
recoverProcesses();

// Periodic heartbeat: log active processes status every 60s
setInterval(() => {
  if (activeProcesses.size === 0) return;
  const procs = [];
  for (const [sid, entry] of activeProcesses) {
    const alive = isProcessRunning(entry.pid);
    procs.push({
      sessionId: sid.slice(0, 8),
      pid: entry.pid,
      alive,
      wsConnected: isProcessRealtimeConnected(entry),
      wsDisconnectTime: entry.wsDisconnectTime || null,
      responseLen: (entry.fullText || '').length,
    });
  }
  plog('INFO', 'heartbeat', { activeCount: procs.length, wsClients: wss.clients.size, processes: procs });
}, 60000);

// Backfill projectId for existing sessions that have cwd but no projectId
try {
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8')));
      if (session && session.cwd && !session.projectId) {
        const ensured = ensureProjectForPath(session.cwd);
        if (ensured.project?.id) {
          session.projectId = ensured.project.id;
          saveSession(session);
        }
      }
    } catch {}
  }
} catch {}

plog('INFO', 'server_start', { port: PORT });

server.listen(PORT, HOST, () => {
  console.log(`webcoding server listening on ${HOST}:${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`  Network: http://${addr.address}:${PORT}`);
      }
    }
  }
});
