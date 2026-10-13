/**
 * Structural sync guard between ARCHITECTURE.md (authoritative, Chinese) and
 * ARCHITECTURE.en.md (English mirror).
 *
 * The two documents carry different heading text by design; what must not
 * drift is the *structure*: the same section numbers present, in the same
 * order. This script extracts the numbered heading tree of both files and
 * diffs the sequences. A section that exists in one document but not the
 * other fails CI.
 *
 * Translation-level drift (same sections, different wording) is out of scope
 * by design — this is a structure guard, not a translation checker.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = {
  zh: path.join(root, 'ARCHITECTURE.md'),
  en: path.join(root, 'ARCHITECTURE.en.md'),
};

function headingIds(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const ids = [];
  for (const line of lines) {
    const match = /^(#{2,3})\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].trim();
    const numbered = /^(\d+(?:\.\d+)*)[.\s]/.exec(text);
    ids.push({ level, id: numbered ? numbered[1] : text });
  }
  return ids;
}

const zh = headingIds(files.zh);
const en = headingIds(files.en);

const serialize = (entries) => entries.map((entry) => `${'#'.repeat(entry.level)} ${entry.id}`).join('\n');

if (serialize(zh) === serialize(en)) {
  console.log(`doc-sync: heading trees match (${zh.length} sections)`);
  process.exit(0);
}

// Report the first divergence with context, then the full diff summary.
const zhLines = serialize(zh).split('\n');
const enLines = serialize(en).split('\n');
console.error('doc-sync: ARCHITECTURE.md and ARCHITECTURE.en.md heading trees differ.');
let firstDiff = -1;
for (let index = 0; index < Math.max(zhLines.length, enLines.length); index += 1) {
  if (zhLines[index] !== enLines[index]) {
    firstDiff = index;
    break;
  }
}
if (firstDiff >= 0) {
  console.error(`first divergence at heading #${firstDiff + 1}:`);
  console.error(`  zh: ${zhLines[firstDiff] ?? '(absent)'}`);
  console.error(`  en: ${enLines[firstDiff] ?? '(absent)'}`);
}
const zhOnly = zhLines.filter((line) => !enLines.includes(line));
const enOnly = enLines.filter((line) => !zhLines.includes(line));
if (zhOnly.length > 0) console.error(`only in zh (${zhOnly.length}): ${zhOnly.join(' | ')}`);
if (enOnly.length > 0) console.error(`only in en (${enOnly.length}): ${enOnly.join(' | ')}`);
console.error('mirror the missing sections, then re-run. The Chinese document is authoritative.');
process.exit(1);
