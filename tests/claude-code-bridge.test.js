import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BridgeError,
  buildClaudeExecInvocation,
  buildCliPrompt,
  createBridgeServer,
  extractFirstJsonObject,
  parseClaudeAuthStatus,
  parseClaudeJsonOutput
} from '../bridge/claude-code-bridge.js';

async function withServer(server, fn) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('parseClaudeJsonOutput', () => {
  it('extracts the first JSON object from noisy stdout', () => {
    const text = [
      'Claude Code bootstrap log',
      '{',
      '  "type": "result",',
      '  "subtype": "success",',
      '  "result": "hello"',
      '}',
      'Done'
    ].join('\n');

    assert.equal(
      extractFirstJsonObject(text),
      '{\n  "type": "result",\n  "subtype": "success",\n  "result": "hello"\n}'
    );
    assert.equal(
      parseClaudeJsonOutput(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hello' })),
      'hello'
    );
  });
});

describe('parseClaudeAuthStatus', () => {
  it('extracts login metadata', () => {
    assert.deepEqual(
      parseClaudeAuthStatus(JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'test@example.com',
        subscriptionType: 'max',
        apiProvider: 'firstParty'
      })),
      {
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'test@example.com',
        subscriptionType: 'max',
        apiProvider: 'firstParty'
      }
    );
  });
});

describe('buildCliPrompt', () => {
  it('combines system and user prompts for debug dumps', () => {
    const prompt = buildCliPrompt('system prompt', 'user prompt');
    assert.match(prompt, /system prompt/);
    assert.match(prompt, /user prompt/);
  });
});

describe('buildClaudeExecInvocation', () => {
  it('includes the stripped-down local login flags', () => {
    const invocation = buildClaudeExecInvocation({
      claudeBin: 'claude',
      model: 'claude-haiku-4-5-20251001',
      userPrompt: 'user prompt',
      systemPrompt: 'system prompt',
      workdir: '/tmp/xga-claude',
      timeoutMs: 25000
    });

    assert.equal(invocation.file, 'claude');
    assert.ok(invocation.args.includes('--setting-sources'));
    assert.ok(invocation.args.includes('local'));
    assert.ok(invocation.args.includes('--effort'));
    assert.ok(invocation.args.includes('low'));
    assert.ok(invocation.args.includes('--disable-slash-commands'));
    assert.ok(invocation.args.includes('--tools'));
    assert.ok(invocation.args.includes(''));
    assert.ok(invocation.args.includes('--system-prompt'));
    assert.equal(invocation.options.cwd, '/tmp/xga-claude');
    assert.equal(invocation.options.timeout, 25000);
  });
});

describe('createBridgeServer', () => {
  it('returns health info', async () => {
    const server = createBridgeServer({
      getStatus: async () => ({
        installed: true,
        binary: 'claude',
        version: '2.1.112 (Claude Code)',
        loggedIn: true,
        subscriptionType: 'max'
      })
    });

    await withServer(server, async (origin) => {
      const res = await fetch(`${origin}/health`);
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.claude.installed, true);
      assert.equal(data.claude.subscriptionType, 'max');
    });
  });

  it('passes userPrompt and timeoutMs to the injected handler', async () => {
    let requestPayload;
    const server = createBridgeServer({
      invokeReply: async (payload) => {
        requestPayload = payload;
        return 'reply text';
      }
    });

    await withServer(server, async (origin) => {
      const res = await fetch(`${origin}/generate-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: 'system prompt',
          userPrompt: 'user prompt',
          model: 'claude-haiku-4-5-20251001',
          timeoutMs: 22000
        })
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.text, 'reply text');
      assert.equal(requestPayload.userPrompt, 'user prompt');
      assert.equal(requestPayload.timeoutMs, 22000);
    });
  });

  it('returns structured bridge errors', async () => {
    const server = createBridgeServer({
      invokeReply: async () => {
        throw new BridgeError('claude_auth_required', 'Claude Code is not authenticated. Run `claude auth login` locally and try again.', 503);
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
      assert.equal(data.code, 'claude_auth_required');
    });
  });
});
