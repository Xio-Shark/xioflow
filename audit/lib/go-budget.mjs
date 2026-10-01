import { DatabaseSync } from 'node:sqlite';

// User-approved experiment budget, not account billing. Peak Go rates checked
// at https://opencode.ai/docs/go/ on 2026-10-01: $0.30/$1.20 per million tokens.
// A 128k input + 8192 output request costs < $0.05 without any cache discount.
export class GoExperimentBudget {
  constructor(file, fetchImpl = fetch) {
    this.db = new DatabaseSync(file);
    this.fetchImpl = fetchImpl;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY, label TEXT NOT NULL, reserved_cents INTEGER NOT NULL,
        status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
        peak_usd REAL, elapsed_ms INTEGER, http_status INTEGER
      );`);
  }

  async fetch(label, url, init) {
    const target = new URL(url);
    if (target.origin !== 'https://opencode.ai' || target.pathname !== '/zen/go/v1/chat/completions') {
      throw new Error('Experiment permits only the approved OpenCode Go endpoint');
    }
    const body = JSON.parse(init.body);
    if (body.model !== 'deepseek-v4.1-flash' || body.stream !== false
      || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 8192
      || Buffer.byteLength(init.body) > 128_000) {
      throw new Error('Request exceeds the approved model/size/output boundary');
    }
    this.db.exec('BEGIN IMMEDIATE');
    let id;
    try {
      const total = this.db.prepare('SELECT COALESCE(SUM(reserved_cents), 0) AS cents FROM requests').get().cents;
      if (total + 5 > 1000) throw new Error('Approved $10 cumulative experiment budget exhausted');
      id = Number(this.db.prepare("INSERT INTO requests(label,reserved_cents,status) VALUES (?,5,'reserved')").run(label).lastInsertRowid);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const start = Date.now();
    try {
      const response = await this.fetchImpl(url, {
        ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        this.db.prepare("UPDATE requests SET status='http_error', http_status=?, elapsed_ms=? WHERE id=?")
          .run(response.status, Date.now() - start, id);
        return response;
      }
      const json = await response.clone().json();
      const input = json.usage?.prompt_tokens;
      const output = json.usage?.completion_tokens;
      if (!Number.isSafeInteger(input) || input < 0 || input > 128_000
        || !Number.isSafeInteger(output) || output < 0 || output > 8192) {
        throw new Error('Provider usage is missing or exceeds the request reservation');
      }
      const peakUsd = (input * 0.30 + output * 1.20) / 1_000_000;
      this.db.prepare("UPDATE requests SET status='accounted', input_tokens=?, output_tokens=?, peak_usd=?, elapsed_ms=?, http_status=? WHERE id=?")
        .run(input, output, peakUsd, Date.now() - start, response.status, id);
      return response;
    } catch (error) {
      this.db.prepare("UPDATE requests SET status='unknown', elapsed_ms=? WHERE id=?").run(Date.now() - start, id);
      throw error; // Reservation remains charged even if a response was lost.
    }
  }

  report() {
    return this.db.prepare(`SELECT label, COUNT(*) AS requests, SUM(reserved_cents)/100.0 AS reservedUsd,
      SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(peak_usd) AS peakEstimateUsd,
      SUM(CASE WHEN status!='accounted' THEN 1 ELSE 0 END) AS unaccountedRequests,
      SUM(elapsed_ms) AS httpMs FROM requests GROUP BY label ORDER BY MIN(id)`).all();
  }

  close() { this.db.close(); }
}
