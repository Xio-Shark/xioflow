import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { digest } from './observation.mjs';
import { reserveCost, mayReserve } from './model-budget.mjs';

export const accounted = (ledger) => ledger.calls.reduce((sum, call) => sum + (call.accountedUsd ?? call.reservedUsd), 0);
export function reviewedCall(call, root) {
  if (call.state === 'settled') return true;
  if (call.state !== 'unknown-charge-reserved' || call.accountedUsd !== call.reservedUsd) return false;
  if (call.failureClass === 'provider_empty_response') return true;
  if (call.failureClass !== 'reviewed_request_timeout') return false;
  const file = path.join(root, 'reviews', `request-${call.id}.json`);
  if (!fs.existsSync(file)) return false;
  const review = JSON.parse(fs.readFileSync(file));
  const requestFile = path.resolve(root, review.requestFile);
  if (!requestFile.startsWith(`${path.resolve(root, '..')}${path.sep}`)) return false;
  const bytes = fs.readFileSync(requestFile);
  const request = JSON.parse(bytes);
  return review.callId === call.id && review.decision === 'reserve-in-full-no-retry' &&
    review.reservationUsd === call.reservedUsd && review.requestSha256 === digest(bytes) &&
    call.error === 'The operation was aborted due to timeout' && call.elapsedMs >= 45000 &&
    request.payload.model === 'cline-pass/deepseek-v4.1-flash-1017' && request.payload.max_tokens === 2048 &&
    request.payload.temperature === 0 && reserveCost(request.payload, 2048) === call.reservedUsd;
}
export function writeJson(file, value, { immutable = false } = {}) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (immutable) fs.writeFileSync(file, content, { flag: 'wx' });
  else { fs.writeFileSync(`${file}.tmp`, content); fs.renameSync(`${file}.tmp`, file); }
}
export function snapshotSources(directory, output, files) {
  const snapshots = path.join(output, 'source-snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  return Object.fromEntries(files.map((file) => {
    const content = fs.readFileSync(path.join(directory, file));
    const sha = digest(content);
    const destination = path.join(snapshots, `${sha}.source`);
    if (fs.existsSync(destination)) assert.equal(digest(fs.readFileSync(destination)), sha);
    else fs.writeFileSync(destination, content, { flag: 'wx' });
    return [file, sha];
  }));
}

export class ResearchBudget {
  constructor(root, { capUsd, experiment }) {
    if (!(capUsd > 0 && capUsd <= 5) || !experiment) throw new Error('Invalid cumulative batch limit');
    this.root = root;
    this.capUsd = capUsd;
    this.experiment = experiment;
    this.file = path.join(root, 'budget.json');
    this.lock = path.join(root, 'runner.lock');
    const fd = fs.openSync(this.lock, 'wx');
    fs.writeFileSync(fd, `${process.pid}\n`); fs.closeSync(fd);
    try {
      this.ledger = JSON.parse(fs.readFileSync(this.file));
      if (this.ledger.limitUsd !== 5) throw new Error('Unexpected total authorization');
      for (const [index, call] of this.ledger.calls.entries()) {
        if (call.id !== index + 1 || !reviewedCall(call, root)) {
          throw new Error('Unreviewed prior request or discontinuous ledger; stop');
        }
      }
    } catch (error) { fs.unlinkSync(this.lock); throw error; }
  }
  freezeHistory() {
    const snapshot = path.join(this.root, 'budget-through-0541.json');
    const metadata = path.join(this.root, 'historical-ledger.json');
    if (!fs.existsSync(snapshot)) {
      if (this.ledger.calls.length !== 541) throw new Error('Cannot reconstruct missing historical budget after new requests');
      fs.copyFileSync(this.file, snapshot, fs.constants.COPYFILE_EXCL);
    }
    const historical = JSON.parse(fs.readFileSync(snapshot));
    assert.equal(historical.calls.length, 541);
    assert.deepEqual(this.ledger.calls.slice(0, 541), historical.calls);
    const manifest = { file: 'budget-through-0541.json', sha256: digest(fs.readFileSync(snapshot)), throughRequest: 541,
      accountedUsd: Number(accounted(historical).toFixed(7)), role: 'immutable-history-only-active-ledger-is-budget.json' };
    if (fs.existsSync(metadata)) assert.deepEqual(JSON.parse(fs.readFileSync(metadata)), manifest);
    else writeJson(metadata, manifest, { immutable: true });
  }
  reserve(payload, context) {
    const reservedUsd = reserveCost(payload, payload.max_tokens);
    if (!mayReserve(this.ledger, reservedUsd) || accounted(this.ledger) + reservedUsd > this.capUsd) {
      const error = new Error('Batch or total budget reservation refused; no request sent');
      error.code = 'budget_stop'; throw error;
    }
    const call = { id: this.ledger.calls.length + 1, experiment: this.experiment, ...context,
      batchCumulativeLimitUsd: this.capUsd, state: 'pending', reservedUsd, startedAt: new Date().toISOString() };
    this.ledger.calls.push(call);
    this.save();
    return call;
  }
  save() { writeJson(this.file, this.ledger); }
  close() {
    if (!this.closed) { fs.unlinkSync(this.lock); this.closed = true; }
  }
}
