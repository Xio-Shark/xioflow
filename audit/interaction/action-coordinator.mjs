import fs from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProcessError } from './process-host.mjs';
import { atomicJson } from './process-fixture.mjs';

const cli = fileURLToPath(new URL('./action-command.mjs', import.meta.url));
export class ActionCoordinator {
  constructor(fixture) { this.fixture = fixture; this.tail = Promise.resolve(); this.attempts = []; this.commands = new Set(); }
  act(op, args, origin = 'caller') {
    const result = this.tail.then(() => this.perform(op, args, origin));
    // Keep the serialization chain usable after a documented rejected action.
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  async perform(op, args, origin) {
    const event = { op, args, origin, began: Date.now() };
    this.attempts.push(event);
    try {
      const allowed = op === 'set_config' ? ['instanceId', 'expectedRevision', 'setting'] : op === 'reload' ? ['instanceId', 'expectedRevision'] : null;
      if (!allowed) throw new ProcessError('unsupported_action', op);
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).sort().join() !== [...allowed].sort().join()) throw new ProcessError('invalid_args', 'Exact documented action fields required');
      const target = this.fixture.target;
      if (args.instanceId !== target.instanceId || !target.current) throw new ProcessError('wrong_instance', 'Only the authorized current target may be changed');
      if (!target.alive || target.child.killed) throw new ProcessError('process_exited', 'Current target has exited');
      const config = JSON.parse(fs.readFileSync(target.configFile));
      if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision !== config.revision) throw new ProcessError('stale_revision', 'Refresh current state before retrying');
      if (op === 'set_config') {
        if (!Number.isSafeInteger(args.setting) || args.setting < 1 || args.setting > 10000) throw new ProcessError('invalid_setting', 'setting must be an integer from 1 through 10000');
        const updated = { revision: config.revision + 1, setting: args.setting };
        atomicJson(target.configFile, updated);
        event.result = { instanceId: target.instanceId, fileWritten: true, revision: updated.revision, setting: updated.setting, effectVerified: false };
      } else {
        let reply;
        try { reply = await this.fixture.control(target, 'reload'); }
        catch (error) {
          if (!['reload_rejected', 'process_exited'].includes(error.message)) throw error;
          throw new ProcessError(error.message, error.message);
        }
        event.result = { instanceId: target.instanceId, accepted: true, loadedRevision: reply.state.loadedRevision, effectVerified: false };
      }
      event.ended = Date.now();
      return event.result;
    } catch (error) {
      event.error = { code: error.code ?? 'infrastructure_error', message: error.message }; event.ended = Date.now();
      throw error;
    }
  }
  async command(argv) {
    if (!Array.isArray(argv) || argv.length > 9 || argv.some((item) => typeof item !== 'string' || item.length > 200)) throw new ProcessError('invalid_argv', 'Provide an argv array for the documented fixture CLI');
    const child = fork(cli, argv, { cwd: this.fixture.directory, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    const member = { child };
    this.commands.add(member);
    let stdout = '';
    let stderr = '';
    let fatal;
    let requests = 0;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2048); });
    child.on('message', async (request) => {
      if (++requests > 1) { fatal = new Error('CLI emitted multiple broker requests'); child.kill('SIGTERM'); return; }
      try {
        let response;
        try { response = await this.act(request.op, request.args); }
        catch (error) { if (!(error instanceof ProcessError)) throw error; response = { error: { code: error.code, message: error.message } }; }
        if (child.connected) child.send(response, (error) => { if (error) { fatal = error; child.kill('SIGTERM'); } });
      } catch (error) { fatal = error; child.kill('SIGTERM'); }
    });
    member.closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
    child.once('error', (error) => { fatal = error; });
    const timer = setTimeout(() => { fatal = new Error('CLI timeout'); child.kill('SIGKILL'); }, 2500);
    try {
      const code = await member.closed;
      if (fatal) throw fatal;
      if (code !== 0 && code !== 2) throw new Error(`Fixture CLI failed: ${code}, ${stderr}`);
      const result = JSON.parse(stdout);
      if (result.error) throw new ProcessError(result.error.code, result.error.message);
      return result;
    } finally { clearTimeout(timer); this.commands.delete(member); }
  }
  async restore() {
    await Promise.all([...this.fixture.jobs]);
    await this.tail;
    const target = this.fixture.target;
    if (!target.alive || target.child.killed) return { restored: false, reason: 'target_exited' };
    await this.fixture.control(target, 'reloadMode', { value: 'normal' });
    const config = JSON.parse(fs.readFileSync(target.configFile));
    await this.act('set_config', { instanceId: target.instanceId, expectedRevision: config.revision, setting: this.fixture.spec.initialSetting }, 'cleanup');
    await this.act('reload', { instanceId: target.instanceId, expectedRevision: config.revision + 1 }, 'cleanup');
    const response = await fetch(`${target.url}/state`, { signal: AbortSignal.timeout(300), redirect: 'error' });
    if (!response.ok) throw new Error('Restore probe unavailable');
    const state = await response.json();
    if (state.instanceId !== target.instanceId || state.setting !== this.fixture.spec.initialSetting || state.loadedRevision !== config.revision + 1) throw new Error('Restore effect check failed');
    return { restored: true, instanceId: target.instanceId, setting: state.setting, revision: state.loadedRevision };
  }
  async close() {
    for (const item of this.commands) item.child.kill('SIGTERM');
    await Promise.all([...this.commands].map((item) => item.closed));
    await this.tail;
  }
}
