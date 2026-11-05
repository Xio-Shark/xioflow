import fs from 'node:fs';
import { ProcessFixture, processTask } from './process-fixture.mjs';
import { ProcessEpisode } from './process-episode.mjs';
import { ProcessError, processTools } from './process-host.mjs';
import { ActionCoordinator } from './action-coordinator.mjs';

export const ACTION_ARMS = ['command', 'object'];
const kinds = ['normal', 'conflict', 'replacement', 'exit', 'reload-reject', 'reload-noop'];
const objectSchema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
function actionTools(arm) {
  const tools = processTools('agent-poll').filter((tool) => tool.function.name !== 'submit');
  const identity = { instanceId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 1 } };
  if (arm === 'object') {
    tools.push({ type: 'function', function: { name: 'set_config', description: '向授权目标当前实例的配置文件写入 setting；必须使用观察到的 configRevision。返回新 revision；文件写成功不代表运行态生效。',
      parameters: objectSchema({ ...identity, setting: { type: 'integer', minimum: 1, maximum: 10000 } }) } });
    tools.push({ type: 'function', function: { name: 'reload', description: '要求目标重新加载指定当前文件版本。accepted 不代表目标已完成，随后用状态工具确认实际 setting 和 configCurrent。', parameters: objectSchema(identity) } });
  } else tools.push({ type: 'function', function: { name: 'run_command', description: '运行受限实验 CLI。argv 为 ["config-set","--instance",ID,"--expected-revision",REV,"--setting",VALUE] 或 ["config-reload","--instance",ID,"--expected-revision",REV]，所有元素都是字符串。REV 来自 inspect.configRevision 或写入回执.revision。与对象接口相同的权限和版本保护；命令回执不证明生效。',
    parameters: objectSchema({ argv: { type: 'array', items: { type: 'string' } } }) } });
  tools.push({ type: 'function', function: { name: 'submit', description: '独立检查目标是否实际生效，或有真实退出/reload失败的 blocked 依据。必须提交状态观察返回的证据；动作回执不能当 evidenceId。',
    parameters: objectSchema({ outcome: { type: 'string', enum: ['applied', 'blocked'] }, instanceId: { type: 'string' }, evidenceId: { type: 'string' } }) } });
  return tools;
}

export async function gradeAction(fixture, submission, evidence, attempts) {
  const checks = { shape: false, evidence: false, identity: false, currentFacts: false, targetEffect: false };
  if (!submission || Object.keys(submission).sort().join() !== 'evidenceId,instanceId,outcome') return { passed: false, checks };
  checks.shape = ['applied', 'blocked'].includes(submission.outcome);
  const observed = evidence.get(submission.evidenceId)?.rows.find((row) => row.instanceId === submission.instanceId);
  checks.evidence = Boolean(observed);
  const target = fixture.target;
  checks.identity = target.current && target.instanceId === submission.instanceId;
  if (!checks.shape || !checks.evidence || !checks.identity) return { passed: false, checks };
  const config = JSON.parse(fs.readFileSync(target.configFile));
  let state;
  if (target.alive) {
    const response = await fetch(`${target.url}/state`, { signal: AbortSignal.timeout(300), redirect: 'error' });
    if (!response.ok) throw new Error('Action grading probe failed');
    state = await response.json();
    if (state.instanceId !== target.instanceId || state.pid !== target.pid) throw new Error('Action grading identity mismatch');
  }
  checks.currentFacts = observed.alive === target.alive && observed.configRevision === config.revision && observed.configSetting === config.setting &&
    (!target.alive || observed.loadedRevision === state.loadedRevision && observed.setting === state.setting);
  const applied = Boolean(state?.ready && state.loadedRevision === config.revision && state.setting === config.setting && config.setting === fixture.spec.desiredSetting);
  const reloadAttempt = attempts.some((event) => event.origin === 'caller' && event.op === 'reload' && event.args.instanceId === target.instanceId &&
    (event.error?.code === 'reload_rejected' || event.result?.accepted));
  checks.targetEffect = submission.outcome === 'applied' ? applied : !applied && (!target.alive || reloadAttempt && config.setting === fixture.spec.desiredSetting);
  const expected = ['exit', 'reload-reject', 'reload-noop'].includes(fixture.spec.actionKind) ? 'blocked' : 'applied';
  checks.expectedOutcome = submission.outcome === expected;
  return { passed: Object.values(checks).every(Boolean), checks, checkedAt: Date.now(),
    actual: { instanceId: target.instanceId, alive: target.alive, config, loaded: state ?? null } };
}

export class ActionEpisode extends ProcessEpisode {
  static async create(taskId, arm) {
    if (!ACTION_ARMS.includes(arm)) throw new Error('Unknown action arm');
    const source = processTask(taskId);
    const actionKind = kinds[Number(taskId.slice(-2)) - 1];
    const spec = { ...source, kind: 'never', actionKind, desiredSetting: source.initialSetting + 30,
      goal: `将 ${source.environment} 环境的 ${source.name} 当前实例 setting 改为 ${source.initialSetting + 30}，重新加载后确认真实运行态已生效，提交 applied。配置或实例若变化应重新观察后继续；进程退出、reload 明确失败或接受后确实未生效则提交 blocked。其他环境实例不在写入授权范围。` };
    const fixture = await ProcessFixture.create(spec);
    try {
      await fixture.control(fixture.target, 'ready', { value: true });
      if (actionKind.startsWith('reload-')) await fixture.control(fixture.target, 'reloadMode', { value: actionKind === 'reload-reject' ? 'reject' : 'noop' });
      return new ActionEpisode(fixture, arm);
    } catch (error) { await fixture.close(); throw error; }
  }
  constructor(fixture, arm) {
    super(fixture, 'agent-poll');
    this.arm = arm;
    this.coordinator = new ActionCoordinator(fixture);
    this.ready.tools = actionTools(arm);
    this.ready.task.goal = fixture.spec.goal;
    this.host.onObservation = () => this.startFault();
  }
  startFault() {
    if (this.faultStarted) return;
    this.faultStarted = true;
    const fixture = this.fixture;
    fixture.start();
    let job;
    if (fixture.spec.actionKind === 'conflict') job = this.coordinator.act('set_config', { instanceId: fixture.target.instanceId, expectedRevision: 1, setting: fixture.spec.initialSetting + 1 }, 'controller');
    else if (fixture.spec.actionKind === 'exit') {
      fixture.target.child.kill('SIGTERM'); job = fixture.target.closedPromise;
    } else if (fixture.spec.actionKind === 'replacement') {
      const old = fixture.target;
      old.current = false; fixture.current = fixture.current.filter((item) => item !== old); old.child.kill('SIGTERM');
      job = (async () => {
        await old.closedPromise;
        const replacement = await fixture.spawn(old.environment, fixture.spec.initialSetting);
        fixture.target = replacement;
        await fixture.control(replacement, 'ready', { value: true });
      })();
    }
    if (job) { fixture.jobs.add(job); job.catch((error) => fixture.errors.push(error.message)).finally(() => fixture.jobs.delete(job)); }
  }
  async handle(op, args = {}) {
    if (op === 'inspect' || op === 'read_logs') return super.handle(op, args);
    if (this.finished) throw new Error('episode_finished');
    let response;
    const began = Date.now();
    try {
      if (op === 'submit') {
        this.verdict = await gradeAction(this.fixture, args, this.host.evidence, this.coordinator.attempts);
        this.finished = true; response = { submitted: true, passed: this.verdict.passed };
      } else if (this.arm === 'command' && op === 'run_command') {
        if (!args || Object.keys(args).join() !== 'argv') throw new ProcessError('invalid_args', 'Provide only argv');
        response = await this.coordinator.command(args.argv);
      } else if (this.arm === 'object' && ['set_config', 'reload'].includes(op)) response = await this.coordinator.act(op, args);
      else throw new ProcessError('unsupported_operation', op);
    } catch (error) { if (!(error instanceof ProcessError)) throw error; response = { error: { code: error.code, message: error.message } }; }
    this.events.push({ op, args, response, began, ended: Date.now() });
    this.bytes += Buffer.byteLength(JSON.stringify({ op, args, response }));
    return response;
  }
  async close() {
    if (this.fixture.cleanup) return;
    this.host.close();
    try { await this.coordinator.close(); this.restoration = await this.coordinator.restore(); }
    finally { await this.fixture.close(); }
  }
  get trace() { return { ...super.trace, kind: this.fixture.spec.actionKind, actions: this.coordinator.attempts, restoration: this.restoration, activeCommands: this.coordinator.commands.size }; }
}

export async function referenceAction(episode) {
  const spec = episode.fixture.spec;
  const where = { name: spec.name, environment: spec.environment };
  let snapshot = await episode.handle('inspect', { where });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const row = snapshot.rows[0];
    if (!row) { snapshot = await episode.handle('inspect', { where, delayMs: 80 }); continue; }
    if (!row.alive) return episode.handle('submit', { outcome: 'blocked', instanceId: row.instanceId, evidenceId: snapshot.evidenceId });
    const act = async (op, args) => episode.arm === 'object' ? episode.handle(op, args) : episode.handle('run_command', { argv: [op === 'set_config' ? 'config-set' : 'config-reload', '--instance', args.instanceId, '--expected-revision', String(args.expectedRevision), ...(op === 'set_config' ? ['--setting', String(args.setting)] : [])] });
    const written = await act('set_config', { instanceId: row.instanceId, expectedRevision: row.configRevision, setting: spec.desiredSetting });
    if (written.error) { snapshot = await episode.handle('inspect', { where, delayMs: 80 }); continue; }
    const loaded = await act('reload', { instanceId: row.instanceId, expectedRevision: written.revision });
    snapshot = await episode.handle('inspect', { where });
    const current = snapshot.rows[0];
    if (!current) continue;
    const outcome = !loaded.error && current.ready && current.configCurrent && current.setting === spec.desiredSetting ? 'applied' : 'blocked';
    return episode.handle('submit', { outcome, instanceId: current.instanceId, evidenceId: snapshot.evidenceId });
  }
  throw new Error('Action reference could not reach terminal state');
}
