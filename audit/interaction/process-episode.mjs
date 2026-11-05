import { ProcessFixture, processTask } from './process-fixture.mjs';
import { ProcessHost, ProcessError, processTools } from './process-host.mjs';
import { gradeProcess } from './process-grader.mjs';

export class ProcessEpisode {
  static async create(taskId, arm, options = {}) {
    const spec = processTask(taskId);
    const fixture = await ProcessFixture.create(spec, options);
    return new ProcessEpisode(fixture, arm, options);
  }
  constructor(fixture, arm, options = {}) {
    this.fixture = fixture;
    this.arm = arm;
    this.host = new ProcessHost(fixture, arm, { ...options, onObservation: () => fixture.start() });
    this.events = [];
    this.finished = false;
    this.verdict = { passed: false, reason: 'no_submission' };
    this.ready = { task: { id: fixture.spec.id, goal: fixture.spec.goal }, tools: processTools(arm),
      facts: 'ready 是探针事实；configCurrent 表示加载配置与文件一致；alive 来自父进程退出事实。instanceId 随重启变化。',
      deadlineMs: fixture.deadlineMs };
    this.bytes = Buffer.byteLength(JSON.stringify(this.ready));
  }
  async handle(op, args = {}) {
    if (this.finished) throw new Error('episode_finished');
    const began = Date.now();
    let response;
    try {
      if (op === 'submit') {
        this.verdict = await gradeProcess(this.fixture, args, this.host.evidence);
        this.finished = true;
        response = { submitted: true, passed: this.verdict.passed };
      } else response = await this.host.call(op, args);
    } catch (error) {
      if (!(error instanceof ProcessError)) throw error;
      response = { error: { code: error.code, message: error.message } };
    }
    this.bytes += Buffer.byteLength(JSON.stringify({ op, args })) + Buffer.byteLength(JSON.stringify(response));
    this.events.push({ op, args, response, began, ended: Date.now() });
    return response;
  }
  async close() { this.host.close(); await this.fixture.close(); }
  get trace() {
    return { taskId: this.fixture.spec.id, kind: this.fixture.spec.kind, arm: this.arm, verdict: this.verdict,
      submitted: this.finished, cleaned: Boolean(this.fixture.cleanup), cleanup: this.fixture.cleanup,
      metrics: { ...this.host.metrics, transportBytes: this.bytes, toolCalls: this.events.length,
        toolErrors: this.events.filter((event) => event.response.error).length },
      changes: this.fixture.changes, samples: this.host.samples, events: this.events };
  }
}

export async function referenceProcess(episode, { intervalMs = 30 } = {}) {
  const spec = episode.fixture.spec;
  const where = { name: spec.name, environment: spec.environment };
  let result = await episode.handle('inspect', { where });
  const deadline = Date.now() + episode.fixture.deadlineMs;
  while (true) {
    const row = result.rows?.[0];
    const outcome = row && !row.alive ? 'exited' : row?.ready && row.configCurrent ? 'ready' : null;
    if (outcome === spec.expected) return episode.handle('submit', { outcome, instanceId: row.instanceId, evidenceId: result.evidenceId });
    if (Date.now() >= deadline) throw new Error('reference_deadline');
    result = episode.arm === 'agent-poll'
      ? await episode.handle('inspect', { where, delayMs: intervalMs })
      : await episode.handle('watch', { where, until: { ready: true, configCurrent: true }, after: result.evidenceId, maxWaitMs: 1000 });
  }
}
