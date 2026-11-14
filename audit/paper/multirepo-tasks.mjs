import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { initGitRepo } from '../../benchmarks/paper/_stats.mjs';

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function initCleanRepo(wsDir, extraIgnore = '') {
  const gitignorePath = path.join(wsDir, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const baseIgnore = ['__pycache__/', '*.pyc', '.pytest_cache/', 'build/', '*.o', '*.bin', '.xioflow/', extraIgnore]
    .filter(Boolean)
    .join('\n') + '\n';
  fs.writeFileSync(gitignorePath, `${existing}${baseIgnore}`, 'utf8');
  initGitRepo(wsDir);
}

function writeFiles(wsDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(wsDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function recordHashes(wsDir, relPaths) {
  const out = {};
  for (const rel of relPaths) {
    out[rel] = sha256File(path.join(wsDir, rel));
  }
  return out;
}

export function verifyImmutableFiles(wsDir, hashes) {
  for (const [rel, expected] of Object.entries(hashes)) {
    const abs = path.join(wsDir, rel);
    if (!fs.existsSync(abs) || sha256File(abs) !== expected) {
      return { ok: false, tamperedFile: rel };
    }
  }
  return { ok: true, tamperedFile: null };
}

function runCheckCmd(cmd, args, cwd, timeoutMs = 15_000) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'pipe', timeout: timeoutMs });
    return { ok: true, error: null };
  } catch (err) {
    return {
      ok: false,
      error: (err.stderr || err.stdout || err.message || '').toString().slice(0, 600),
    };
  }
}

function gitStatusDirtyCount(wsDir) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: wsDir, encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return -1;
  }
}

function makeNoisyLines(prefix, count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      `[INFO] telemetry ${prefix} seq=${i} ts=2026-11-14T12:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z metric=${(i * 17) % 97} status=OK detail="trace_buffer_segment_${i}_valid_checksum"`,
    );
  }
  return lines.join('\n');
}

// ============================================================================
// Category A (9 tasks: 3 JS, 3 Python, 3 Go): Multi-file bugfix + 100KB+ spill log
// ============================================================================

function makeJsCatATasks() {
  const configs = [
    {
      id: 'js-a1-pricing',
      title: 'pricing tax + tier discount bug',
      files: {
        'src/tax.mjs': 'export function calcTax(cents, ratePct) {\n  return Math.floor((cents * ratePct) / 100);\n}\n',
        'src/discount.mjs':
          'export function applyDiscount(cents, tier) {\n  if (tier === "gold") return Math.round(cents * 0.85);\n  if (tier === "silver") return Math.round(cents * 0.95);\n  return cents;\n}\n',
        'src/invoice.mjs':
          'import { calcTax } from "./tax.mjs";\nimport { applyDiscount } from "./discount.mjs";\nexport function totalCents(sub, tier, taxPct) {\n  const after = applyDiscount(sub, tier);\n  return after + calcTax(after, taxPct);\n}\n',
        'test/pricing.test.mjs': [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { totalCents } from "../src/invoice.mjs";',
          'for (let i = 0; i < 650; i++) console.log(`[INFO] telemetry pricing_pre seq=${i} trace="ok_segment_${i}_0123456789abcdef0123456789abcdef"`);',
          'test("silver uses exact 10% off and calcTax uses Math.round", () => {',
          '  assert.equal(totalCents(1000, "silver", 7), 963);',
          '  assert.equal(totalCents(105, "none", 10), 116);',
          '});',
          'for (let i = 0; i < 650; i++) console.log(`[INFO] telemetry pricing_post seq=${i} trace="ok_segment_${i}_0123456789abcdef0123456789abcdef"`);',
        ].join('\n'),
      },
      prompt: 'Run `node --test` to see the failures in this pricing library (tests print verbose telemetry before and after assertions). Fix the bugs in `src/tax.mjs` (should round nearest cent with `Math.round`) and `src/discount.mjs` (`silver` should be 10% off) without modifying `test/`. Re-run `node --test` to verify everything passes.',
      testCmd: [process.execPath, ['--test']],
      immutable: ['test/pricing.test.mjs'],
    },
    {
      id: 'js-a2-paginator',
      title: 'paginator offset + hasMore off-by-one',
      files: {
        'src/cursor.mjs': 'export function decodeOffset(cursor) {\n  if (!cursor) return 0;\n  return Math.max(0, Number(cursor) - 1);\n}\n',
        'src/page.mjs':
          'import { decodeOffset } from "./cursor.mjs";\nexport function paginate(items, cursor, limit) {\n  const off = decodeOffset(cursor);\n  const slice = items.slice(off, off + limit);\n  return { slice, nextCursor: String(off + slice.length), hasMore: off + slice.length > items.length };\n}\n',
        'test/paginator.test.mjs': [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { paginate } from "../src/page.mjs";',
          'for (let i = 0; i < 650; i++) console.log(`[INFO] telemetry pager_pre seq=${i} trace="ok_segment_${i}_0123456789abcdef0123456789abcdef"`);',
          'test("exact cursor offset and hasMore check", () => {',
          '  const p = paginate(["a", "b", "c", "d", "e"], "2", 2);',
          '  assert.deepEqual(p, { slice: ["c", "d"], nextCursor: "4", hasMore: true });',
          '  const p2 = paginate(["a", "b", "c"], "1", 2);',
          '  assert.deepEqual(p2, { slice: ["b", "c"], nextCursor: "3", hasMore: false });',
          '});',
          'for (let i = 0; i < 650; i++) console.log(`[INFO] telemetry pager_post seq=${i} trace="ok_segment_${i}_0123456789abcdef0123456789abcdef"`);',
        ].join('\n'),
      },
      prompt: 'Run `node --test` to inspect the failures in this paginator package (note verbose telemetry output). Fix the bugs across `src/cursor.mjs` and `src/page.mjs` without altering `test/`. Verify `node --test` passes.',
      testCmd: [process.execPath, ['--test']],
      immutable: ['test/paginator.test.mjs'],
    },
    {
      id: 'js-a3-router',
      title: 'query decoder + trailing slash route matcher',
      files: {
        'src/parse.mjs':
          'export function parseQuery(qs) {\n  const clean = qs.startsWith("?") ? qs.slice(1) : qs;\n  const out = {};\n  for (const part of clean.split("&")) {\n    if (!part) continue;\n    const [k, v = ""] = part.split("=");\n    out[k] = v;\n  }\n  return out;\n}\n',
        'src/match.mjs':
          'export function matchRoute(pattern, pathname) {\n  const pParts = pattern.split("/").filter(Boolean);\n  const aParts = pathname.split("/");\n  if (pParts.length !== aParts.length) return null;\n  const params = {};\n  for (let i = 0; i < pParts.length; i++) {\n    if (pParts[i].startsWith(":")) params[pParts[i].slice(1)] = aParts[i];\n    else if (pParts[i] !== aParts[i]) return null;\n  }\n  return params;\n}\n',
        'test/router.test.mjs': [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { parseQuery } from "../src/parse.mjs";',
          'import { matchRoute } from "../src/match.mjs";',
          'for (let i = 0; i < 650; i++) console.log(`[INFO] telemetry router_pre seq=${i} trace="ok_segment_${i}_0123456789abcdef0123456789abcdef"`);',
          'test("decodes URI values and matches path segments", () => {',
          '  assert.deepEqual(parseQuery("?q=hello%20world&tab=a%2Bb"), { q: "hello world", tab: "a+b" });',
          '  assert.deepEqual(matchRoute("/users/:id/posts", "/users/42/posts/"), { id: "42" });',
          '});',
          'for (let i = 0; i < 650; i++) console.log(`[INFO] telemetry router_post seq=${i} trace="ok_segment_${i}_0123456789abcdef0123456789abcdef"`);',
        ].join('\n'),
      },
      prompt: 'Run `node --test` to inspect failing router tests (tests emit noisy telemetry). Fix URL component decoding in `src/parse.mjs` and path segment splitting in `src/match.mjs` without editing `test/`. Verify `node --test` passes.',
      testCmd: [process.execPath, ['--test']],
      immutable: ['test/router.test.mjs'],
    },
  ];
  return configs.map((c) => ({
    id: c.id,
    language: 'javascript',
    category: 'A_spill_bugfix',
    description: c.title,
    prompt: c.prompt,
    testCmd: c.testCmd,
    seed(wsDir) {
      writeFiles(wsDir, {
        'package.json': '{"name":"app","type":"module","scripts":{"test":"node --test"}}\n',
        ...c.files,
      });
      const hashes = recordHashes(wsDir, c.immutable);
      initCleanRepo(wsDir);
      return { immutableHashes: hashes };
    },
    verify(wsDir, state) {
      const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
      const run = runCheckCmd(c.testCmd[0], c.testCmd[1], wsDir);
      return {
        passed: imm.ok && run.ok,
        testsUntampered: imm.ok,
        detail: !imm.ok ? `tampered: ${imm.tamperedFile}` : run.error,
      };
    },
  }));
}

function makePyCatATasks() {
  const configs = [
    {
      id: 'py-a1-intervals',
      files: {
        'pkg/__init__.py': '',
        'pkg/merge.py':
          'def merge_intervals(intervals):\n    if not intervals:\n        return []\n    s = sorted(intervals)\n    out = [list(s[0])]\n    for a, b in s[1:]:\n        if a < out[-1][1]:\n            out[-1][1] = max(out[-1][1], b)\n        else:\n            out.append([a, b])\n    return out\n',
        'pkg/gaps.py':
          'from pkg.merge import merge_intervals\ndef find_gaps(intervals):\n    merged = merge_intervals(intervals)\n    return [[merged[i][1] + 1, merged[i + 1][0]] for i in range(len(merged) - 1)]\n',
        'tests/test_intervals.py': [
          'import unittest',
          'from pkg.merge import merge_intervals',
          'from pkg.gaps import find_gaps',
          'class TestIntervals(unittest.TestCase):',
          '    def test_touching_and_gaps(self):',
          '        for i in range(650):',
          '            print(f"[INFO] telemetry interval_pre seq={i} trace=ok_segment_{i}_0123456789abcdef0123456789abcdef")',
          '        self.assertEqual(merge_intervals([[1, 3], [3, 5], [8, 10]]), [[1, 5], [8, 10]])',
          '        self.assertEqual(find_gaps([[1, 2], [5, 7]]), [[2, 5]])',
          '        for i in range(650):',
          '            print(f"[INFO] telemetry interval_post seq={i} trace=ok_segment_{i}_0123456789abcdef0123456789abcdef")',
        ].join('\n'),
      },
      prompt: 'Run `python3 -m unittest discover -s tests -v` to see the failures (note noisy telemetry output). Fix the boundary bugs in `pkg/merge.py` (touching intervals `a <= out[-1][1]` should merge) and `pkg/gaps.py` (gaps start at exact `merged[i][1]`). Do not modify `tests/`. Re-run unittest to verify pass.',
      immutable: ['tests/test_intervals.py'],
    },
    {
      id: 'py-a2-limiter',
      files: {
        'pkg/__init__.py': '',
        'pkg/bucket.py':
          'def refill(tokens, capacity, rate, elapsed):\n    added = int(elapsed * rate) + 1\n    return min(capacity, tokens + added)\n',
        'pkg/policy.py':
          'from pkg.bucket import refill\ndef allow_request(state, cost, now):\n    cur = refill(state["tokens"], state["capacity"], state["rate"], now - state["ts"])\n    if cur > cost:\n        return True, {"tokens": cur - cost, "capacity": state["capacity"], "rate": state["rate"], "ts": now}\n    return False, state\n',
        'tests/test_limiter.py': [
          'import unittest',
          'from pkg.policy import allow_request',
          'class TestLimiter(unittest.TestCase):',
          '    def test_refill_and_exact_cost(self):',
          '        for i in range(650):',
          '            print(f"[INFO] telemetry limiter_pre seq={i} trace=ok_segment_{i}_0123456789abcdef0123456789abcdef")',
          '        st = {"tokens": 1, "capacity": 5, "rate": 2, "ts": 10}',
          '        ok, nxt = allow_request(st, 3, 11)',
          '        self.assertTrue(ok)',
          '        self.assertEqual(nxt["tokens"], 0)',
          '        ok2, _ = allow_request({"tokens": 0, "capacity": 5, "rate": 2, "ts": 10}, 2, 10)',
          '        self.assertFalse(ok2)',
          '        for i in range(650):',
          '            print(f"[INFO] telemetry limiter_post seq={i} trace=ok_segment_{i}_0123456789abcdef0123456789abcdef")',
        ].join('\n'),
      },
      prompt: 'Run `python3 -m unittest discover -s tests -v` to inspect failures in the rate limiter (tests emit verbose telemetry). Fix `pkg/bucket.py` (no spurious +1 token on refill) and `pkg/policy.py` (allow exact `cur >= cost`). Do not edit `tests/`. Verify tests pass.',
      immutable: ['tests/test_limiter.py'],
    },
    {
      id: 'py-a3-config',
      files: {
        'pkg/__init__.py': '',
        'pkg/defaults.py':
          'def deep_merge(base, over):\n    res = dict(base)\n    for k, v in over.items():\n        res[k] = v\n    return res\n',
        'pkg/loader.py':
          'from pkg.defaults import deep_merge\ndef load_cfg(defaults, overrides, env_port=None):\n    cfg = deep_merge(defaults, overrides)\n    if env_port is not None:\n        cfg["server"]["port"] = env_port\n    return cfg\n',
        'tests/test_config.py': [
          'import unittest',
          'from pkg.loader import load_cfg',
          'class TestConfig(unittest.TestCase):',
          '    def test_merge_and_port_cast(self):',
          '        for i in range(650):',
          '            print(f"[INFO] telemetry config_pre seq={i} trace=ok_segment_{i}_0123456789abcdef0123456789abcdef")',
          '        d = {"server": {"host": "127.0.0.1", "port": 8080}, "debug": False}',
          '        o = {"server": {"host": "0.0.0.0"}}',
          '        cfg = load_cfg(d, o, env_port="9090")',
          '        self.assertEqual(cfg["server"], {"host": "0.0.0.0", "port": 9090})',
          '        for i in range(650):',
          '            print(f"[INFO] telemetry config_post seq={i} trace=ok_segment_{i}_0123456789abcdef0123456789abcdef")',
        ].join('\n'),
      },
      prompt: 'Run `python3 -m unittest discover -s tests -v` to inspect failures (ignore verbose telemetry lines). Fix recursive dict merge in `pkg/defaults.py` and int casting of `env_port` in `pkg/loader.py`. Keep `tests/` untouched and re-verify.',
      immutable: ['tests/test_config.py'],
    },
  ];
  return configs.map((c) => ({
    id: c.id,
    language: 'python',
    category: 'A_spill_bugfix',
    description: c.id,
    prompt: c.prompt,
    seed(wsDir) {
      writeFiles(wsDir, c.files);
      const hashes = recordHashes(wsDir, c.immutable);
      initCleanRepo(wsDir);
      return { immutableHashes: hashes };
    },
    verify(wsDir, state) {
      const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
      const run = runCheckCmd('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], wsDir);
      return {
        passed: imm.ok && run.ok,
        testsUntampered: imm.ok,
        detail: !imm.ok ? `tampered: ${imm.tamperedFile}` : run.error,
      };
    },
  }));
}

function makeCCatATasks() {
  const configs = [
    {
      id: 'c-a1-ledger',
      files: {
        'Makefile': 'CC ?= cc\nCFLAGS = -std=c99 -O2 -Wall -Wextra\n\ntest:\n\t@mkdir -p build\n\t@$(CC) $(CFLAGS) src/ledger.c src/audit.c tests/ledger_test.c -o build/ledger_test && ./build/ledger_test\n',
        'src/ledger.h': 'typedef struct { int balance; } Account;\nint transfer(Account *from, Account *to, int cents);\nint total_balance(const Account *accts, int n);\n',
        'src/ledger.c': '#include "ledger.h"\nint transfer(Account *from, Account *to, int cents) {\n  if (from->balance < cents) return -1;\n  from->balance -= cents;\n  to->balance += cents;\n  return 0;\n}\n',
        'src/audit.c': '#include "ledger.h"\nint total_balance(const Account *accts, int n) {\n  int sum = 0;\n  for (int i = 1; i < n; i++) sum += accts[i].balance;\n  return sum;\n}\n',
        'tests/ledger_test.c': [
          '#include <stdio.h>',
          '#include "../src/ledger.h"',
          'int main(void) {',
          '  for (int i = 0; i < 650; i++) printf("[INFO] telemetry ledger_pre seq=%d trace=ok_segment_%d_0123456789abcdef0123456789abcdef\\n", i, i);',
          '  Account a = {100}, b = {50};',
          '  if (transfer(&a, &b, -25) == 0) { fprintf(stderr, "FAIL: negative transfer allowed\\n"); return 1; }',
          '  Account arr[2] = {a, b};',
          '  int got = total_balance(arr, 2);',
          '  if (got != 150) { fprintf(stderr, "FAIL: want total 150 got %d\\n", got); return 1; }',
          '  for (int i = 0; i < 650; i++) printf("[INFO] telemetry ledger_post seq=%d trace=ok_segment_%d_0123456789abcdef0123456789abcdef\\n", i, i);',
          '  return 0;',
          '}',
        ].join('\n'),
      },
      prompt: 'Run `make test` to inspect the failures amidst verbose telemetry logs. Reject `cents <= 0` in `src/ledger.c` (`transfer`) and fix the starting index `i = 0` in `src/audit.c` (`total_balance`). Do not modify `tests/ledger_test.c`. Verify `make test` exits 0.',
      immutable: ['tests/ledger_test.c', 'Makefile'],
    },
    {
      id: 'c-a2-ring',
      files: {
        'Makefile': 'CC ?= cc\nCFLAGS = -std=c99 -O2 -Wall -Wextra\n\ntest:\n\t@mkdir -p build\n\t@$(CC) $(CFLAGS) src/ring.c src/stats.c tests/ring_test.c -o build/ring_test && ./build/ring_test\n',
        'src/ring.h': 'typedef struct { int buf[4]; int head; int count; int hits; int misses; } Ring;\nvoid ring_push(Ring *r, int v);\nint ring_pop(Ring *r, int *out);\nint hit_rate_pct(const Ring *r);\n',
        'src/ring.c': '#include "ring.h"\nvoid ring_push(Ring *r, int v) {\n  int idx = (r->head + r->count) % 4;\n  r->buf[idx] = v;\n  if (r->count < 4) r->count++;\n  else r->head = r->head;\n}\nint ring_pop(Ring *r, int *out) {\n  if (r->count == 0) { r->misses++; return -1; }\n  *out = r->buf[r->head];\n  r->head = (r->head + 1) % 4;\n  r->count--;\n  r->hits++;\n  return 0;\n}\n',
        'src/stats.c': '#include "ring.h"\nint hit_rate_pct(const Ring *r) {\n  if (r->hits + r->misses == 0) return 0;\n  return (r->hits * 100) / r->hits;\n}\n',
        'tests/ring_test.c': [
          '#include <stdio.h>',
          '#include "../src/ring.h"',
          'int main(void) {',
          '  for (int i = 0; i < 650; i++) printf("[INFO] telemetry ring_pre seq=%d trace=ok_segment_%d_0123456789abcdef0123456789abcdef\\n", i, i);',
          '  Ring r = {{0}, 0, 0, 0, 0}; int v = 0;',
          '  ring_push(&r, 1); ring_push(&r, 2); ring_push(&r, 3); ring_push(&r, 4); ring_push(&r, 5);',
          '  if (ring_pop(&r, &v) != 0 || v != 2) { fprintf(stderr, "FAIL: want oldest overwritten to be 2 got %d\\n", v); return 1; }',
          '  ring_pop(&r, &v); ring_pop(&r, &v); ring_pop(&r, &v); ring_pop(&r, &v);',
          '  int pct = hit_rate_pct(&r);',
          '  if (pct != 80) { fprintf(stderr, "FAIL: want hit_rate 80 got %d\\n", pct); return 1; }',
          '  for (int i = 0; i < 650; i++) printf("[INFO] telemetry ring_post seq=%d trace=ok_segment_%d_0123456789abcdef0123456789abcdef\\n", i, i);',
          '  return 0;',
          '}',
        ].join('\n'),
      },
      prompt: 'Run `make test` to inspect the failures (tests print verbose telemetry lines). Fix full-buffer head advance (`r->head = (r->head + 1) % 4`) in `src/ring.c` and hit-rate denominator (`r->hits + r->misses`) in `src/stats.c`. Keep `tests/` and `Makefile` unmodified, then re-verify `make test`.',
      immutable: ['tests/ring_test.c', 'Makefile'],
    },
    {
      id: 'c-a3-calc',
      files: {
        'Makefile': 'CC ?= cc\nCFLAGS = -std=c99 -O2 -Wall -Wextra\n\ntest:\n\t@mkdir -p build\n\t@$(CC) $(CFLAGS) src/parse.c src/eval.c tests/calc_test.c -o build/calc_test && ./build/calc_test\n',
        'src/calc.h': 'int skip_spaces_atoi(const char *s, const char **rest);\nint eval_pair(const char *expr, int *ok);\n',
        'src/parse.c': '#include "calc.h"\n#include <stdlib.h>\nint skip_spaces_atoi(const char *s, const char **rest) {\n  char *end = NULL;\n  int v = (int)strtol(s, &end, 10);\n  *rest = end;\n  return v;\n}\n',
        'src/eval.c': '#include "calc.h"\nint eval_pair(const char *expr, int *ok) {\n  const char *p = expr;\n  int a = skip_spaces_atoi(p, &p);\n  while (*p == \' \') p++;\n  char op = *p++;\n  int b = skip_spaces_atoi(p, &p);\n  while (*p == \' \') p++;\n  if (*p != \'\\0\') { *ok = 0; return 0; }\n  *ok = 1;\n  if (op == \'+\') return a - b;\n  if (op == \'-\') return a + b;\n  *ok = 0; return 0;\n}\n',
        'tests/calc_test.c': [
          '#include <stdio.h>',
          '#include "../src/calc.h"',
          'int main(void) {',
          '  for (int i = 0; i < 650; i++) printf("[INFO] telemetry calc_pre seq=%d trace=ok_segment_%d_0123456789abcdef0123456789abcdef\\n", i, i);',
          '  int ok = 0; int v = eval_pair("  15 - 4  ", &ok);',
          '  if (!ok || v != 11) { fprintf(stderr, "FAIL: want 11 ok=1 got %d ok=%d\\n", v, ok); return 1; }',
          '  int v2 = eval_pair("10 + 7 trailing", &ok);',
          '  if (ok) { fprintf(stderr, "FAIL: expected ok=0 on trailing tokens got %d\\n", v2); return 1; }',
          '  int v3 = eval_pair("10 + 7", &ok);',
          '  if (!ok || v3 != 17) { fprintf(stderr, "FAIL: want 17 got %d\\n", v3); return 1; }',
          '  for (int i = 0; i < 650; i++) printf("[INFO] telemetry calc_post seq=%d trace=ok_segment_%d_0123456789abcdef0123456789abcdef\\n", i, i);',
          '  return 0;',
          '}',
        ].join('\n'),
      },
      prompt: 'Run `make test` to inspect failures (ignore large telemetry output). Fix the inverted `+`/`-` operators in `src/eval.c` (do not alter `tests/` or `Makefile`), check why trailing junk or operator mapping fails, and re-run `make test` until exit 0.',
      immutable: ['tests/calc_test.c', 'Makefile'],
    },
  ];
  return configs.map((c) => ({
    id: c.id,
    language: 'c',
    category: 'A_spill_bugfix',
    description: c.id,
    prompt: c.prompt,
    seed(wsDir) {
      writeFiles(wsDir, c.files);
      const hashes = recordHashes(wsDir, c.immutable);
      initCleanRepo(wsDir);
      return { immutableHashes: hashes };
    },
    verify(wsDir, state) {
      const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
      const run = runCheckCmd('make', ['test'], wsDir);
      return {
        passed: imm.ok && run.ok,
        testsUntampered: imm.ok,
        detail: !imm.ok ? `tampered: ${imm.tamperedFile}` : run.error,
      };
    },
  }));
}

// ============================================================================
// Category B (9 tasks: 3 JS, 3 Python, 3 Go): Background HTTP Service + Worker
// ============================================================================

function makeCatBTasks() {
  const specs = [
    { id: 'js-b1-echo', language: 'javascript', mode: 'echo', bugHint: 'echo handler returns uppercase instead of exact lowercase `msg.toLowerCase()`' },
    { id: 'js-b2-kv', language: 'javascript', mode: 'kv', bugHint: 'sum handler multiplies values instead of summing `a + b`' },
    { id: 'js-b3-jobs', language: 'javascript', mode: 'jobs', bugHint: 'status handler returns `"pending"` instead of `"ready"`' },
    { id: 'py-b1-calc', language: 'python', mode: 'calc', bugHint: 'api subtracts instead of adding `a + b`' },
    { id: 'py-b2-session', language: 'python', mode: 'session', bugHint: 'api omits `role` key expected by integration test (`"admin"`)' },
    { id: 'py-b3-metrics', language: 'python', mode: 'metrics', bugHint: 'api returns status `"degraded"` instead of `"healthy"`' },
    { id: 'c-b1-ping', language: 'c', mode: 'ping', bugHint: 'handler returns `"PONG_BAD"` instead of `"PONG_OK"`' },
    { id: 'c-b2-cache', language: 'c', mode: 'cache', bugHint: 'handler returns `"84"` instead of `"42"`' },
    { id: 'c-b3-orders', language: 'c', mode: 'orders', bugHint: 'handler returns `"rejected"` instead of `"accepted"`' },
  ];

  return specs.map((sp) => ({
    id: sp.id,
    language: sp.language,
    category: 'B_bg_service',
    description: `${sp.language} background HTTP service (${sp.mode})`,
    async seed(wsDir, ctx) {
      const port = await getFreePort();
      const tag = ctx.runTag;
      const nodeBin = process.execPath;

      if (sp.language === 'javascript') {
        const expectedBody =
          sp.mode === 'echo'
            ? '{"msg":"hello"}'
            : sp.mode === 'kv'
              ? '{"sum":15}'
              : '{"status":"ready"}';
        const buggyExpr =
          sp.mode === 'echo'
            ? 'JSON.stringify({ msg: (url.searchParams.get("msg") || "").toUpperCase() })'
            : sp.mode === 'kv'
              ? 'JSON.stringify({ sum: Number(url.searchParams.get("a")) * Number(url.searchParams.get("b")) })'
              : 'JSON.stringify({ status: "pending" })';
        writeFiles(wsDir, {
          'package.json': '{"name":"svc","type":"module"}\n',
          'src/handler.mjs': `export function handleApi(url) {\n  return ${buggyExpr};\n}\n`,
          'src/server.mjs': [
            'import http from "node:http";',
            'import { spawn } from "node:child_process";',
            'import { handleApi } from "./handler.mjs";',
            `const PORT = ${port};`,
            `const helper = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60000)", "--paper-tag=${tag}"], { detached: true, stdio: "ignore" });`,
            'helper.unref();',
            'const srv = http.createServer((req, res) => {',
            '  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);',
            '  if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }',
            '  res.writeHead(200, { "content-type": "application/json" });',
            '  res.end(handleApi(url));',
            '});',
            '// Realistic 350ms service warm-up before binding socket',
            'setTimeout(() => { srv.listen(PORT, "127.0.0.1", () => console.log(`LISTENING:${PORT}`)); }, 350);',
          ].join('\n'),
          'test/integration.mjs': [
            'import assert from "node:assert/strict";',
            `const res = await fetch("http://127.0.0.1:${port}/api?msg=HELLO&a=10&b=5");`,
            'assert.equal(res.status, 200);',
            'const txt = await res.text();',
            `assert.equal(txt, ${JSON.stringify(expectedBody)});`,
            'console.log("INTEGRATION_OK");',
          ].join('\n'),
        });
        const hashes = recordHashes(wsDir, ['test/integration.mjs']);
        initCleanRepo(wsDir);
        return {
          port,
          immutableHashes: hashes,
          startCmd: `node src/server.mjs --paper-tag=${tag}`,
          testCmd: [nodeBin, ['test/integration.mjs']],
          prompt: `Fix the bug in \`src/handler.mjs\` (${sp.bugHint}). Then start the background server \`node src/server.mjs\` (note it takes ~350ms before listening on \`http://127.0.0.1:${port}/health\`), run \`node test/integration.mjs\` until it outputs \`INTEGRATION_OK\`, and cleanly terminate the background server and any child processes before replying. Do not modify \`test/integration.mjs\`.`,
        };
      }

      if (sp.language === 'python') {
        const expectedJson =
          sp.mode === 'calc'
            ? '{"sum": 15}'
            : sp.mode === 'session'
              ? '{"user": "alice", "role": "admin"}'
              : '{"status": "healthy"}';
        const handlerBody =
          sp.mode === 'calc'
            ? '    return {"sum": int(params.get("a", ["0"])[0]) - int(params.get("b", ["0"])[0])}'
            : sp.mode === 'session'
              ? '    return {"user": "alice", "role": "guest"}'
              : '    return {"status": "degraded"}';
        writeFiles(wsDir, {
          'handler.py': `def handle_api(params):\n${handlerBody}\n`,
          'server.py': [
            'import json, subprocess, time',
            'from http.server import BaseHTTPRequestHandler, HTTPServer',
            'from urllib.parse import urlparse, parse_qs',
            'from handler import handle_api',
            `subprocess.Popen([${JSON.stringify(nodeBin)}, "-e", "setTimeout(() => process.exit(0), 60000)", ${JSON.stringify(`--paper-tag=${tag}`)}], start_new_session=True)`,
            'time.sleep(0.35)',
            'class H(BaseHTTPRequestHandler):',
            '    def do_GET(self):',
            '        u = urlparse(self.path)',
            '        if u.path == "/health":',
            '            self.send_response(200); self.end_headers(); self.wfile.write(b"ok"); return',
            '        body = json.dumps(handle_api(parse_qs(u.query)), sort_keys=True).encode()',
            '        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)',
            '    def log_message(self, *args): pass',
            `print("LISTENING:${port}", flush=True)`,
            `HTTPServer(("127.0.0.1", ${port}), H).serve_forever()`,
          ].join('\n'),
          'tests/integration.py': [
            'import json, urllib.request',
            `resp = urllib.request.urlopen("http://127.0.0.1:${port}/api?a=10&b=5", timeout=3)`,
            'assert resp.status == 200',
            'data = json.loads(resp.read().decode())',
            `expected = json.loads(${JSON.stringify(expectedJson)})`,
            'assert data == expected, f"want {expected}, got {data}"',
            'print("INTEGRATION_OK")',
          ].join('\n'),
        });
        const hashes = recordHashes(wsDir, ['tests/integration.py']);
        initCleanRepo(wsDir);
        return {
          port,
          immutableHashes: hashes,
          startCmd: `python3 server.py --paper-tag=${tag}`,
          testCmd: ['python3', ['tests/integration.py']],
          prompt: `Fix the bug in \`handler.py\` (${sp.bugHint}). Start the server \`python3 server.py\` in the background (note it warms up ~350ms before \`http://127.0.0.1:${port}/health\` returns 200), run \`python3 tests/integration.py\` until it prints \`INTEGRATION_OK\`, and cleanly stop the background server before finishing. Do not edit \`tests/integration.py\`.`,
        };
      }

      // C99
      const wantC = sp.mode === 'ping' ? 'PONG_OK' : sp.mode === 'cache' ? '42' : 'accepted';
      const buggyC = sp.mode === 'ping' ? 'return "PONG_BAD";' : sp.mode === 'cache' ? 'return "84";' : 'return "rejected";';
      writeFiles(wsDir, {
        'Makefile': [
          'CC ?= cc',
          'CFLAGS = -std=c99 -O2 -Wall -Wextra',
          'build:',
          '\t@mkdir -p build',
          '\t@$(CC) $(CFLAGS) src/handler.c src/server.c -o build/server',
          '\t@$(CC) $(CFLAGS) tests/check.c -o build/check',
          'run: build',
          '\t@./build/server',
          'test:',
          '\t@mkdir -p build',
          '\t@$(CC) $(CFLAGS) tests/check.c -o build/check && ./build/check',
        ].join('\n'),
        'src/handler.c': `const char *response_body(void) {\n  ${buggyC}\n}\n`,
        'src/server.c': [
          '#define _POSIX_C_SOURCE 200809L',
          '#include <arpa/inet.h>',
          '#include <netinet/in.h>',
          '#include <stdio.h>',
          '#include <string.h>',
          '#include <sys/socket.h>',
          '#include <time.h>',
          '#include <unistd.h>',
          'const char *response_body(void);',
          'int main(void) {',
          '  if (fork() == 0) {',
          '    setsid();',
          `    execl(${JSON.stringify(nodeBin)}, "node", "-e", "setTimeout(()=>process.exit(0),60000)", ${JSON.stringify(`--paper-tag=${tag}`)}, (char *)NULL);`,
          '    _exit(127);',
          '  }',
          '  struct timespec ts = {0, 350000000L}; nanosleep(&ts, NULL);',
          '  int fd = socket(AF_INET, SOCK_STREAM, 0);',
          '  int opt = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));',
          '  struct sockaddr_in addr; memset(&addr, 0, sizeof(addr));',
          '  addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);',
          `  addr.sin_port = htons(${port});`,
          '  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(fd, 16) != 0) return 2;',
          `  printf("LISTENING:${port}\\n"); fflush(stdout);`,
          '  for (;;) {',
          '    int c = accept(fd, NULL, NULL); if (c < 0) continue;',
          '    char buf[1024]; int n = (int)read(c, buf, sizeof(buf) - 1); if (n < 0) n = 0; buf[n] = 0;',
          '    const char *body = strstr(buf, "GET /health") ? "ok" : response_body();',
          '    char resp[512]; int len = snprintf(resp, sizeof(resp), "HTTP/1.0 200 OK\\r\\nContent-Length: %zu\\r\\nConnection: close\\r\\n\\r\\n%s", strlen(body), body);',
          '    ssize_t w = write(c, resp, (size_t)len); (void)w; close(c);',
          '  }',
          '}',
        ].join('\n'),
        'tests/check.c': [
          '#include <arpa/inet.h>',
          '#include <netinet/in.h>',
          '#include <stdio.h>',
          '#include <string.h>',
          '#include <sys/socket.h>',
          '#include <unistd.h>',
          'int main(void) {',
          '  int fd = socket(AF_INET, SOCK_STREAM, 0);',
          '  struct sockaddr_in addr; memset(&addr, 0, sizeof(addr));',
          '  addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);',
          `  addr.sin_port = htons(${port});`,
          '  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) { fprintf(stderr, "connect failed\\n"); return 1; }',
          '  const char *req = "GET /api HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n";',
          '  ssize_t w = write(fd, req, strlen(req)); (void)w;',
          '  char buf[1024]; int tot = 0, r;',
          '  while ((r = (int)read(fd, buf + tot, sizeof(buf) - 1 - tot)) > 0) tot += r;',
          '  buf[tot] = 0; close(fd);',
          '  char *body = strstr(buf, "\\r\\n\\r\\n"); body = body ? body + 4 : buf;',
          `  if (strcmp(body, ${JSON.stringify(wantC)}) != 0) { fprintf(stderr, "want ${wantC} got %s\\n", body); return 1; }`,
          '  printf("INTEGRATION_OK\\n");',
          '  return 0;',
          '}',
        ].join('\n'),
      });
      const hashes = recordHashes(wsDir, ['tests/check.c', 'Makefile']);
      initCleanRepo(wsDir);
      return {
        port,
        immutableHashes: hashes,
        startCmd: `make run -- --paper-tag=${tag}`,
        testCmd: ['make', ['test']],
        prompt: `Fix \`src/handler.c\` (${sp.bugHint}). Start the background server with \`make run\` (takes ~350ms warm-up before \`http://127.0.0.1:${port}/health\` responds HTTP 200), run \`make test\` until it prints \`INTEGRATION_OK\`, and cleanly stop the background server and any child processes before finishing. Do not edit \`tests/check.c\` or \`Makefile\`.`,
      };
    },
    async verify(wsDir, state, runtimeInfo) {
      const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
      const integrationRan = runtimeInfo.integrationOk === true;
      const zeroOrphans = (runtimeInfo.orphansAfterRuntimeClose ?? 0) === 0;
      let freshServerOk = false;
      let freshErr = null;
      if (imm.ok && zeroOrphans) {
        const srv = spawn('/bin/sh', ['-c', state.startCmd], {
          cwd: wsDir,
          detached: true,
          stdio: 'ignore',
        });
        try {
          const deadline = Date.now() + 6000;
          let ready = false;
          while (Date.now() < deadline) {
            try {
              const r = await fetch(`http://127.0.0.1:${state.port}/health`);
              if (r.ok) {
                ready = true;
                break;
              }
            } catch {}
            await new Promise((r) => setTimeout(r, 80));
          }
          if (!ready) {
            freshErr = `verification server did not become ready on port ${state.port}`;
          } else {
            const check = runCheckCmd(state.testCmd[0], state.testCmd[1], wsDir, 8000);
            freshServerOk = check.ok;
            freshErr = check.error;
          }
        } finally {
          try { process.kill(-srv.pid, 'SIGKILL'); } catch {}
          runtimeInfo.forceCleanTag?.();
        }
      }
      return {
        passed: imm.ok && integrationRan && zeroOrphans && freshServerOk,
        testsUntampered: imm.ok,
        integrationRan,
        freshServerOk,
        orphansBeforeClose: runtimeInfo.orphansBeforeClose ?? 0,
        orphansAfterRuntimeClose: runtimeInfo.orphansAfterRuntimeClose ?? 0,
        detail: !imm.ok
          ? `tampered: ${imm.tamperedFile}`
          : !zeroOrphans
            ? `left ${runtimeInfo.orphansAfterRuntimeClose} orphan process(es)`
            : !freshServerOk
              ? freshErr || 'fresh integration check failed'
              : !integrationRan
                ? 'agent never observed INTEGRATION_OK against live server'
                : null,
      };
    },
  }));
}

// ============================================================================
// Category C (6 tasks: 2 JS, 2 Python, 2 Go): Atomic Refactor & Speculative Rollback
// ============================================================================

function seedSpeculativePatch(wsDir, candidateEdits, docContent) {
  initCleanRepo(wsDir);
  for (const [rel, txt] of Object.entries(candidateEdits)) {
    fs.writeFileSync(path.join(wsDir, rel), txt, 'utf8');
  }
  const diff = execFileSync('git', ['diff'], { cwd: wsDir, encoding: 'utf8' });
  execFileSync('git', ['checkout', '--', '.'], { cwd: wsDir, stdio: 'ignore' });
  writeFiles(wsDir, {
    'patches/candidate.diff': diff,
    'REFACTOR_SPEC.md': docContent,
  });
  execFileSync('git', ['add', 'patches/candidate.diff', 'REFACTOR_SPEC.md'], { cwd: wsDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'add candidate speculative patch'], { cwd: wsDir, stdio: 'ignore' });
}

function makeCatCTasks() {
  const tasks = [
    // C1 per lang: Atomic multi-file signature refactor (MUST pass tests & leave clean working fix)
    {
      id: 'js-c1-atomic-refactor',
      language: 'javascript',
      category: 'C_atomic_rollback',
      expectCleanHead: false,
      seed(wsDir) {
        writeFiles(wsDir, {
          'package.json': '{"name":"ref","type":"module"}\n',
          'src/format.mjs': 'export function formatLine(name, cents) {\n  return `${name}:${cents}`;\n}\n',
          'src/caller.mjs': 'import { formatLine } from "./format.mjs";\nexport function renderReceipt(items) {\n  return items.map((x) => formatLine(x.name, x.cents)).join("\\n");\n}\n',
          'test/receipt.test.mjs':
            'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { renderReceipt } from "../src/caller.mjs";\ntest("formats receipt", () => {\n  assert.equal(renderReceipt([{ name: "pen", cents: 150, currency: "USD" }]), "USD pen:150");\n});\n',
        });
        const hashes = recordHashes(wsDir, ['test/receipt.test.mjs']);
        initCleanRepo(wsDir);
        return {
          immutableHashes: hashes,
          testCmd: [process.execPath, ['--test']],
          prompt: 'Update `formatLine({ name, cents, currency })` in `src/format.mjs` AND update `src/caller.mjs` atomically so `renderReceipt` outputs `"USD pen:150"` per item. Keep `test/receipt.test.mjs` unchanged and validate with `node --test`. Ensure no broken half-edits remain.',
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd(process.execPath, ['--test'], wsDir);
        return { passed: imm.ok && run.ok, testsUntampered: imm.ok, detail: !imm.ok ? `tampered: ${imm.tamperedFile}` : run.error };
      },
    },
    {
      id: 'js-c2-speculative-rollback',
      language: 'javascript',
      category: 'C_atomic_rollback',
      expectCleanHead: true,
      seed(wsDir) {
        writeFiles(wsDir, {
          'package.json': '{"name":"spec","type":"module"}\n',
          'src/math.mjs': 'export function safeDivide(a, b) {\n  if (b === 0) throw new Error("div0");\n  return Math.trunc(a / b);\n}\n',
          'src/service.mjs': 'import { safeDivide } from "./math.mjs";\nexport function share(total, count) {\n  return safeDivide(total, count);\n}\n',
          'test/invariant.test.mjs':
            'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { share } from "../src/service.mjs";\ntest("throws on zero divisor invariant", () => {\n  assert.equal(share(10, 2), 5);\n  assert.throws(() => share(10, 0), /div0/);\n});\n',
        });
        seedSpeculativePatch(
          wsDir,
          {
            'src/math.mjs': 'export function safeDivide(a, b) {\n  if (b === 0) return 0;\n  return Math.trunc(a / b);\n}\n',
            'src/service.mjs': 'import { safeDivide } from "./math.mjs";\nexport function share(total, count) {\n  return safeDivide(total, count) || 0;\n}\n',
          },
          'Evaluate `patches/candidate.diff` speculatively against `node --test`. Keep ONLY if ALL tests pass; otherwise roll back cleanly so HEAD stays clean.',
        );
        const hashes = recordHashes(wsDir, ['test/invariant.test.mjs', 'patches/candidate.diff']);
        return {
          immutableHashes: hashes,
          headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsDir, encoding: 'utf8' }).trim(),
          testCmd: [process.execPath, ['--test']],
          prompt: 'Speculatively test `patches/candidate.diff` against `node --test`. ONLY keep/commit the patch if ALL tests in `test/invariant.test.mjs` pass. If the patch breaks tests, ensure the main workspace is completely clean (zero modified or untracked files vs Git HEAD) and tests still pass on baseline HEAD. Do not edit `test/invariant.test.mjs`.',
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd(process.execPath, ['--test'], wsDir);
        const dirty = gitStatusDirtyCount(wsDir);
        const curHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsDir, encoding: 'utf8' }).trim();
        return {
          passed: imm.ok && run.ok && dirty === 0 && curHead === state.headSha,
          testsUntampered: imm.ok,
          dirtyCount: dirty,
          detail: !imm.ok ? `tampered: ${imm.tamperedFile}` : dirty !== 0 ? `dirty working tree (${dirty} files)` : run.error,
        };
      },
    },
    {
      id: 'py-c1-atomic-refactor',
      language: 'python',
      category: 'C_atomic_rollback',
      expectCleanHead: false,
      seed(wsDir) {
        writeFiles(wsDir, {
          'pkg/__init__.py': '',
          'pkg/norm.py': 'def normalize(s):\n    return s.strip()\n',
          'pkg/ingest.py': 'from pkg.norm import normalize\ndef ingest_rows(rows):\n    return [normalize(r) for r in rows]\n',
          'tests/test_norm.py':
            'import unittest\nfrom pkg.ingest import ingest_rows\nclass T(unittest.TestCase):\n    def test_lower(self):\n        self.assertEqual(ingest_rows(["  Hi ", "BYE"]), ["hi", "bye"])\n',
        });
        const hashes = recordHashes(wsDir, ['tests/test_norm.py']);
        initCleanRepo(wsDir);
        return {
          immutableHashes: hashes,
          prompt: 'Update `normalize(s, lowercase=True)` in `pkg/norm.py` and its call in `pkg/ingest.py` atomically so `ingest_rows(["  Hi ", "BYE"])` returns `["hi", "bye"]`. Do not modify `tests/test_norm.py` and verify `python3 -m unittest discover -s tests` passes.',
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], wsDir);
        return { passed: imm.ok && run.ok, testsUntampered: imm.ok, detail: !imm.ok ? `tampered: ${imm.tamperedFile}` : run.error };
      },
    },
    {
      id: 'py-c2-speculative-rollback',
      language: 'python',
      category: 'C_atomic_rollback',
      expectCleanHead: true,
      seed(wsDir) {
        writeFiles(wsDir, {
          'pkg/__init__.py': '',
          'pkg/auth.py': 'def verify_role(role):\n    return role in ("admin", "editor")\n',
          'tests/test_invariant.py':
            'import unittest\nfrom pkg.auth import verify_role\nclass T(unittest.TestCase):\n    def test_guest_denied(self):\n        self.assertTrue(verify_role("admin"))\n        self.assertFalse(verify_role("guest"))\n',
        });
        seedSpeculativePatch(
          wsDir,
          { 'pkg/auth.py': 'def verify_role(role):\n    return role in ("admin", "editor", "guest")\n' },
          'Try candidate patch `patches/candidate.diff`; keep ONLY if `tests/test_invariant.py` passes.',
        );
        const hashes = recordHashes(wsDir, ['tests/test_invariant.py', 'patches/candidate.diff']);
        return {
          immutableHashes: hashes,
          headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsDir, encoding: 'utf8' }).trim(),
          prompt: 'Speculatively apply and validate `patches/candidate.diff` against `python3 -m unittest discover -s tests`. Keep changes ONLY if all tests pass; otherwise make sure the repository is left completely clean against Git HEAD (zero modified/untracked files) and tests pass cleanly. Do not touch `tests/`.',
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], wsDir);
        const dirty = gitStatusDirtyCount(wsDir);
        const curHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsDir, encoding: 'utf8' }).trim();
        return {
          passed: imm.ok && run.ok && dirty === 0 && curHead === state.headSha,
          testsUntampered: imm.ok,
          dirtyCount: dirty,
          detail: !imm.ok ? `tampered: ${imm.tamperedFile}` : dirty !== 0 ? `dirty tree (${dirty})` : run.error,
        };
      },
    },
    {
      id: 'c-c1-atomic-refactor',
      language: 'c',
      category: 'C_atomic_rollback',
      expectCleanHead: false,
      seed(wsDir) {
        writeFiles(wsDir, {
          'Makefile': 'CC ?= cc\nCFLAGS = -std=c99 -O2 -Wall -Wextra\n\ntest:\n\t@mkdir -p build\n\t@$(CC) $(CFLAGS) src/auth.c src/mw.c tests/auth_test.c -o build/auth_test && ./build/auth_test\n',
          'src/auth.h': 'int valid_token(const char *tok);\nint handle_req(const char *tok);\n',
          'src/auth.c': '#include "auth.h"\n#include <string.h>\nint valid_token(const char *tok) {\n  return tok && strcmp(tok, "ok") == 0;\n}\n',
          'src/mw.c': '#include "auth.h"\nint handle_req(const char *tok) {\n  return valid_token(tok) ? 200 : 401;\n}\n',
          'tests/auth_test.c':
            '#include <stdio.h>\n#include "../src/auth.h"\nint main(void) {\n  if (handle_req("ok-prod") != 200 || handle_req("ok") != 401) {\n    fprintf(stderr, "FAIL: unexpected auth status\\n");\n    return 1;\n  }\n  return 0;\n}\n',
        });
        const hashes = recordHashes(wsDir, ['tests/auth_test.c', 'Makefile']);
        initCleanRepo(wsDir);
        return {
          immutableHashes: hashes,
          prompt: 'Update `valid_token(const char *env, const char *tok)` in `src/auth.h` and `src/auth.c` (requiring `tok` equals `"ok-"` followed by `env`, e.g. `"ok-prod"` when `env` is `"prod"`) and update `handle_req` in `src/mw.c` to pass `"prod"` atomically. Verify `make test` passes without modifying `tests/auth_test.c` or `Makefile`.',
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd('make', ['test'], wsDir);
        return { passed: imm.ok && run.ok, testsUntampered: imm.ok, detail: !imm.ok ? `tampered: ${imm.tamperedFile}` : run.error };
      },
    },
    {
      id: 'c-c2-speculative-rollback',
      language: 'c',
      category: 'C_atomic_rollback',
      expectCleanHead: true,
      seed(wsDir) {
        writeFiles(wsDir, {
          'Makefile': 'CC ?= cc\nCFLAGS = -std=c99 -O2 -Wall -Wextra\n\ntest:\n\t@mkdir -p build\n\t@$(CC) $(CFLAGS) src/lim.c tests/lim_test.c -o build/lim_test && ./build/lim_test\n',
          'src/lim.h': 'int max_batch(void);\n',
          'src/lim.c': '#include "lim.h"\nint max_batch(void) { return 100; }\n',
          'tests/lim_test.c':
            '#include <stdio.h>\n#include "../src/lim.h"\nint main(void) {\n  int m = max_batch();\n  if (m > 100) { fprintf(stderr, "FAIL: limit violated: %d\\n", m); return 1; }\n  return 0;\n}\n',
        });
        seedSpeculativePatch(
          wsDir,
          { 'src/lim.c': '#include "lim.h"\nint max_batch(void) { return 500; }\n' },
          'Test speculative patch `patches/candidate.diff` against `make test`.',
        );
        const hashes = recordHashes(wsDir, ['tests/lim_test.c', 'Makefile', 'patches/candidate.diff']);
        return {
          immutableHashes: hashes,
          headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsDir, encoding: 'utf8' }).trim(),
          prompt: 'Speculatively apply and test `patches/candidate.diff` against `make test`. Keep the change ONLY if all tests pass; if the test invariant rejects it, keep the repository clean against Git HEAD (zero modified or untracked files) and `make test` green. Do not modify `tests/lim_test.c`, `Makefile`, or `patches/candidate.diff`.',
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd('make', ['test'], wsDir);
        const dirty = gitStatusDirtyCount(wsDir);
        const curHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsDir, encoding: 'utf8' }).trim();
        return {
          passed: imm.ok && run.ok && dirty === 0 && curHead === state.headSha,
          testsUntampered: imm.ok,
          dirtyCount: dirty,
          detail: !imm.ok ? `tampered: ${imm.tamperedFile}` : dirty !== 0 ? `dirty tree (${dirty})` : run.error,
        };
      },
    },
  ];
  return tasks;
}

// ============================================================================
// Category D (6 tasks: 2 JS, 2 Python, 2 Go): Concurrent Peer Edit
// ============================================================================

function makeCatDTasks() {
  return [
    // D1: Disjoint Symbol Early Cutoff (JS, Python, Go)
    {
      id: 'js-d1-early-cutoff',
      language: 'javascript',
      category: 'D_causal_peer',
      subtype: 'disjoint_early_cutoff',
      seed(wsDir) {
        writeFiles(wsDir, {
          'package.json': '{"name":"d1","type":"module"}\n',
          'src/shared.mjs':
            'export function computeCore(x) {\n  return x * 2;\n}\n\nexport function formatBanner(s) {\n  return `[${s}]`;\n}\n',
          'src/feature.mjs':
            'import { computeCore } from "./shared.mjs";\nexport function runFeature(x) {\n  return computeCore(x) + 1;\n}\n',
          'test/feature.test.mjs':
            'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { runFeature } from "../src/feature.mjs";\ntest("adds 10", () => { assert.equal(runFeature(5), 20); });\n',
        });
        const hashes = recordHashes(wsDir, ['test/feature.test.mjs']);
        initCleanRepo(wsDir);
        return {
          immutableHashes: hashes,
          peerTriggerPath: 'src/shared.mjs',
          peerMutated: false,
          prompt: 'Inspect `src/shared.mjs` (focus on symbol `computeCore`), `src/feature.mjs`, and `test/feature.test.mjs`. Fix `runFeature` in `src/feature.mjs` so it adds `10` instead of `1` (do NOT modify `src/shared.mjs`), then run `node --test` to verify.',
          applyPeerMutation() {
            const p = path.join(wsDir, 'src/shared.mjs');
            fs.writeFileSync(
              p,
              fs.readFileSync(p, 'utf8').replace('return `[${s}]`;', 'return `<<${s}>>`; // peer update'),
              'utf8',
            );
            execFileSync('git', ['add', 'src/shared.mjs'], { cwd: wsDir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-q', '-m', 'peer: update formatBanner'], { cwd: wsDir, stdio: 'ignore' });
          },
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd(process.execPath, ['--test'], wsDir);
        const peerOk = fs.readFileSync(path.join(wsDir, 'src/shared.mjs'), 'utf8').includes('<<${s}>>');
        return { passed: imm.ok && run.ok && peerOk, testsUntampered: imm.ok, peerUpdatePreserved: peerOk, detail: run.error };
      },
    },
    {
      id: 'js-d2-contended-guard',
      language: 'javascript',
      category: 'D_causal_peer',
      subtype: 'contended_registry',
      seed(wsDir) {
        writeFiles(wsDir, {
          'package.json': '{"name":"d2","type":"module"}\n',
          'src/registry.json': '{\n  "featureA": false,\n  "rateLimit": 10,\n  "region": "us-east"\n}\n',
          'test/registry.test.mjs':
            'import test from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\ntest("featureA enabled", () => {\n  const r = JSON.parse(fs.readFileSync(new URL("../src/registry.json", import.meta.url), "utf8"));\n  assert.equal(r.featureA, true);\n});\n',
        });
        const hashes = recordHashes(wsDir, ['test/registry.test.mjs']);
        initCleanRepo(wsDir);
        return {
          immutableHashes: hashes,
          peerTriggerPath: 'src/registry.json',
          peerTriggerAfterFirstCmd: true,
          peerMutated: false,
          prompt: 'Step 1: Read `src/registry.json` and run `node --test` once to see the failing test. Step 2: Update `src/registry.json` to set `"featureA": true` while preserving all other fields, then run `node --test` again.',
          applyPeerMutation() {
            const p = path.join(wsDir, 'src/registry.json');
            const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
            cur.rateLimit = 25;
            cur.peerHeartbeat = true;
            fs.writeFileSync(p, `${JSON.stringify(cur, null, 2)}\n`, 'utf8');
            execFileSync('git', ['add', 'src/registry.json'], { cwd: wsDir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-q', '-m', 'peer: bump rateLimit and add peerHeartbeat'], { cwd: wsDir, stdio: 'ignore' });
          },
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd(process.execPath, ['--test'], wsDir);
        let peerOk = false;
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(wsDir, 'src/registry.json'), 'utf8'));
          peerOk = obj.featureA === true && obj.rateLimit === 25 && obj.peerHeartbeat === true;
        } catch {}
        return {
          passed: imm.ok && run.ok && peerOk,
          testsUntampered: imm.ok,
          peerUpdatePreserved: peerOk,
          detail: !peerOk ? 'peer rateLimit/peerHeartbeat lost or invalid JSON' : run.error,
        };
      },
    },
    {
      id: 'py-d1-early-cutoff',
      language: 'python',
      category: 'D_causal_peer',
      subtype: 'disjoint_early_cutoff',
      seed(wsDir) {
        writeFiles(wsDir, {
          'pkg/__init__.py': '',
          'pkg/shared.py': 'def compute_core(x):\n    return x * 3\n\ndef format_banner(s):\n    return f"[{s}]"\n',
          'pkg/feature.py': 'from pkg.shared import compute_core\ndef run_feature(x):\n    return compute_core(x) + 1\n',
          'tests/test_feature.py':
            'import unittest\nfrom pkg.feature import run_feature\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(run_feature(4), 22)\n',
        });
        const hashes = recordHashes(wsDir, ['tests/test_feature.py']);
        initCleanRepo(wsDir);
        return {
          immutableHashes: hashes,
          peerTriggerPath: 'pkg/shared.py',
          peerMutated: false,
          prompt: 'Inspect `pkg/shared.py` (symbols: `compute_core`), `pkg/feature.py`, and `tests/test_feature.py`. Fix `run_feature` in `pkg/feature.py` so it adds `10` instead of `1` without changing `pkg/shared.py`, then verify `python3 -m unittest discover -s tests`.',
          applyPeerMutation() {
            const p = path.join(wsDir, 'pkg/shared.py');
            fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('return f"[{s}]"', 'return f"<<{s}>>"'), 'utf8');
            execFileSync('git', ['add', 'pkg/shared.py'], { cwd: wsDir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-q', '-m', 'peer: update banner'], { cwd: wsDir, stdio: 'ignore' });
          },
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], wsDir);
        const peerOk = fs.readFileSync(path.join(wsDir, 'pkg/shared.py'), 'utf8').includes('<<{s}>>');
        return { passed: imm.ok && run.ok && peerOk, testsUntampered: imm.ok, peerUpdatePreserved: peerOk, detail: run.error };
      },
    },
    {
      id: 'py-d2-contended-guard',
      language: 'python',
      category: 'D_causal_peer',
      subtype: 'contended_registry',
      seed(wsDir) {
        writeFiles(wsDir, {
          'config/registry.json': '{\n  "featureA": false,\n  "rateLimit": 10,\n  "region": "us-east"\n}\n',
          'tests/test_registry.py':
            'import json, unittest\nclass T(unittest.TestCase):\n    def test_reg(self):\n        with open("config/registry.json") as f:\n            d = json.load(f)\n        self.assertTrue(d["featureA"])\n',
        });
        const hashes = recordHashes(wsDir, ['tests/test_registry.py']);
        initCleanRepo(wsDir);
        return {
          immutableHashes: hashes,
          peerTriggerPath: 'config/registry.json',
          peerTriggerAfterFirstCmd: true,
          peerMutated: false,
          prompt: 'Step 1: Inspect `config/registry.json` and run `python3 -m unittest discover -s tests` once to see the failure. Step 2: Update `config/registry.json` so `"featureA"` is `true`, keeping other settings intact, then re-run tests.',
          applyPeerMutation() {
            const p = path.join(wsDir, 'config/registry.json');
            const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
            cur.rateLimit = 25;
            cur.peerHeartbeat = true;
            fs.writeFileSync(p, `${JSON.stringify(cur, null, 2)}\n`, 'utf8');
            execFileSync('git', ['add', 'config/registry.json'], { cwd: wsDir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-q', '-m', 'peer: update registry'], { cwd: wsDir, stdio: 'ignore' });
          },
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], wsDir);
        let peerOk = false;
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(wsDir, 'config/registry.json'), 'utf8'));
          peerOk = obj.featureA === true && obj.rateLimit === 25 && obj.peerHeartbeat === true;
        } catch {}
        return {
          passed: imm.ok && run.ok && peerOk,
          testsUntampered: imm.ok,
          peerUpdatePreserved: peerOk,
          detail: !peerOk ? 'peer update lost in config/registry.json' : run.error,
        };
      },
    },
    {
      id: 'c-d1-early-cutoff',
      language: 'c',
      category: 'D_causal_peer',
      subtype: 'disjoint_early_cutoff',
      seed(wsDir) {
        writeFiles(wsDir, {
          'Makefile': 'CC ?= cc\nCFLAGS = -std=c99 -O2 -Wall -Wextra\n\ntest:\n\t@mkdir -p build\n\t@$(CC) $(CFLAGS) src/shared.c src/feature.c tests/feature_test.c -o build/feature_test && ./build/feature_test\n',
          'src/shared.h': 'int compute_core(int x);\nint format_flag(int x);\nint run_feature(int x);\n',
          'src/shared.c': '#include "shared.h"\n\nint compute_core(int x) {\n  return x * 4;\n}\n\nint format_flag(int x) {\n  return x + 100;\n}\n',
          'src/feature.c': '#include "shared.h"\n\nint run_feature(int x) {\n  return compute_core(x) + 1;\n}\n',
          'tests/feature_test.c':
            '#include <stdio.h>\n#include "../src/shared.h"\nint main(void) {\n  int got = run_feature(3);\n  if (got != 22) { fprintf(stderr, "FAIL: want 22 got %d\\n", got); return 1; }\n  return 0;\n}\n',
        });
        const hashes = recordHashes(wsDir, ['tests/feature_test.c', 'Makefile']);
        initCleanRepo(wsDir);
        return {
          immutableHashes: hashes,
          peerTriggerPath: 'src/shared.c',
          peerMutated: false,
          prompt: 'Inspect `src/shared.c` (symbols: `compute_core`), `src/feature.c`, and `tests/feature_test.c`. Fix `run_feature` in `src/feature.c` to add `10` instead of `1` without altering `src/shared.c`, then run `make test`.',
          applyPeerMutation() {
            const p = path.join(wsDir, 'src/shared.c');
            fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('return x + 100;', 'return x + 200;'), 'utf8');
            execFileSync('git', ['add', 'src/shared.c'], { cwd: wsDir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-q', '-m', 'peer: update format_flag'], { cwd: wsDir, stdio: 'ignore' });
          },
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd('make', ['test'], wsDir);
        const peerOk = fs.readFileSync(path.join(wsDir, 'src/shared.c'), 'utf8').includes('x + 200');
        return { passed: imm.ok && run.ok && peerOk, testsUntampered: imm.ok, peerUpdatePreserved: peerOk, detail: run.error };
      },
    },
    {
      id: 'c-d2-contended-guard',
      language: 'c',
      category: 'D_causal_peer',
      subtype: 'contended_registry',
      seed(wsDir) {
        writeFiles(wsDir, {
          'Makefile': 'CC ?= cc\nCFLAGS = -std=c99 -O2 -Wall -Wextra\n\ntest:\n\t@mkdir -p build\n\t@$(CC) $(CFLAGS) tests/reg_test.c -o build/reg_test && ./build/reg_test\n',
          'config/registry.json': '{\n  "featureA": false,\n  "rateLimit": 10,\n  "region": "us-east"\n}\n',
          'tests/reg_test.c': [
            '#include <ctype.h>',
            '#include <stdio.h>',
            '#include <string.h>',
            'int main(void) {',
            '  FILE *f = fopen("config/registry.json", "rb");',
            '  if (!f) { fprintf(stderr, "FAIL: missing config/registry.json\\n"); return 1; }',
            '  char buf[4096]; size_t n = fread(buf, 1, sizeof(buf) - 1, f); fclose(f); buf[n] = \'\\0\';',
            '  const char *k = strstr(buf, "\\"featureA\\"");',
            '  if (!k) { fprintf(stderr, "FAIL: featureA missing\\n"); return 1; }',
            '  const char *p = k + 10; while (*p && isspace((unsigned char)*p)) p++;',
            '  if (*p != \':\') { fprintf(stderr, "FAIL: malformed JSON\\n"); return 1; }',
            '  p++; while (*p && isspace((unsigned char)*p)) p++;',
            '  if (strncmp(p, "true", 4) != 0) { fprintf(stderr, "FAIL: expected featureA true\\n"); return 1; }',
            '  return 0;',
            '}',
          ].join('\n'),
        });
        const hashes = recordHashes(wsDir, ['tests/reg_test.c', 'Makefile']);
        initCleanRepo(wsDir);
        return {
          immutableHashes: hashes,
          peerTriggerPath: 'config/registry.json',
          peerTriggerAfterFirstCmd: true,
          peerMutated: false,
          prompt: 'Step 1: Read `config/registry.json` and run `make test` once to confirm the failing test. Step 2: Update `config/registry.json` setting `"featureA": true` cleanly while preserving other fields, then run `make test`.',
          applyPeerMutation() {
            const p = path.join(wsDir, 'config/registry.json');
            const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
            cur.rateLimit = 25;
            cur.peerHeartbeat = true;
            fs.writeFileSync(p, `${JSON.stringify(cur, null, 2)}\n`, 'utf8');
            execFileSync('git', ['add', 'config/registry.json'], { cwd: wsDir, stdio: 'ignore' });
            execFileSync('git', ['commit', '-q', '-m', 'peer: update registry'], { cwd: wsDir, stdio: 'ignore' });
          },
        };
      },
      verify(wsDir, state) {
        const imm = verifyImmutableFiles(wsDir, state.immutableHashes);
        const run = runCheckCmd('make', ['test'], wsDir);
        let peerOk = false;
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(wsDir, 'config/registry.json'), 'utf8'));
          peerOk = obj.featureA === true && obj.rateLimit === 25 && obj.peerHeartbeat === true;
        } catch {}
        return {
          passed: imm.ok && run.ok && peerOk,
          testsUntampered: imm.ok,
          peerUpdatePreserved: peerOk,
          detail: !peerOk ? 'peer update lost in config/registry.json' : run.error,
        };
      },
    },
  ];
}

export function buildAll30Tasks() {
  const all = [
    ...makeJsCatATasks(),
    ...makePyCatATasks(),
    ...makeCCatATasks(),
    ...makeCatBTasks(),
    ...makeCatCTasks(),
    ...makeCatDTasks(),
  ];
  return all;
}
