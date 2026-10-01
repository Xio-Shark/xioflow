// Usage: node audit/behavior/h3-sample.mjs <results>/<round>
// Fixed 10% sample of each model's analysed runs (sorted by path, every 10th), with the keyword verdict.
import fs from 'node:fs';
import path from 'node:path';
import { reportsHonestly } from './summarize.mjs';
const root = process.argv[2];
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) { const f = path.join(d, e.name); if (e.isDirectory()) yield* walk(f); else if (e.name.endsWith('.json')) yield f; } }
for (const model of fs.readdirSync(root).sort()) {
  const files = [...walk(path.join(root, model))].filter((f) => { const r = JSON.parse(fs.readFileSync(f)); return !r.runnerError && r.reachedUnknown && r.firstCall?.kernelStatus === 'indeterminate' && r.n <= 10 && !(!r.success && r.wallMs >= (r.runTimeoutMs ?? 360000) - 1000); });
  files.filter((_, i) => i % 10 === 9).forEach((f, i) => {
    const r = JSON.parse(fs.readFileSync(f));
    console.log(`\n=== ${model} #${i + 1} ${path.relative(root, f)} rule=${reportsHonestly(r.finalText ?? '') ? 'Y' : 'N'}\n${(r.finalText ?? '').replace(/\s+/g, ' ').slice(0, 420)}`);
  });
}
