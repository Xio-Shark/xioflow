#!/usr/bin/env node
// E1: mutation test of "evidence is stale iff a file the command read has changed".
// Three small projects. For each: record the evidence of a passing test command, then break every file in turn,
// re-run the command to learn whether its verdict really flips, and compare with what the evidence says.
//   recall    = of the mutations that really flip the verdict, how many the evidence calls stale
//   precision = of the mutations the evidence calls stale, how many really flip the verdict
// Usage: node audit/freshness/e1.mjs --python <venv>/bin/python     (the venv needs pytest)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceStatus, runWithEvidence } from './evidence.mjs';

const python = process.argv[process.argv.indexOf('--python') + 1];
if (!python || !fs.existsSync(python)) throw new Error('pass --python <venv>/bin/python (with pytest installed)');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xf-fresh-e1-')));
const write = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
};

const PROJECTS = {
  'node-tests': {
    files: {
      'package.json': '{ "name": "demo", "type": "module" }\n',
      'README.md': '# demo\n',
      'docs/notes.md': 'notes\n',
      'src/math.mjs': 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n',
      'src/strings.mjs': "import { pad } from './pad.mjs';\nexport const title = (s) => pad(s[0].toUpperCase() + s.slice(1));\n",
      'src/pad.mjs': 'export const pad = (s) => s.trim();\n',
      'src/dates.mjs': 'export const year = (d) => new Date(d).getUTCFullYear();\n',
      'src/unused.mjs': 'export const unused = 1;\n',
      'src/legacy/old.mjs': 'export const old = 1;\n',
      'test/math.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, mul } from '../src/math.mjs';\ntest('math', () => { assert.equal(add(2, 3), 5); assert.equal(mul(2, 3), 6); });\n",
      'test/strings.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from '../src/strings.mjs';\ntest('title', () => assert.equal(title(' hello '.trim()), 'Hello'));\n",
      'test/dates.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { year } from '../src/dates.mjs';\ntest('year', () => assert.equal(year('2026-09-30'), 2026));\n",
    },
    command: [process.execPath, '--test', 'test/'],
  },
  'python-pytest (bytecode cache warm)': {
    files: pythonFiles(),
    command: [python, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests'],
    warmups: 1, // the second run is served from __pycache__
  },
  'python-pytest (no bytecode cache)': {
    files: pythonFiles(),
    command: [python, '-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests'],
    env: { PYTHONDONTWRITEBYTECODE: '1' },
  },
  'config-and-data': {
    files: {
      'config.json': '{ "currency": "EUR", "taxRate": 0.2, "locale": "en" }\n',
      'data/prices.csv': 'sku,price\nA,10\nB,20\n',
      'data/archive.csv': 'sku,price\nOLD,1\n',
      'templates/report.txt': 'Total: {{total}} {{currency}}\n',
      'templates/unused.txt': 'unused\n',
      'locales/en.json': '{ "title": "Report" }\n',
      'locales/de.json': '{ "title": "Bericht" }\n',
      'docs/README.md': '# report\n',
      'report.mjs': [
        "import fs from 'node:fs';",
        "const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));",
        "const rows = fs.readFileSync('data/prices.csv', 'utf8').trim().split('\\n').slice(1).map((l) => Number(l.split(',')[1]));",
        "const locale = JSON.parse(fs.readFileSync(`locales/${config.locale}.json`, 'utf8'));",
        "const total = rows.reduce((a, b) => a + b, 0) * (1 + config.taxRate);",
        "const text = locale.title + '\\n' + fs.readFileSync('templates/report.txt', 'utf8').replace('{{total}}', total).replace('{{currency}}', config.currency);",
        "if (text !== 'Report\\nTotal: 36 EUR\\n') { console.error(text); process.exit(1); }",
      ].join('\n') + '\n',
    },
    command: [process.execPath, 'report.mjs'],
  },
};

function pythonFiles() {
  return {
    'README.md': '# pydemo\n',
    'setup.cfg': '[metadata]\nname = pydemo\n',
    'pkg/__init__.py': '',
    'pkg/calc.py': 'from pkg.rounding import half_up\n\ndef total(prices, tax):\n    return half_up(sum(prices) * (1 + tax))\n',
    'pkg/rounding.py': 'def half_up(x):\n    return int(x + 0.5)\n',
    'pkg/text.py': 'def title(s):\n    return s[:1].upper() + s[1:]\n',
    'pkg/unused.py': 'UNUSED = 1\n',
    'pkg/legacy/__init__.py': '',
    'pkg/legacy/old.py': 'OLD = 1\n',
    'tests/__init__.py': '',
    'tests/test_calc.py': 'from pkg.calc import total\n\ndef test_total():\n    assert total([10, 20], 0.2) == 36\n',
    'tests/test_text.py': 'from pkg.text import title\n\ndef test_title():\n    assert title("hello") == "Hello"\n',
  };
}

/** A change that breaks the file for anything that uses it. */
function mutate(file) {
  if (/\.(mjs|js)$/.test(file)) return (text) => `${text}\nthrow new Error('mutated');\n`;
  if (/\.py$/.test(file)) return (text) => `${text}\nraise RuntimeError('mutated')\n`;
  if (/\.json$/.test(file)) return () => '{ "mutated": true }\n';
  return () => 'mutated\n';
}

function listFiles(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.name === '__pycache__' || entry.name === '.pytest_cache') return [];
    return entry.isDirectory() ? listFiles(root, child) : [child];
  });
}

const summary = [];
try {
  for (const [name, project] of Object.entries(PROJECTS)) {
    const root = path.join(tmp, name.replace(/[^a-z0-9]+/gi, '-'));
    write(root, project.files);
    const env = { ...process.env, ...(project.env ?? {}) };
    const record = () => {
      // Caches (bytecode) embed the source's timestamp: the evidence for each mutation is taken on the tree as
      // it is right before that mutation, after the caches have settled.
      for (let i = 0; i < (project.warmups ?? 0); i++) runWithEvidence(root, project.command, { env });
      return runWithEvidence(root, project.command, { env });
    };
    const first = record();
    if (first.exitCode !== 0) throw new Error(`${name}: the baseline command fails:\n${first.stdout}${first.stderr}`);
    const files = listFiles(root);
    const readFiles = Object.keys(first.evidence.entries).filter((e) => !e.endsWith('/') && !e.includes('__pycache__'));
    const rows = [];
    for (const file of files) {
      const baseline = record();
      const abs = path.join(root, file);
      const original = fs.readFileSync(abs, 'utf8');
      fs.writeFileSync(abs, mutate(file)(original));
      const verdict = evidenceStatus(root, baseline.evidence).status;
      const rerun = runWithEvidence(root, project.command, { env });
      rows.push({ file, inReadSet: file in baseline.evidence.entries, stale: verdict === 'stale', flips: rerun.exitCode !== 0 });
      fs.writeFileSync(abs, original);
    }
    const flips = rows.filter((r) => r.flips);
    const stale = rows.filter((r) => r.stale);
    const hit = rows.filter((r) => r.flips && r.stale);
    const misses = flips.filter((r) => !r.stale).map((r) => r.file);
    const falseAlarms = stale.filter((r) => !r.flips).map((r) => r.file);
    summary.push({ name, files: files.length, readSet: readFiles.length, flips: flips.length, stale: stale.length, hit: hit.length, misses, falseAlarms });
    console.log(`[${name}] files ${files.length}; read set ${readFiles.length} (${readFiles.join(', ')})`);
    console.log(`  mutations that flip the verdict: ${flips.length}; called stale: ${stale.length}; recall ${hit.length}/${flips.length}; precision ${hit.length}/${stale.length}`);
    if (misses.length) console.log(`  MISSED (verdict flips, evidence says fresh): ${misses.join(', ')}`);
    if (falseAlarms.length) console.log(`  false alarms (stale, verdict unchanged): ${falseAlarms.join(', ')}`);
  }
  const total = summary.reduce((acc, s) => ({ flips: acc.flips + s.flips, stale: acc.stale + s.stale, hit: acc.hit + s.hit }), { flips: 0, stale: 0, hit: 0 });
  console.log(`\nall projects: recall ${total.hit}/${total.flips}, precision ${total.hit}/${total.stale}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
