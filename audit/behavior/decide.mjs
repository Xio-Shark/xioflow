// Usage: node audit/behavior/summarize.mjs <results> --max-n 10 > s.md && node audit/behavior/decide.mjs s.md
// Applies analysis-plan §5 to the condition tables printed by summarize.mjs (one model per "## " section).
import fs from 'node:fs';
const text = fs.readFileSync(process.argv[2], 'utf8');
const w = (k, n) => { const z = 1.959964, p = k / n, c = (p + z * z / (2 * n)) / (1 + z * z / n), h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n); return [100 * (c - h), 100 * (c + h)]; };
const fmt = (k, n) => { const [lo, hi] = w(k, n); return `${k}/${n} = ${(100 * k / n).toFixed(0)}% [${lo.toFixed(1)}, ${hi.toFixed(1)}]`; };
// expectLower: the hypothesis predicts a lower rate for `a` than for `b`.
function decide(a, b, expectLower) {
  const pa = a.k / a.n, pb = b.k / b.n, [la, ha] = w(a.k, a.n), [lb, hb] = w(b.k, b.n);
  const right = expectLower ? pa < pb : pa > pb;
  const apart = expectLower ? ha < lb : la > hb;
  const diff = Math.abs(pa - pb) * 100;
  const overlap = Math.max(0, Math.min(ha, hb) - Math.max(la, lb)) / Math.min(ha - la, hb - lb);
  if (right && apart) return 'supported';
  if (!right && diff > 0) return 'not supported (wrong direction)';
  if (diff < 10 && overlap > 0.8) return 'not supported (nearly identical)';
  return 'cannot tell';
}
for (const section of text.split('\n## ').slice(1)) {
  const model = section.split('\n')[0];
  const rows = {};
  const cond = section.split('### Conditions')[1].split('###')[0];
  for (const line of cond.split('\n').filter((l) => /^\| (naive|honest|current) x /.test(l))) {
    const cells = line.split('|').map((c) => c.trim());
    const nums = (c) => { const m = /^(\d+)\/(\d+)/.exec(c); return { k: +m[1], n: +m[2] }; };
    rows[cells[1]] = { dup: nums(cells[3]), report: nums(cells[7]) };
  }
  const sum = (a, b) => ({ k: a.k + b.k, n: a.n + b.n });
  const nn = rows['naive x none'], hn = rows['honest x none'], ng = rows['naive x verify-gate'], hg = rows['honest x verify-gate'];
  const none = sum(nn.dup, hn.dup), gate = sum(ng.dup, hg.dup);
  const honestR = sum(hn.report, hg.report), naiveR = sum(nn.report, ng.report);
  console.log(`\n### ${model}`);
  console.log(`H1 duplicates, no enforcement: honest ${fmt(hn.dup.k, hn.dup.n)} vs naive ${fmt(nn.dup.k, nn.dup.n)} -> ${decide(hn.dup, nn.dup, true)}`);
  console.log(`H2 duplicates, wordings pooled: verify-gate ${fmt(gate.k, gate.n)} vs none ${fmt(none.k, none.n)} -> ${decide(gate, none, true)}; gate by wording: honest ${fmt(hg.dup.k, hg.dup.n)}, naive ${fmt(ng.dup.k, ng.dup.n)}`);
  console.log(`H3 report, enforcement pooled: honest ${fmt(honestR.k, honestR.n)} vs naive ${fmt(naiveR.k, naiveR.n)} -> ${decide(honestR, naiveR, false)}`);
}
