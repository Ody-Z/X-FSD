import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { CLAUDE_CODE_HAIKU_MODEL, buildUserMessage } from '../lib/api.js';
import {
  createEstimatedTokenUsage,
  extractGenericTokenUsage,
  summarizeTokenUsage
} from '../lib/token-usage.js';
import {
  DEFAULT_TOKEN_USAGE_CSV_PATH,
  createTokenUsageCsvLogger
} from './token-usage-csv.js';

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = Number(process.env.XGA_CLAUDE_BRIDGE_PORT || '43118');
const DEFAULT_TIMEOUT_MS = Number(process.env.XGA_CLAUDE_CLI_TIMEOUT_MS || '25000');
const DEFAULT_MODEL = process.env.XGA_CLAUDE_CODE_MODEL || CLAUDE_CODE_HAIKU_MODEL;
const DEFAULT_CLAUDE_BIN = process.env.XGA_CLAUDE_BIN || 'claude';
const TRACE_LOG_PATH = process.env.XGA_CLAUDE_TRACE_LOG || '/tmp/xga-claude-code-bridge.log';
const TOKEN_USAGE_CSV_PATH = process.env.XGA_CLAUDE_TOKEN_USAGE_CSV ||
  process.env.XGA_TOKEN_USAGE_CSV ||
  DEFAULT_TOKEN_USAGE_CSV_PATH;
const PROMPT_DUMP_PATH = process.env.XGA_CLAUDE_PROMPT_DUMP || '';
const CLAUDE_STATUS_TTL_MS = 10000;
const BRIDGE_WORKDIR = path.join(os.tmpdir(), 'xga-claude-code-bridge', 'workdir');
const CLAUDE_BRIDGE_SETTINGS = JSON.stringify({ disableAllHooks: true });

let claudeStatusCache = {
  value: null,
  expiresAt: 0
};
const tokenUsageCsv = createTokenUsageCsvLogger(TOKEN_USAGE_CSV_PATH);

function nowNs() {
  return process.hrtime.bigint();
}

function formatDurationNs(startedAtNs) {
  const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
  return `${Math.round(elapsedMs)}ms`;
}

function appendTraceLog(entry) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry
  });
  return appendFile(TRACE_LOG_PATH, `${line}\n`, 'utf8').catch(() => {});
}

function logRequest(requestId, message, extra, source = 'bridge') {
  void appendTraceLog({ source, requestId, message, extra });
  if (typeof extra === 'undefined') {
    console.log(`[XGA][${source}][${requestId}] ${message}`);
    return;
  }
  console.log(`[XGA][${source}][${requestId}] ${message}`, extra);
}

class BridgeError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}

function withCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(res, statusCode, payload) {
  withCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function buildCliPrompt(systemPrompt, userPrompt) {
  return `${systemPrompt}\n\nUser request:\n${userPrompt}`;
}

async function dumpPromptIfConfigured(prompt, requestId) {
  if (!PROMPT_DUMP_PATH) return;

  const payload = [
    `requestId: ${requestId}`,
    `timestamp: ${new Date().toISOString()}`,
    '',
    prompt
  ].join('\n');

  await writeFile(PROMPT_DUMP_PATH, payload, 'utf8');
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function parseJsonObject(stdout, errorMessage) {
  const jsonText = extractFirstJsonObject(stdout);
  if (!jsonText) {
    throw new BridgeError('cli_invalid_json', errorMessage, 502);
  }

  try {
    return JSON.parse(jsonText);
  } catch {
    throw new BridgeError('cli_invalid_json', errorMessage, 502);
  }
}

function parseClaudeJsonOutputResult(stdout) {
  const payload = parseJsonObject(stdout, 'Claude Code returned invalid JSON output');

  if (payload?.is_error === true) {
    throw new BridgeError('cli_failure', payload.result?.trim() || 'Claude Code failed to generate a reply.', 502);
  }

  if (typeof payload?.result !== 'string') {
    throw new BridgeError('cli_invalid_json', 'Claude Code returned invalid JSON output', 502);
  }

  const text = payload.result.trim();
  if (!text) {
    throw new BridgeError('cli_empty_response', 'Claude Code returned no text response', 502);
  }

  return {
    text,
    tokenUsage: summarizeTokenUsage(extractGenericTokenUsage(payload, 'claude-code'))
  };
}

function parseClaudeJsonOutput(stdout) {
  return parseClaudeJsonOutputResult(stdout).text;
}

function parseClaudeAuthStatus(stdout) {
  const payload = parseJsonObject(stdout, 'Claude Code returned invalid auth status output');
  return {
    loggedIn: payload.loggedIn === true,
    authMethod: payload.authMethod || null,
    email: payload.email || null,
    subscriptionType: payload.subscriptionType || null,
    apiProvider: payload.apiProvider || null
  };
}

function mapCliExecutionError(error, stdout = '', stderr = '') {
  if (error?.code === 'ENOENT') {
    return new BridgeError('claude_not_found', 'Claude Code CLI is not installed or not on PATH.', 503);
  }

  if (error?.code === 'ETIMEDOUT' || error?.killed) {
    return new BridgeError('claude_timeout', 'Claude Code timed out while generating a reply.', 504);
  }

  try {
    parseClaudeJsonOutput(stdout);
  } catch (parsedError) {
    if (parsedError instanceof BridgeError && parsedError.code === 'cli_failure') return parsedError;
  }

  const combined = `${stderr}\n${stdout}`.trim();

  if (/auth login|not logged in|not authenticated|login required|subscription/i.test(combined)) {
    return new BridgeError('claude_auth_required', 'Claude Code is not authenticated. Run `claude auth login` locally and try again.', 503);
  }

  if (/model/i.test(combined) && /unknown|unsupported|invalid|not found/i.test(combined)) {
    return new BridgeError('claude_model_unavailable', 'Claude Code rejected the configured model.', 502);
  }

  return new BridgeError('cli_failure', combined || 'Claude Code failed to generate a reply.', 502);
}

async function ensureBridgeWorkdir(dir = BRIDGE_WORKDIR) {
  await mkdir(dir, { recursive: true });
  return dir;
}

function buildClaudeExecInvocation({
  claudeBin = DEFAULT_CLAUDE_BIN,
  model = DEFAULT_MODEL,
  userPrompt,
  systemPrompt,
  workdir = BRIDGE_WORKDIR,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  includeSystemPrompt = true
}) {
  const args = [
    '-p',
    userPrompt,
    '--model',
    model,
    '--output-format',
    'json',
    '--max-turns',
    '1',
    '--no-session-persistence',
    '--setting-sources',
    'local',
    '--settings',
    CLAUDE_BRIDGE_SETTINGS,
    '--effort',
    'low',
    '--disable-slash-commands',
    '--tools',
    ''
  ];

  if (includeSystemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return {
    file: claudeBin,
    args,
    options: {
      cwd: workdir,
      env,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024
    }
  };
}

async function getClaudeStatus({ claudeBin = DEFAULT_CLAUDE_BIN } = {}) {
  if (claudeStatusCache.value && claudeStatusCache.expiresAt > Date.now()) {
    return claudeStatusCache.value;
  }

  let status;
  try {
    const [versionResult, authResult] = await Promise.all([
      execFileAsync(claudeBin, ['--version'], {
        cwd: os.homedir(),
        timeout: 5000,
        maxBuffer: 64 * 1024
      }),
      execFileAsync(claudeBin, ['auth', 'status'], {
        cwd: os.homedir(),
        timeout: 5000,
        maxBuffer: 64 * 1024
      })
    ]);

    status = {
      installed: true,
      binary: claudeBin,
      version: versionResult.stdout.trim(),
      ...parseClaudeAuthStatus(authResult.stdout)
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      status = {
        installed: false,
        binary: claudeBin
      };
    } else if (error?.stdout) {
      try {
        status = {
          installed: true,
          binary: claudeBin,
          ...parseClaudeAuthStatus(error.stdout)
        };
      } catch {
        status = {
          installed: false,
          binary: claudeBin,
          error: error.message
        };
      }
    } else {
      status = {
        installed: false,
        binary: claudeBin,
        error: error.message
      };
    }
  }

  claudeStatusCache = {
    value: status,
    expiresAt: Date.now() + CLAUDE_STATUS_TTL_MS
  };
  return status;
}

async function invokeClaudeCode({
  systemPrompt,
  userPrompt,
  tweetText,
  context,
  requestId = `bridge-${Date.now().toString(36)}`,
  model = DEFAULT_MODEL,
  claudeBin = DEFAULT_CLAUDE_BIN,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const startedAt = nowNs();
  const workdir = await ensureBridgeWorkdir();
  const resolvedUserPrompt = typeof userPrompt === 'string' && userPrompt.trim()
    ? userPrompt
    : buildUserMessage(tweetText, context);
  const combinedPrompt = buildCliPrompt(systemPrompt, resolvedUserPrompt);
  logRequest(requestId, 'Prepared Claude prompt', {
    model,
    promptLength: combinedPrompt.length,
    timeoutMs
  });
  await dumpPromptIfConfigured(combinedPrompt, requestId);

  try {
    const execStartedAt = nowNs();
    const invocation = buildClaudeExecInvocation({
      claudeBin,
      model,
      userPrompt: resolvedUserPrompt,
      systemPrompt,
      workdir,
      timeoutMs,
      includeSystemPrompt: true
    });
    const { stdout } = await execFileAsync(invocation.file, invocation.args, invocation.options);
    logRequest(requestId, `Claude Code process finished in ${formatDurationNs(execStartedAt)}`);

    const parseStartedAt = nowNs();
    const result = parseClaudeJsonOutputResult(stdout);
    const tokenUsage = result.tokenUsage || createEstimatedTokenUsage({
      systemPrompt,
      userPrompt: resolvedUserPrompt,
      outputText: result.text
    });
    logRequest(requestId, `Parsed CLI output in ${formatDurationNs(parseStartedAt)}`, {
      responseLength: result.text.length,
      tokenUsage
    });
    logRequest(requestId, `Total bridge time ${formatDurationNs(startedAt)}`, {
      tokenUsage
    });
    return {
      text: result.text,
      tokenUsage
    };
  } catch (error) {
    logRequest(requestId, `Claude Code failed after ${formatDurationNs(startedAt)}`, {
      code: error?.code,
      message: error?.message
    });
    throw mapCliExecutionError(error, error.stdout || '', error.stderr || '');
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new BridgeError('payload_too_large', 'Request body too large', 413));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new BridgeError('invalid_json', 'Invalid JSON request body', 400));
      }
    });
    req.on('error', reject);
  });
}

function createBridgeServer({
  invokeReply = invokeClaudeCode,
  getStatus = getClaudeStatus,
  tokenUsageCsvLogger = tokenUsageCsv
} = {}) {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      withCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && req.url === '/health') {
        const claude = await getStatus();
        sendJson(res, 200, {
          ok: true,
          model: DEFAULT_MODEL,
          claude
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/trace') {
        const body = await readJsonBody(req);
        const requestId = typeof body.requestId === 'string' && body.requestId.trim()
          ? body.requestId
          : `trace-${Date.now().toString(36)}`;
        const message = typeof body.message === 'string' && body.message.trim()
          ? body.message
          : 'trace';
        const source = typeof body.source === 'string' && body.source.trim()
          ? body.source
          : 'client';

        logRequest(requestId, message, body.extra, source);
        sendJson(res, 202, { ok: true });
        return;
      }

      if (req.method === 'POST' && req.url === '/generate-reply') {
        const requestStartedAt = nowNs();
        const body = await readJsonBody(req);
        const requestId = typeof body.requestId === 'string' && body.requestId.trim()
          ? body.requestId
          : `bridge-${Date.now().toString(36)}`;
        const resolvedUserPrompt = typeof body.userPrompt === 'string' && body.userPrompt.trim()
          ? body.userPrompt
          : null;
        logRequest(requestId, 'HTTP request received', {
          tweetLength: body.tweetText?.length || 0,
          userPromptLength: resolvedUserPrompt?.length || 0
        });
        if (typeof body.systemPrompt !== 'string' || !body.systemPrompt.trim()) {
          throw new BridgeError('missing_system_prompt', 'systemPrompt is required', 400);
        }
        if (!resolvedUserPrompt && (typeof body.tweetText !== 'string' || !body.tweetText.trim())) {
          throw new BridgeError('missing_user_prompt', 'userPrompt or tweetText is required', 400);
        }

        const model = typeof body.model === 'string' && body.model.trim() ? body.model : DEFAULT_MODEL;
        const durationStartedAt = Date.now();
        const replyResult = await invokeReply({
          systemPrompt: body.systemPrompt,
          userPrompt: resolvedUserPrompt,
          tweetText: body.tweetText,
          context: body.context,
          requestId,
          model,
          timeoutMs: Number.isFinite(body.timeoutMs) ? body.timeoutMs : DEFAULT_TIMEOUT_MS
        });
        const text = typeof replyResult === 'string' ? replyResult.trim() : replyResult.text?.trim();
        if (!text) {
          throw new BridgeError('cli_empty_response', 'Claude Code returned no text response', 502);
        }
        const userPrompt = resolvedUserPrompt || buildUserMessage(body.tweetText, body.context);
        const tokenUsage = summarizeTokenUsage(
          typeof replyResult === 'string' ? null : replyResult.tokenUsage
        ) || createEstimatedTokenUsage({
          systemPrompt: body.systemPrompt,
          userPrompt,
          outputText: text
        });

        logRequest(requestId, 'Token usage', {
          ...tokenUsage,
          csvPath: TOKEN_USAGE_CSV_PATH
        });
        if (tokenUsageCsvLogger) {
          void tokenUsageCsvLogger.append({
            requestId,
            provider: 'claude-code-local',
            model,
            mode: typeof body.mode === 'string' ? body.mode : '',
            phase: typeof body.phase === 'string' ? body.phase : '',
            status: 'ready',
            tokenUsage,
            promptChars: `${body.systemPrompt}\n${userPrompt}`.length,
            systemPromptChars: body.systemPrompt.length,
            userPromptChars: userPrompt.length,
            replyChars: text.length,
            durationMs: Date.now() - durationStartedAt
          }).catch((error) => {
            logRequest(requestId, 'Failed to append token usage CSV', {
              error: error.message,
              csvPath: TOKEN_USAGE_CSV_PATH
            });
          });
        }
        logRequest(requestId, `HTTP response sent in ${formatDurationNs(requestStartedAt)}`);
        sendJson(res, 200, { text, tokenUsage });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof BridgeError) {
        sendJson(res, error.status, { error: error.message, code: error.code });
        return;
      }

      sendJson(res, 500, { error: error.message || 'Unexpected bridge error', code: 'unexpected_error' });
    }
  });
}

async function startBridgeServer() {
  await ensureBridgeWorkdir();
  await writeFile(TRACE_LOG_PATH, '', 'utf8');
  const server = createBridgeServer();
  await new Promise((resolve) => server.listen(DEFAULT_PORT, '127.0.0.1', resolve));
  logRequest('system', 'Bridge started', {
    port: DEFAULT_PORT,
    model: DEFAULT_MODEL,
    traceLogPath: TRACE_LOG_PATH,
    tokenUsageCsvPath: TOKEN_USAGE_CSV_PATH
  });
  console.log(`Claude Code bridge listening on http://127.0.0.1:${DEFAULT_PORT}`);
  return server;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  startBridgeServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  BRIDGE_WORKDIR,
  BridgeError,
  CLAUDE_BRIDGE_SETTINGS,
  DEFAULT_CLAUDE_BIN,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  TRACE_LOG_PATH,
  appendTraceLog,
  buildClaudeExecInvocation,
  buildCliPrompt,
  createBridgeServer,
  ensureBridgeWorkdir,
  extractFirstJsonObject,
  getClaudeStatus,
  invokeClaudeCode,
  mapCliExecutionError,
  parseClaudeAuthStatus,
  parseClaudeJsonOutput,
  parseClaudeJsonOutputResult,
  PROMPT_DUMP_PATH,
  startBridgeServer
};
