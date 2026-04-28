import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BridgeError,
  buildBridgeSystemPrompt,
  buildCliPrompt,
  buildGeminiExecInvocation,
  buildMinimalSettings,
  createBridgeServer,
  extractFirstJsonObject,
  getGeminiRuntimePaths,
  parseCliJsonOutput
} from '../bridge/gemini-cli-bridge.js';

async function withServer(server, fn) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('parseCliJsonOutput', () => {
  it('extracts the first JSON object from noisy stdout', () => {
    const text = [
      'Loaded cached credentials.',
      '{',
      '  "session_id": "a",',
      '  "response": "hello",',
      '  "stats": {}',
      '}',
      'Hook execution complete'
    ].join('\n');

    assert.equal(
      extractFirstJsonObject(text),
      '{\n  "session_id": "a",\n  "response": "hello",\n  "stats": {}\n}'
    );
    assert.equal(parseCliJsonOutput(text), 'hello');
  });
});

describe('buildMinimalSettings', () => {
  it('produces the bridge-specific minimal runtime config', () => {
    const settings = buildMinimalSettings({
      security: { auth: { selectedType: 'oauth-personal' } }
    });

    assert.deepEqual(settings, {
      hooksConfig: { enabled: false },
      skills: { enabled: false },
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
        auth: { selectedType: 'oauth-personal' }
      }
    });
  });
});

describe('buildBridgeSystemPrompt', () => {
  it('creates a minimal bridge prompt', () => {
    assert.match(buildBridgeSystemPrompt(), /tiny headless reply engine/i);
  });
});

describe('buildGeminiExecInvocation', () => {
  it('creates separate runtime paths for each slot', () => {
    const first = getGeminiRuntimePaths(0);
    const second = getGeminiRuntimePaths(1);

    assert.notEqual(first.homeRoot, second.homeRoot);
    assert.notEqual(first.workdir, second.workdir);
    assert.match(first.homeRoot, /slot-0/);
    assert.match(second.homeRoot, /slot-1/);
  });

  it('injects isolated runtime paths and prompt args', () => {
    const invocation = buildGeminiExecInvocation({
      geminiBin: 'gemini',
      model: 'flash-lite',
      prompt: 'prompt body',
      runtime: {
        homeRoot: '/tmp/xga-home',
        workdir: '/tmp/xga-workdir',
        systemPromptPath: '/tmp/xga-system.md'
      },
      timeoutMs: 12000
    });

    assert.deepEqual(invocation.args, [
      '--model',
      'flash-lite',
      '--prompt',
      'prompt body',
      '--sandbox=false',
      '--output-format',
      'json'
    ]);
    assert.equal(invocation.options.cwd, '/tmp/xga-workdir');
    assert.equal(invocation.options.env.GEMINI_CLI_HOME, '/tmp/xga-home');
    assert.equal(invocation.options.env.GEMINI_SYSTEM_MD, '/tmp/xga-system.md');
    assert.equal(invocation.options.timeout, 12000);
  });
});

describe('buildCliPrompt', () => {
  it('combines system and user prompts', () => {
    const prompt = buildCliPrompt('system prompt', 'user prompt');
    assert.match(prompt, /System instructions:/);
    assert.match(prompt, /user prompt/);
  });
});

describe('createBridgeServer', () => {
  it('returns health info', async () => {
    const server = createBridgeServer({
      getStatus: async () => ({ installed: true, binary: 'gemini', version: '0.27.3' })
    });

    await withServer(server, async (origin) => {
      const res = await fetch(`${origin}/health`);
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.gemini.installed, true);
    });
  });

  it('passes userPrompt and timeoutMs to the injected handler', async () => {
    let payload;
    const server = createBridgeServer({
      invokeReply: async (request) => {
        payload = request;
        return 'reply text';
      },
      tokenUsageCsvLogger: null
    });

    await withServer(server, async (origin) => {
      const res = await fetch(`${origin}/generate-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: 'system prompt',
          userPrompt: 'user prompt',
          model: 'flash-lite',
          timeoutMs: 9000
        })
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.text, 'reply text');
      assert.equal(payload.userPrompt, 'user prompt');
      assert.equal(payload.timeoutMs, 9000);
    });
  });

  it('returns structured bridge errors', async () => {
    const server = createBridgeServer({
      invokeReply: async () => {
        throw new BridgeError('gemini_auth_required', 'Gemini CLI is not authenticated. Run `gemini` once locally and sign in.', 503);
      }
    });

    await withServer(server, async (origin) => {
      const res = await fetch(`${origin}/generate-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: 'system prompt',
          userPrompt: 'user prompt'
        })
      });
      const data = await res.json();
      assert.equal(res.status, 503);
      assert.equal(data.code, 'gemini_auth_required');
    });
  });
});
