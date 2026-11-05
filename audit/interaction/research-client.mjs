import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'node:sqlite';
import { usageCost } from './model-budget.mjs';
import { writeJson } from './research-budget.mjs';

export const MODEL = 'cline-pass/deepseek-v4.1-flash-1017';
export const RETURNED_MODEL = 'vmc/deepseek-v4p1-flash-1017-contributor-fallbacks';
export class ResearchClient {
  #token;
  constructor(budget, output) { this.budget = budget; this.output = output; }
  async connect() {
    const db = new Database(path.join(os.homedir(), '.cc-switch/cc-switch.db'), { readOnly: true });
    try {
      const rows = db.prepare("SELECT settings_config FROM providers WHERE name = 'ClinePass' AND app_type = 'claude'").all();
      if (rows.length !== 1) throw new Error('Expected one existing ClinePass configuration');
      const env = JSON.parse(rows[0].settings_config).env;
      if (env.ANTHROPIC_MODEL !== MODEL || env.ANTHROPIC_BASE_URL !== 'http://127.0.0.1:8788' || !env.ANTHROPIC_AUTH_TOKEN) throw new Error('Configured provider identity changed');
      this.#token = env.ANTHROPIC_AUTH_TOKEN;
    } finally { db.close(); }
    const response = await fetch('http://127.0.0.1:8788/health', { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error('Configured local proxy is unavailable');
    const health = await response.json();
    if (health.upstream !== 'http://127.0.0.1:8787/api/v1/chat/completions') throw new Error('Configured route changed');
    this.endpoint = health.upstream;
    fs.mkdirSync(path.join(this.output, 'requests'), { recursive: true });
    return { configuredModel: MODEL, expectedReturnedModel: RETURNED_MODEL, endpoint: this.endpoint };
  }
  clean(value) { return this.#token ? String(value).split(this.#token).join('[REDACTED]') : String(value); }
  async request(payload, context, signal) {
    if (payload.model !== MODEL) throw new Error('Unreviewed model choice');
    signal?.throwIfAborted();
    const call = this.budget.reserve(payload, context);
    const prefix = path.join(this.output, 'requests', String(call.id).padStart(4, '0'));
    writeJson(`${prefix}-request.json`, { context: { experiment: this.budget.experiment, ...context }, payload }, { immutable: true });
    const began = Date.now();
    try {
      const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}`, 'X-Response-Format': 'openai', 'X-Title': 'xioflow-interaction-research' },
        body: JSON.stringify(payload) });
      const raw = this.clean(await response.text());
      fs.writeFileSync(`${prefix}-response.json`, raw, { flag: 'wx' });
      call.httpStatus = response.status;
      let result;
      try { result = JSON.parse(raw); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new Error('Invalid provider JSON; raw response retained'); }
      if (!response.ok) {
        if (response.status === 500 && result.error === 'empty response content') call.failureClass = 'provider_empty_response';
        throw new Error(`Provider HTTP ${response.status}; raw response retained`);
      }
      Object.assign(call, usageCost(result.usage), { state: 'settled', usage: result.usage, returnedModel: result.model, elapsedMs: Date.now() - began });
      this.budget.save();
      if (call.accountedUsd > call.reservedUsd) throw new Error('Actual cost exceeded reservation');
      if (result.model !== RETURNED_MODEL) throw new Error('Returned model identity changed');
      if (!result.choices?.[0]?.message) throw new Error('No model message');
      return { message: result.choices[0].message, callId: call.id };
    } catch (error) {
      if (call.failureClass === 'provider_empty_response') {
        call.state = 'unknown-charge-reserved'; call.accountedUsd = call.reservedUsd;
        call.accountingNote = 'Retain full reservation; no retry of this episode';
      } else call.state = call.state === 'settled' ? 'settled-error' : 'unknown-charge';
      call.error = this.clean(error.message); call.elapsedMs = Date.now() - began;
      this.budget.save();
      const failure = new Error(call.error); failure.code = call.failureClass ?? 'infrastructure_error';
      throw failure;
    }
  }
  close() { this.#token = undefined; }
}
