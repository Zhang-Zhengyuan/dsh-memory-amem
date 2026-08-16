import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdmissionPolicy,
  AdmissionRejectedError,
  isAcceptingDecision,
  isHardRejectingDecision,
} from '../src/admission.js';
import { CONFIG_DEFAULTS } from '../src/invariant.js';
import type { AdmissionContext, AdmissionPolicyConfig } from '../src/types.js';

function policy(overrides: Partial<AdmissionPolicyConfig> = {}): AdmissionPolicy {
  return new AdmissionPolicy({
    config: {
      enabled: true,
      minLength: 8,
      maxLength: 2_000,
      sensitivePatterns: [],
      ephemeralPatterns: [],
      keepPatterns: [],
      poisonPatterns: [],
      semanticDedupThreshold: 0.85,
      semanticDedupMinOverlap: 0.4,
      enableLlmReview: false,
      ...overrides,
    },
  });
}

function ctx(text: string, extra: Partial<AdmissionContext> = {}): AdmissionContext {
  return { text, source: 'auto_capture', sessionId: 's1', ...extra };
}

// ---------- Config / disabled ----------

test('admission policy: disabled lets everything through as hard_keep', () => {
  const p = policy({ enabled: false });
  assert.equal(p.decide(ctx('任何内容都可以，包括 token=ghp_abc123def456ghi789jkl012mno')).kind, 'hard_keep');
  assert.equal(p.decide(ctx('')).kind, 'hard_keep');
});

test('admission policy: enabled hard-block path is independent of disabled toggle', () => {
  const enabled = policy({ enabled: true });
  const disabled = policy({ enabled: false });
  assert.equal(disabled.decide(ctx('xx')).kind, 'hard_keep');
  // enabled must still default to uncertain
  assert.equal(enabled.decide(ctx('This is a moderately sized message that has no special tokens')).kind, 'uncertain');
});

// ---------- Sensitive patterns ----------

test('sensitive: bearer token is hard_blocked', () => {
  const p = policy();
  const d = p.decide(ctx('Authorization: Bearer abc123def456ghi789jkl012mno'));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'sensitive.bearer');
});

test('sensitive: github personal access tokens are hard_blocked', () => {
  const p = policy();
  for (const prefix of ['ghp_', 'ghs_', 'gho_', 'ghu_', 'ghr_']) {
    const token = `${prefix}${'a'.repeat(40)}`;
    const d = p.decide(ctx(`I committed with token ${token}`));
    assert.equal(d.kind, 'hard_block', `${prefix} should be hard_blocked`);
    assert.equal(d.matchedRule, 'sensitive.github-token');
  }
});

test('sensitive: openai sk- keys are hard_blocked', () => {
  const p = policy();
  const d = p.decide(ctx('use sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'sensitive.openai-key');
});

test('sensitive: AWS access key id is hard_blocked', () => {
  const p = policy();
  const d = p.decide(ctx('aws_access_key_id=AKIAIOSFODNN7EXAMPLE'));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'sensitive.aws-access-key');
});

test('sensitive: PEM private key block is hard_blocked', () => {
  const p = policy();
  const d = p.decide(ctx('here is my key:\n-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----'));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'sensitive.private-key-block');
});

test('sensitive: password assignment is hard_blocked', () => {
  const p = policy();
  const d = p.decide(ctx('config password = sUp3rS3cret123'));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'sensitive.password-assignment');
});

test('sensitive: email is hard_blocked (default)', () => {
  const p = policy();
  const d = p.decide(ctx('reach me at user.name+test@example.co.uk for any follow up about this case'));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'sensitive.email-pii');
});

test('sensitive: public IPv4 literal is hard_blocked', () => {
  const p = policy();
  const d = p.decide(ctx('origin server live at 8.8.8.8 returns valid responses'));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'sensitive.ip-literal');
});

test('sensitive: reserved IPv4 literals (loopback, link-local, multicast) are NOT hard_blocked', () => {
  const p = policy();
  for (const ip of ['127.0.0.1', '169.254.10.20', '224.0.0.1', '10.1.2.3']) {
    const d = p.decide(ctx(`Reach the local machine over ${ip} for service management without exposing`));
    // 10.0.0.0/8 only blocks when a host/server keyword is present; 224+ / 169.254 / 127 always allowed through sensitive.ip-literal.
    if (ip === '10.1.2.3') {
      assert.notEqual(d.matchedRule, 'sensitive.ip-literal', `${ip} with no host keyword should not match`);
    } else {
      assert.notEqual(d.matchedRule, 'sensitive.ip-literal', `${ip} reserved range should not match`);
    }
  }
});

test('sensitive: RFC1918 IPv4 blocks only when host/server keyword present', () => {
  const p = policy();
  assert.equal(p.decide(ctx('The database server sits on 10.0.0.42 and replicates')).matchedRule, 'sensitive.ip-literal');
  assert.notEqual(p.decide(ctx('I read 10.0.0.42 from a magazine article')).matchedRule, 'sensitive.ip-literal');
});

test('sensitive: JWT-shaped triple-base64 string is hard_blocked', () => {
  const p = policy();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const d = p.decide(ctx(`session token: ${jwt} keep secret please`));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'sensitive.jwt');
});

// ---------- Ephemeral patterns ----------

test('ephemeral: pure greetings are soft_skip', () => {
  const p = policy();
  for (const greeting of ['hi', 'HI!', 'hello', 'Hey', '你好', '嗨', '嗨在吗', '好的', 'ok', 'thanks', 'thx']) {
    const d = p.decide(ctx(greeting));
    assert.equal(d.kind, 'soft_skip', `${greeting} should be soft_skip`);
    assert.equal(d.matchedRule, 'ephemeral.pure-greeting');
  }
});

test('ephemeral: filler turns are soft_skip', () => {
  const p = policy();
  for (const filler of ['please wait', 'hold on', 'one sec', '等等', '稍等', '先这样']) {
    const d = p.decide(ctx(filler));
    assert.equal(d.kind, 'soft_skip', `${filler} should be soft_skip`);
    assert.equal(d.matchedRule, 'ephemeral.filler-turn');
  }
});

test('ephemeral: stack trace fragments are soft_skip', () => {
  const p = policy();
  const trace = `TypeError: cannot read property
    at handleRequest (/Users/me/app/src/server.ts:42:7)
    at Layer.handle [as handle_request] (/Users/me/app/node_modules/express/lib/router/layer.js:95:5)`;
  const d = p.decide(ctx(trace));
  assert.equal(d.kind, 'soft_skip');
  assert.equal(d.matchedRule, 'ephemeral.stack-trace');
});

// ---------- Keep patterns ----------

test('keep: explicit decision markers are hard_keep', () => {
  const p = policy();
  for (const decision of [
    "we'll use TypeScript with strict null checks everywhere",
    "let's go with Postgres for this service",
    "I've decided to migrate to uv for Python projects",
    "决定用 SQLite 做单文件存储",
    "我们决定改用 Hono 框架",
  ]) {
    const d = p.decide(ctx(decision));
    assert.equal(d.kind, 'hard_keep', JSON.stringify(decision));
    assert.equal(d.matchedRule, 'keep.explicit-decision');
  }
});

test('keep: commit sha references are hard_keep', () => {
  const p = policy();
  const d = p.decide(ctx('commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b fixed the regression we saw yesterday'));
  assert.equal(d.kind, 'hard_keep');
  assert.equal(d.matchedRule, 'keep.commit-hash');
});

test('keep: commit range a..b forms are hard_keep', () => {
  const p = policy();
  const d = p.decide(ctx('see diff abc1234...def5678 for the routing change in this PR'));
  assert.equal(d.kind, 'hard_keep');
  assert.equal(d.matchedRule, 'keep.commit-hash');
});

test('keep: explicit file paths are hard_keep', () => {
  const p = policy();
  const d = p.decide(ctx('updated the handler in ./src/api/users.ts to validate pagination params'));
  assert.equal(d.kind, 'hard_keep');
  assert.equal(d.matchedRule, 'keep.file-path');
});

test('keep: preference markers are hard_keep', () => {
  const p = policy();
  for (const pref of [
    'I prefer pnpm over npm for monorepo workflows',
    'my default Node version is 22 always',
    'I always run tests before pushing',
    '我偏好使用 Prettier 进行格式化',
    '我习惯用 zod 而不是 joi',
  ]) {
    const d = p.decide(ctx(pref));
    assert.equal(d.kind, 'hard_keep', JSON.stringify(pref));
    assert.equal(d.matchedRule, 'keep.preference-marker');
  }
});

test('keep: verified fix markers are hard_keep', () => {
  const p = policy();
  for (const fix of [
    "fixed by wrapping the async handler in try/catch",
    "workaround is to set NODE_OPTIONS=--max-old-space-size=4096",
    "resolved by upgrading to uuid v11.0.0",
    "用 pnpm prune 修复了依赖膨胀问题",
    "可行的方案是把缓存层放到 Redis",
  ]) {
    const d = p.decide(ctx(fix));
    assert.equal(d.kind, 'hard_keep', JSON.stringify(fix));
    assert.equal(d.matchedRule, 'keep.verified-fix');
  }
});

// ---------- Boundaries ----------

test('length: text below minLength is soft_skip', () => {
  const p = policy({ minLength: 20 });
  assert.equal(p.decide(ctx('short')).kind, 'soft_skip');
  assert.equal(p.decide(ctx('short')).matchedRule, 'system.too-short');
});

test('length: text above maxLength is hard_block', () => {
  const p = policy({ maxLength: 32 });
  const longText = 'a'.repeat(40);
  const d = p.decide(ctx(longText));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'system.too-long');
});

test('length: trim then length is applied', () => {
  const p = policy({ minLength: 10 });
  // trimmed length is well below minLength; whitespace-padding shouldn't fool the policy
  assert.equal(p.decide(ctx('         \n\t ok \n     ')).kind, 'soft_skip');
});

test('empty: trim-to-empty content is soft_skip', () => {
  const p = policy();
  const d = p.decide(ctx('   \n   '));
  assert.equal(d.kind, 'soft_skip');
  assert.equal(d.matchedRule, 'system.empty');
});

// ---------- Precedence ----------

test('precedence: keep wins over ephemeral when both match', () => {
  // "决定用 X" matches keep.explicit-decision; we want keep to win.
  const p = policy();
  const d = p.decide(ctx("We've decided to use SQLite for the embedded store"));
  assert.equal(d.kind, 'hard_keep');
});

test('precedence: sensitive always wins over keep signals', () => {
  const p = policy();
  const msg = "we've decided to use this token: ghp_abcdefghijklmnopqrstuvwxyz012345";
  const d = p.decide(ctx(msg));
  assert.equal(d.kind, 'hard_block');
});

test('default: no rule matched returns uncertain (ready for LLM review)', () => {
  const p = policy();
  const d = p.decide(ctx(
    'Need to spin up two more containers for the staging environment to mirror production load',
  ));
  assert.equal(d.kind, 'uncertain');
  assert.equal(d.matchedRule, 'system.default');
});

// ---------- User-supplied patterns ----------

test('user-supplied sensitive pattern wins over keep signals', () => {
  const p = policy({ sensitivePatterns: ['\\/my-hidden\\/secret-token\\/'] });
  const d = p.decide(ctx('we decided to switch to /my-hidden/secret-token/pathway instead'));
  assert.equal(d.kind, 'hard_block');
  assert.equal(d.matchedRule, 'user.sensitive');
});

test('user-supplied ephemeral pattern works', () => {
  const p = policy({ ephemeralPatterns: ['^\\[trash\\]'] });
  const d = p.decide(ctx('[trash] ignore this rambling about nothing specific'));
  assert.equal(d.kind, 'soft_skip');
  assert.equal(d.matchedRule, 'user.ephemeral');
});

test('user-supplied keep pattern works', () => {
  const p = policy({ keepPatterns: ['\\bonly use Hono for new services\\b'] });
  const d = p.decide(ctx('From now on we only use Hono for new services in this monorepo'));
  assert.equal(d.kind, 'hard_keep');
  assert.equal(d.matchedRule, 'user.keep');
});

test('user-supplied invalid regex is silently dropped (no crash)', () => {
  // a lone backslash is not a valid regex
  const p = policy({ sensitivePatterns: ['\\'] });
  const d = p.decide(ctx('Just a regular message that should fall through to uncertain'));
  assert.equal(d.kind, 'uncertain');
});

// ---------- Diagnostics ----------

test('rule snapshot includes built-in and user rules', () => {
  const p = policy({
    sensitivePatterns: ['foo'],
    ephemeralPatterns: ['bar'],
    keepPatterns: ['baz'],
  });
  const rules = p.rules();
  assert.ok(rules.length > 10, 'should expose a non-trivial rule set');
  assert.ok(rules.some((r) => r.id === 'sensitive.bearer'), 'built-in sensitive.bearer should appear');
  assert.ok(rules.some((r) => r.id === 'keep.explicit-decision'), 'built-in keep.explicit-decision should appear');
  assert.ok(rules.some((r) => r.id === 'ephemeral.pure-greeting'), 'built-in ephemeral.pure-greeting should appear');
  assert.ok(rules.some((r) => r.id === 'user.sensitive.0'), 'user sensitive should appear');
  assert.ok(rules.some((r) => r.id === 'user.keep.0'), 'user keep should appear');
  assert.ok(rules.some((r) => r.id === 'user.ephemeral.0'), 'user ephemeral should appear');
});

// ---------- Helpers ----------

test('isAcceptingDecision accepts hard_keep and uncertain only', () => {
  assert.equal(isAcceptingDecision({ kind: 'hard_keep', reason: '', matchedRule: '' }), true);
  assert.equal(isAcceptingDecision({ kind: 'uncertain', reason: '', matchedRule: '' }), true);
  assert.equal(isAcceptingDecision({ kind: 'soft_skip', reason: '', matchedRule: '' }), false);
  assert.equal(isAcceptingDecision({ kind: 'hard_block', reason: '', matchedRule: '' }), false);
});

test('isHardRejectingDecision accepts hard_block and soft_skip', () => {
  assert.equal(isHardRejectingDecision({ kind: 'hard_block', reason: '', matchedRule: '' }), true);
  assert.equal(isHardRejectingDecision({ kind: 'soft_skip', reason: '', matchedRule: '' }), true);
  assert.equal(isHardRejectingDecision({ kind: 'hard_keep', reason: '', matchedRule: '' }), false);
  assert.equal(isHardRejectingDecision({ kind: 'uncertain', reason: '', matchedRule: '' }), false);
});

test('AdmissionRejectedError carries the original decision', () => {
  const decision = { kind: 'hard_block' as const, reason: 'token', matchedRule: 'sensitive.bearer' };
  const err = new AdmissionRejectedError(decision);
  assert.equal(err.name, 'AdmissionRejectedError');
  assert.equal(err.decision.kind, 'hard_block');
  assert.match(err.message, /admission rejected/);
});
