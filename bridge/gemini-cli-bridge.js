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
const DEFAULT_TIMEOUT_MS = Number(process.env.XGA_GEMINI_CLI_TIMEOUT_MS || '45000');
const DEFAULT_MODEL = process.env.XGA_GEMINI_CLI_MODEL || GEMINI_CLI_MODEL;
const DEFAULT_GEMINI_BIN = process.env.XGA_GEMINI_CLI_BIN || 'gemini';
const TRACE_LOG_PATH = process.env.XGA_GEMINI_TRACE_LOG || '/tmp/xga-gemini-bridge.log';
const GEMINI_CONFIG_DIRNAME = '.gemini';
const GEMINI_AUTH_FILES = ['google_accounts.json', 'installation_id', 'oauth_creds.json', 'state.json'];

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

function buildCliPrompt(systemPrompt, tweetText, context) {
  const userMessage = buildUserMessage(tweetText, context);
  return `${systemPrompt}\n\nUser request:\n${userMessage}\n\nReturn only the final X reply text. No markdown, no quotes, no explanation.`;
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
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
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

  return new BridgeError(
    'cli_failure',
    combined || 'Gemini CLI failed to generate a reply.',
    502
  );
}

function buildMinimalSettings(sourceSettings = {}) {
  return {
    general: {
      previewFeatures: sourceSettings?.general?.previewFeatures === true
    },
    security: {
      auth: {
        selectedType: sourceSettings?.security?.auth?.selectedType || 'oauth-personal'
      }
    }
  };
}

async function ensureIsolatedGeminiHome(rootDir) {
  const startedAt = nowNs();
  const sourceConfigDir = path.join(os.homedir(), GEMINI_CONFIG_DIRNAME);
  const targetConfigDir = path.join(rootDir, GEMINI_CONFIG_DIRNAME);
  await mkdir(targetConfigDir, { recursive: true });

  for (const fileName of GEMINI_AUTH_FILES) {
    const sourcePath = path.join(sourceConfigDir, fileName);
    const targetPath = path.join(targetConfigDir, fileName);

    try {
      await copyFile(sourcePath, targetPath);
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

  logRequest('setup', `Prepared isolated Gemini home in ${formatDurationNs(startedAt)}`, {
    targetConfigDir
  });
  return rootDir;
}

async function getGeminiStatus({ geminiBin = DEFAULT_GEMINI_BIN } = {}) {
  try {
    const { stdout } = await execFileAsync(geminiBin, ['--version'], {
      cwd: os.homedir(),
      timeout: 5000,
      maxBuffer: 64 * 1024
    });
    return {
      installed: true,
      binary: geminiBin,
      version: stdout.trim()
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        installed: false,
        binary: geminiBin
      };
    }

    return {
      installed: false,
      binary: geminiBin,
      error: error.message
    };
  }
}

async function invokeGeminiCli({
  systemPrompt,
  tweetText,
  context,
  requestId = `bridge-${Date.now().toString(36)}`,
  model = DEFAULT_MODEL,
  geminiBin = DEFAULT_GEMINI_BIN,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const startedAt = nowNs();
  const prompt = buildCliPrompt(systemPrompt, tweetText, context);
  logRequest(requestId, 'Prepared CLI prompt', {
    model,
    promptLength: prompt.length
  });

  const isolateStartedAt = nowNs();
  const isolatedHome = await ensureIsolatedGeminiHome(path.join(os.tmpdir(), 'xga-gemini-cli-home'));
  logRequest(requestId, `Isolated Gemini home ready in ${formatDurationNs(isolateStartedAt)}`);

  try {
    const execStartedAt = nowNs();
    const { stdout } = await execFileAsync(geminiBin, [
      '--model',
      model,
      '--prompt',
      prompt,
      '--output-format',
      'json'
    ], {
      cwd: isolatedHome,
      env: {
        ...process.env,
        HOME: isolatedHome
      },
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024
    });
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
        logRequest(requestId, 'HTTP request received', {
          tweetLength: body.tweetText?.length || 0,
          threadCount: body.context?.threadTweets?.length || 0
        });
        if (typeof body.systemPrompt !== 'string' || !body.systemPrompt.trim()) {
          throw new BridgeError('missing_system_prompt', 'systemPrompt is required', 400);
        }
        if (typeof body.tweetText !== 'string' || !body.tweetText.trim()) {
          throw new BridgeError('missing_tweet_text', 'tweetText is required', 400);
        }

        const text = await invokeReply({
          systemPrompt: body.systemPrompt,
          tweetText: body.tweetText,
          context: body.context,
          requestId,
          model: typeof body.model === 'string' && body.model.trim() ? body.model : DEFAULT_MODEL
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
  BridgeError,
  DEFAULT_GEMINI_BIN,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  TRACE_LOG_PATH,
  appendTraceLog,
  buildCliPrompt,
  buildMinimalSettings,
  createBridgeServer,
  ensureIsolatedGeminiHome,
  extractFirstJsonObject,
  getGeminiStatus,
  invokeGeminiCli,
  mapCliExecutionError,
  parseCliJsonOutput,
  startBridgeServer
};
