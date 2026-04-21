import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { GEMINI_CLI_MODEL, buildUserMessage } from '../lib/api.js';

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = Number(process.env.XGA_GEMINI_BRIDGE_PORT || '43117');
const DEFAULT_TIMEOUT_MS = Number(process.env.XGA_GEMINI_CLI_TIMEOUT_MS || '60000');
const DEFAULT_MODEL = process.env.XGA_GEMINI_CLI_MODEL || GEMINI_CLI_MODEL;
const DEFAULT_GEMINI_BIN = process.env.XGA_GEMINI_CLI_BIN || 'gemini';
const TRACE_LOG_PATH = process.env.XGA_GEMINI_TRACE_LOG || '/tmp/xga-gemini-bridge.log';
const GEMINI_CONFIG_DIRNAME = '.gemini';
const GEMINI_AUTH_FILES = ['google_accounts.json', 'installation_id', 'oauth_creds.json', 'state.json'];
const GEMINI_STATUS_TTL_MS = 10000;
const BRIDGE_ROOT = path.join(os.tmpdir(), 'xga-gemini-cli-bridge');
const BRIDGE_HOME_ROOT = path.join(BRIDGE_ROOT, 'home');
const BRIDGE_WORKDIR = path.join(BRIDGE_ROOT, 'workdir');
const BRIDGE_SYSTEM_PROMPT_PATH = path.join(BRIDGE_ROOT, 'system.md');

let runtimePromise = null;
let queueTail = Promise.resolve();
let geminiStatusCache = {
  value: null,
  expiresAt: 0
};

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
  return [
    'System instructions:',
    systemPrompt,
    '',
    'User request:',
    userPrompt,
    '',
    'Follow the system instructions exactly.',
    'Return only the requested final output.'
  ].join('\n');
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

function parseCliJsonOutput(stdout) {
  const jsonText = extractFirstJsonObject(stdout);
  if (!jsonText) {
    throw new BridgeError('cli_invalid_json', 'Gemini CLI returned invalid JSON output', 502);
  }

  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new BridgeError('cli_invalid_json', 'Gemini CLI returned invalid JSON output', 502);
  }

  if (payload?.error?.message) {
    throw new BridgeError('cli_failure', payload.error.message, 502);
  }

  if (typeof payload?.response !== 'string') {
    throw new BridgeError('cli_invalid_json', 'Gemini CLI returned invalid JSON output', 502);
  }

  const text = payload.response.trim();
  if (!text) {
    throw new BridgeError('cli_empty_response', 'Gemini CLI returned no text response', 502);
  }

  return text;
}

function mapCliExecutionError(error, stdout = '', stderr = '') {
  if (error?.code === 'ENOENT') {
    return new BridgeError('gemini_not_found', 'Gemini CLI is not installed or not on PATH.', 503);
  }

  if (error?.code === 'ETIMEDOUT' || error?.killed) {
    return new BridgeError('gemini_timeout', 'Gemini CLI timed out while generating a reply.', 504);
  }

  try {
    return new BridgeError('cli_failure', parseCliJsonOutput(stdout), 502);
  } catch (parsedError) {
    if (parsedError instanceof BridgeError && parsedError.code === 'cli_failure') return parsedError;
  }

  const combined = `${stderr}\n${stdout}`.trim();

  if (/sign in|login|log in|authenticate|authentication|api key|auth/i.test(combined)) {
    return new BridgeError('gemini_auth_required', 'Gemini CLI is not authenticated. Run `gemini` once locally and sign in.', 503);
  }

  if (/model/i.test(combined) && /unknown|unsupported|invalid|not found/i.test(combined)) {
    return new BridgeError('gemini_model_unavailable', 'Gemini CLI rejected the configured model.', 502);
  }

  return new BridgeError('cli_failure', combined || 'Gemini CLI failed to generate a reply.', 502);
}

function buildMinimalSettings(sourceSettings = {}) {
  return {
    hooksConfig: {
      enabled: false
    },
    skills: {
      enabled: false
    },
    useWriteTodos: false,
    context: {
      fileName: '__XGA_DISABLED_CONTEXT__.md',
      includeDirectoryTree: false,
      discoveryMaxDirs: 0,
      memoryBoundaryMarkers: [],
      includeDirectories: [],
      loadMemoryFromIncludeDirectories: false
    },
    security: {
      auth: {
        selectedType: sourceSettings?.security?.auth?.selectedType || 'oauth-personal'
      }
    }
  };
}

function buildBridgeSystemPrompt() {
  return [
    '# XGA Gemini Bridge',
    '',
    'You are a tiny headless reply engine for X.',
    'Do not use tools or side channels.',
    'Honor the caller-provided instructions exactly.',
    'Return only the requested final output.'
  ].join('\n');
}

async function ensureGeminiRuntime({
  rootDir = BRIDGE_ROOT,
  homeRoot = BRIDGE_HOME_ROOT,
  workdir = BRIDGE_WORKDIR,
  systemPromptPath = BRIDGE_SYSTEM_PROMPT_PATH
} = {}) {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    const sourceConfigDir = path.join(os.homedir(), GEMINI_CONFIG_DIRNAME);
    const targetConfigDir = path.join(homeRoot, GEMINI_CONFIG_DIRNAME);
    await mkdir(targetConfigDir, { recursive: true });
    await mkdir(workdir, { recursive: true });
    await mkdir(rootDir, { recursive: true });

    for (const fileName of GEMINI_AUTH_FILES) {
      try {
        await copyFile(path.join(sourceConfigDir, fileName), path.join(targetConfigDir, fileName));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    let sourceSettings = {};
    try {
      sourceSettings = JSON.parse(await readFile(path.join(sourceConfigDir, 'settings.json'), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    await writeFile(
      path.join(targetConfigDir, 'settings.json'),
      `${JSON.stringify(buildMinimalSettings(sourceSettings), null, 2)}\n`,
      'utf8'
    );
    await writeFile(systemPromptPath, `${buildBridgeSystemPrompt()}\n`, 'utf8');

    logRequest('setup', 'Prepared Gemini runtime', {
      homeRoot,
      workdir,
      systemPromptPath
    });

    return {
      rootDir,
      homeRoot,
      workdir,
      systemPromptPath
    };
  })().catch((error) => {
    runtimePromise = null;
    throw error;
  });

  return runtimePromise;
}

function buildGeminiExecInvocation({
  geminiBin = DEFAULT_GEMINI_BIN,
  model = DEFAULT_MODEL,
  prompt,
  runtime,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  return {
    file: geminiBin,
    args: [
      '--model',
      model,
      '--prompt',
      prompt,
      '--sandbox=false',
      '--output-format',
      'json'
    ],
    options: {
      cwd: runtime.workdir,
      env: {
        ...process.env,
        GEMINI_CLI_HOME: runtime.homeRoot,
        GEMINI_SYSTEM_MD: runtime.systemPromptPath,
        HOME: runtime.homeRoot,
        NO_COLOR: '1'
      },
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024
    }
  };
}

function queueInvocation(task) {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});
  return run;
}

async function getGeminiStatus({ geminiBin = DEFAULT_GEMINI_BIN } = {}) {
  if (geminiStatusCache.value && geminiStatusCache.expiresAt > Date.now()) {
    return geminiStatusCache.value;
  }

  let status;
  try {
    const { stdout } = await execFileAsync(geminiBin, ['--version'], {
      cwd: os.homedir(),
      timeout: 5000,
      maxBuffer: 64 * 1024
    });
    status = {
      installed: true,
      binary: geminiBin,
      version: stdout.trim()
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      status = {
        installed: false,
        binary: geminiBin
      };
    } else {
      status = {
        installed: false,
        binary: geminiBin,
        error: error.message
      };
    }
  }

  geminiStatusCache = {
    value: status,
    expiresAt: Date.now() + GEMINI_STATUS_TTL_MS
  };
  return status;
}

async function invokeGeminiCli({
  systemPrompt,
  userPrompt,
  tweetText,
  context,
  requestId = `bridge-${Date.now().toString(36)}`,
  model = DEFAULT_MODEL,
  geminiBin = DEFAULT_GEMINI_BIN,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const startedAt = nowNs();
  const runtime = await ensureGeminiRuntime();
  const resolvedUserPrompt = typeof userPrompt === 'string' && userPrompt.trim()
    ? userPrompt
    : buildUserMessage(tweetText, context);
  const prompt = buildCliPrompt(systemPrompt, resolvedUserPrompt);
  logRequest(requestId, 'Prepared CLI prompt', {
    model,
    promptLength: prompt.length,
    timeoutMs
  });

  return queueInvocation(async () => {
    try {
      const execStartedAt = nowNs();
      const invocation = buildGeminiExecInvocation({
        geminiBin,
        model,
        prompt,
        runtime,
        timeoutMs
      });
      const { stdout } = await execFileAsync(invocation.file, invocation.args, invocation.options);
      logRequest(requestId, `Gemini CLI process finished in ${formatDurationNs(execStartedAt)}`);

      const parseStartedAt = nowNs();
      const text = parseCliJsonOutput(stdout);
      logRequest(requestId, `Parsed CLI output in ${formatDurationNs(parseStartedAt)}`, {
        responseLength: text.length
      });
      logRequest(requestId, `Total bridge time ${formatDurationNs(startedAt)}`);
      return text;
    } catch (error) {
      logRequest(requestId, `Gemini CLI failed after ${formatDurationNs(startedAt)}`, {
        code: error?.code,
        message: error?.message
      });
      throw mapCliExecutionError(error, error.stdout || '', error.stderr || '');
    }
  });
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
  invokeReply = invokeGeminiCli,
  getStatus = getGeminiStatus
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
        const gemini = await getStatus();
        sendJson(res, 200, {
          ok: true,
          model: DEFAULT_MODEL,
          gemini
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

        const text = await invokeReply({
          systemPrompt: body.systemPrompt,
          userPrompt: resolvedUserPrompt,
          tweetText: body.tweetText,
          context: body.context,
          requestId,
          model: typeof body.model === 'string' && body.model.trim() ? body.model : DEFAULT_MODEL,
          timeoutMs: Number.isFinite(body.timeoutMs) ? body.timeoutMs : DEFAULT_TIMEOUT_MS
        });

        logRequest(requestId, `HTTP response sent in ${formatDurationNs(requestStartedAt)}`);
        sendJson(res, 200, { text });
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
  await ensureGeminiRuntime();
  await writeFile(TRACE_LOG_PATH, '', 'utf8');
  const server = createBridgeServer();
  await new Promise((resolve) => server.listen(DEFAULT_PORT, '127.0.0.1', resolve));
  logRequest('system', 'Bridge started', {
    port: DEFAULT_PORT,
    model: DEFAULT_MODEL,
    traceLogPath: TRACE_LOG_PATH
  });
  console.log(`Gemini CLI bridge listening on http://127.0.0.1:${DEFAULT_PORT}`);
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
  BRIDGE_HOME_ROOT,
  BRIDGE_ROOT,
  BRIDGE_SYSTEM_PROMPT_PATH,
  BRIDGE_WORKDIR,
  BridgeError,
  DEFAULT_GEMINI_BIN,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  TRACE_LOG_PATH,
  appendTraceLog,
  buildBridgeSystemPrompt,
  buildCliPrompt,
  buildGeminiExecInvocation,
  buildMinimalSettings,
  createBridgeServer,
  ensureGeminiRuntime,
  extractFirstJsonObject,
  getGeminiStatus,
  invokeGeminiCli,
  mapCliExecutionError,
  parseCliJsonOutput,
  startBridgeServer
};
