import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { GEMINI_CLI_MODEL, buildUserMessage } from '../lib/api.js';
import {
  createEstimatedTokenUsage,
  extractGeminiCliStatsTokenUsage,
  extractGenericTokenUsage,
  summarizeTokenUsage
} from '../lib/token-usage.js';
import {
  DEFAULT_TOKEN_USAGE_CSV_PATH,
  createTokenUsageCsvLogger
} from './token-usage-csv.js';

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = Number(process.env.XGA_GEMINI_BRIDGE_PORT || '43117');
const DEFAULT_TIMEOUT_MS = Number(process.env.XGA_GEMINI_CLI_TIMEOUT_MS || '60000');
const DEFAULT_CONCURRENCY = Number(process.env.XGA_GEMINI_BRIDGE_CONCURRENCY || '2');
const DEFAULT_MODEL = process.env.XGA_GEMINI_CLI_MODEL || GEMINI_CLI_MODEL;
const DEFAULT_GEMINI_BIN = process.env.XGA_GEMINI_CLI_BIN || 'gemini';
const TRACE_LOG_PATH = process.env.XGA_GEMINI_TRACE_LOG || '/tmp/xga-gemini-bridge.log';
const RESET_TRACE_LOG_ON_START = process.env.XGA_GEMINI_TRACE_RESET === '1';
const TOKEN_USAGE_CSV_PATH = process.env.XGA_GEMINI_TOKEN_USAGE_CSV ||
  process.env.XGA_TOKEN_USAGE_CSV ||
  DEFAULT_TOKEN_USAGE_CSV_PATH;
const GEMINI_CONFIG_DIRNAME = '.gemini';
const GEMINI_AUTH_FILES = ['google_accounts.json', 'installation_id', 'oauth_creds.json', 'state.json'];
const GEMINI_STATUS_TTL_MS = 10000;
const BRIDGE_ROOT = path.join(os.tmpdir(), 'xga-gemini-cli-bridge');
const BRIDGE_HOME_ROOT = path.join(BRIDGE_ROOT, 'home');
const BRIDGE_WORKDIR = path.join(BRIDGE_ROOT, 'workdir');
const BRIDGE_SYSTEM_PROMPT_PATH = path.join(BRIDGE_ROOT, 'system.md');
const MAX_CONTEXT_MEDIA_ITEMS = 4;
const MAX_MEDIA_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 10000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

let runtimePromise = null;
let activeInvocationCount = 0;
const pendingInvocations = [];
let geminiStatusCache = {
  value: null,
  expiresAt: 0
};
const TIMEOUT_RETRY_LIMIT = 1;
const tokenUsageCsv = createTokenUsageCsvLogger(TOKEN_USAGE_CSV_PATH);

function nowNs() {
  return process.hrtime.bigint();
}

function formatDurationNs(startedAtNs) {
  const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
  return `${Math.round(elapsedMs)}ms`;
}

function formatDurationMs(durationMs) {
  return `${Math.round(durationMs)}ms`;
}

function getOutputTail(value, maxLength = 400) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.length <= maxLength ? text : text.slice(-maxLength);
}

function killProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {}

  try {
    process.kill(pid, signal);
  } catch {}
}

function createCliError({ file, code, signal, stdout, stderr, timedOut = false, killed = false }) {
  const error = timedOut
    ? new Error(`Command timed out: ${file}`)
    : new Error(`Command failed: ${file} exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
  error.code = timedOut ? 'ETIMEDOUT' : code;
  error.signal = signal;
  error.killed = killed || timedOut;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function execFileProcessGroup(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      timeout = 0,
      maxBuffer = 1024 * 1024,
      ...spawnOptions
    } = options;
    const child = spawn(file, args, {
      ...spawnOptions,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutId = null;
    let killId = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (killId) clearTimeout(killId);
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const appendOutput = (streamName, chunk) => {
      const nextValue = streamName === 'stdout' ? stdout + chunk : stderr + chunk;
      const combinedLength = Buffer.byteLength(streamName === 'stdout' ? nextValue + stderr : stdout + nextValue);
      if (combinedLength > maxBuffer) {
        killProcessGroup(child.pid, 'SIGTERM');
        killId = setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), 1000);
        rejectOnce(createCliError({
          file,
          code: 'ENOBUFS',
          stdout,
          stderr,
          killed: true
        }));
        return;
      }

      if (streamName === 'stdout') stdout = nextValue;
      else stderr = nextValue;
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => appendOutput('stdout', chunk));
    child.stderr?.on('data', (chunk) => appendOutput('stderr', chunk));

    child.on('error', (error) => {
      error.stdout = stdout;
      error.stderr = stderr;
      rejectOnce(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        reject(createCliError({
          file,
          code,
          signal,
          stdout,
          stderr,
          timedOut: true
        }));
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(createCliError({ file, code, signal, stdout, stderr }));
    });

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child.pid, 'SIGTERM');
        killId = setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), 1000);
      }, timeout);
    }
  });
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

function normalizeWhitespace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function normalizeMediaUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed;
}

function normalizeMediaItems(media) {
  if (!Array.isArray(media)) return [];

  const seen = new Set();
  const items = [];
  for (const item of media) {
    const url = normalizeMediaUrl(item?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      type: item?.type === 'video' ? 'video' : 'image',
      url,
      altText: normalizeWhitespace(item?.altText || '')
    });
    if (items.length >= MAX_CONTEXT_MEDIA_ITEMS) break;
  }

  return items;
}

function getPromptImageMedia(context) {
  const quotedMedia = normalizeMediaItems(context?.quotedTweet?.media)
    .map((item) => ({ ...item, source: 'quoted post' }));
  const postMedia = normalizeMediaItems(context?.media)
    .map((item) => ({ ...item, source: 'reply target post' }));

  return [...quotedMedia, ...postMedia]
    .filter((item) => item.type === 'image')
    .slice(0, MAX_CONTEXT_MEDIA_ITEMS);
}

function inferImageMimeType(url, headerValue = '') {
  const header = normalizeWhitespace(headerValue).split(';')[0].toLowerCase();
  if (SUPPORTED_IMAGE_MIME_TYPES.has(header)) return header;

  try {
    const parsed = new URL(url);
    const format = parsed.searchParams.get('format')?.toLowerCase();
    if (format === 'jpg' || format === 'jpeg') return 'image/jpeg';
    if (format === 'png') return 'image/png';
    if (format === 'webp') return 'image/webp';
    if (format === 'gif') return 'image/gif';

    const pathname = parsed.pathname.toLowerCase();
    if (/\.(jpe?g)$/.test(pathname)) return 'image/jpeg';
    if (/\.png$/.test(pathname)) return 'image/png';
    if (/\.webp$/.test(pathname)) return 'image/webp';
    if (/\.gif$/.test(pathname)) return 'image/gif';
  } catch {}

  return '';
}

function extensionForMimeType(mimeType) {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'jpg';
  }
}

function sanitizeFilenamePart(value) {
  return String(value || 'media')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'media';
}

async function fetchImageBuffer(mediaItem) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(mediaItem.url, {
      signal: controller.signal,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'XGA-Gemini-Bridge/1.0'
      }
    });
    if (!res.ok) return null;

    const contentLength = Number(res.headers.get('content-length') || '0');
    if (contentLength > MAX_MEDIA_DOWNLOAD_BYTES) return null;

    const mimeType = inferImageMimeType(mediaItem.url, res.headers.get('content-type') || '');
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return null;

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_MEDIA_DOWNLOAD_BYTES) return null;

    return {
      mimeType,
      buffer: Buffer.from(arrayBuffer)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function prepareCliImageReferences({ context, requestId, workdir }) {
  const media = getPromptImageMedia(context);
  if (media.length === 0) return [];

  const mediaDir = path.join(workdir, 'xga-media');
  await mkdir(mediaDir, { recursive: true });
  const safeRequestId = sanitizeFilenamePart(requestId);
  const refs = [];

  for (let index = 0; index < media.length; index += 1) {
    const item = media[index];
    const image = await fetchImageBuffer(item);
    if (!image) continue;

    const ext = extensionForMimeType(image.mimeType);
    const filename = `${safeRequestId}-${index + 1}.${ext}`;
    const absolutePath = path.join(mediaDir, filename);
    await writeFile(absolutePath, image.buffer);
    refs.push({
      ...item,
      relativePath: path.relative(workdir, absolutePath)
    });
  }

  return refs;
}

function appendCliImageReferences(userPrompt, imageRefs) {
  if (!imageRefs.length) return userPrompt;

  const lines = [
    userPrompt,
    '',
    'Image attachments for vision context:'
  ];

  imageRefs.forEach((item, index) => {
    const alt = item.altText ? ` alt="${item.altText}"` : '';
    lines.push(`- ${item.source || 'post'} image ${index + 1}: @${item.relativePath}${alt}`);
  });

  return lines.join('\n');
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

function parseCliJsonOutputResult(stdout) {
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

  return {
    text,
    tokenUsage: summarizeTokenUsage(
      extractGeminiCliStatsTokenUsage(payload) ||
      extractGenericTokenUsage(payload, 'gemini-cli')
    )
  };
}

function parseCliJsonOutput(stdout) {
  return parseCliJsonOutputResult(stdout).text;
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
  return new Promise((resolve, reject) => {
    const enqueuedAt = Date.now();

    const run = () => {
      const queueWaitMs = Date.now() - enqueuedAt;
      activeInvocationCount += 1;
      Promise.resolve()
        .then(() => task({ queueWaitMs }))
        .then(resolve, reject)
        .finally(() => {
          activeInvocationCount = Math.max(0, activeInvocationCount - 1);
          const next = pendingInvocations.shift();
          if (next) next();
        });
    };

    if (activeInvocationCount < DEFAULT_CONCURRENCY) {
      run();
      return;
    }

    pendingInvocations.push(run);
  });
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
  const imageRefs = await prepareCliImageReferences({
    context,
    requestId,
    workdir: runtime.workdir
  });
  const promptUserMessage = appendCliImageReferences(resolvedUserPrompt, imageRefs);
  const prompt = buildCliPrompt(systemPrompt, promptUserMessage);
  logRequest(requestId, 'Prepared CLI prompt', {
    model,
    promptLength: prompt.length,
    timeoutMs,
    imageAttachmentCount: imageRefs.length
  });

  return queueInvocation(async ({ queueWaitMs }) => {
    if (queueWaitMs > 0) {
      logRequest(requestId, `Waited ${formatDurationMs(queueWaitMs)} in bridge queue`, {
        concurrency: DEFAULT_CONCURRENCY,
        activeInvocationCount
      });
    }

    let lastMappedError = null;

    for (let attempt = 1; attempt <= TIMEOUT_RETRY_LIMIT + 1; attempt += 1) {
      try {
        const execStartedAt = nowNs();
        const invocation = buildGeminiExecInvocation({
          geminiBin,
          model,
          prompt,
          runtime,
          timeoutMs
        });
        const { stdout } = await execFileProcessGroup(invocation.file, invocation.args, invocation.options);
        logRequest(requestId, `Gemini CLI process finished in ${formatDurationNs(execStartedAt)}`, {
          attempt
        });

        const parseStartedAt = nowNs();
        const result = parseCliJsonOutputResult(stdout);
        const tokenUsage = result.tokenUsage || createEstimatedTokenUsage({
          prompt,
          outputText: result.text
        });
        logRequest(requestId, `Parsed CLI output in ${formatDurationNs(parseStartedAt)}`, {
          attempt,
          responseLength: result.text.length,
          tokenUsage
        });
        logRequest(requestId, `Total bridge time ${formatDurationNs(startedAt)}`, {
          attempt,
          tokenUsage
        });
        return {
          text: result.text,
          tokenUsage
        };
      } catch (error) {
        const stdoutTail = getOutputTail(error?.stdout);
        const stderrTail = getOutputTail(error?.stderr);
        const mappedError = mapCliExecutionError(error, error?.stdout || '', error?.stderr || '');
        lastMappedError = mappedError;

        logRequest(requestId, `Gemini CLI failed after ${formatDurationNs(startedAt)}`, {
          attempt,
          code: error?.code,
          message: error?.message,
          mappedCode: mappedError.code,
          stdoutTail,
          stderrTail
        });

        if (mappedError.code === 'gemini_timeout' && attempt <= TIMEOUT_RETRY_LIMIT) {
          logRequest(requestId, 'Retrying Gemini CLI after timeout', {
            attempt,
            nextAttempt: attempt + 1
          });
          continue;
        }

        throw mappedError;
      }
    }

    throw lastMappedError || new BridgeError('cli_failure', 'Gemini CLI failed to generate a reply.', 502);
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
  getStatus = getGeminiStatus,
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
          throw new BridgeError('cli_empty_response', 'Gemini CLI returned no text response', 502);
        }
        const userPrompt = resolvedUserPrompt || buildUserMessage(body.tweetText, body.context);
        const tokenUsage = summarizeTokenUsage(
          typeof replyResult === 'string' ? null : replyResult.tokenUsage
        ) || createEstimatedTokenUsage({
          systemPrompt: body.systemPrompt,
          userPrompt,
          outputText: text
        });

        const tokenUsageEntry = {
          requestId,
          provider: 'gemini-cli-local',
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
        };
        logRequest(requestId, 'Token usage', {
          ...tokenUsage,
          csvPath: TOKEN_USAGE_CSV_PATH
        });
        if (tokenUsageCsvLogger) {
          void tokenUsageCsvLogger.append(tokenUsageEntry).catch((error) => {
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
  await ensureGeminiRuntime();
  await mkdir(path.dirname(TRACE_LOG_PATH), { recursive: true });
  if (RESET_TRACE_LOG_ON_START) {
    await writeFile(TRACE_LOG_PATH, '', 'utf8');
  }
  const server = createBridgeServer();
  await new Promise((resolve) => server.listen(DEFAULT_PORT, '127.0.0.1', resolve));
  logRequest('system', 'Bridge started', {
    port: DEFAULT_PORT,
    model: DEFAULT_MODEL,
    concurrency: DEFAULT_CONCURRENCY,
    traceLogPath: TRACE_LOG_PATH,
    tokenUsageCsvPath: TOKEN_USAGE_CSV_PATH
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
  DEFAULT_CONCURRENCY,
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
  parseCliJsonOutputResult,
  startBridgeServer
};
