import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [directory, instanceId, name, environment] = process.argv.slice(2);
if (!directory || !instanceId || !process.send) throw new Error('Fixture service requires an owned IPC channel');
const configFile = path.join(directory, `${instanceId}.config.json`);
const stateFile = path.join(directory, `${instanceId}.state.json`);
const logFile = path.join(directory, `${instanceId}.log`);
let loaded = JSON.parse(fs.readFileSync(configFile));
let ready = false;
let unavailable = false;
let reloadMode = 'normal';
const startedAt = Date.now();
let changedAt = startedAt;
const state = () => ({ instanceId, name, environment, pid: process.pid, startedAt,
  ready, loadedRevision: loaded.revision, setting: loaded.setting, changedAt });
const publish = () => {
  changedAt = Date.now();
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state()));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
};
const log = (message) => fs.appendFileSync(logFile, `${Date.now()} ${message}\n`);
const server = http.createServer((request, response) => {
  if (!['/state', '/ready'].includes(request.url)) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', 'application/json');
  response.setHeader('connection', 'close');
  if (unavailable) { response.writeHead(503).end(JSON.stringify({ error: 'probe_unavailable' })); return; }
  response.writeHead(request.url === '/ready' && !ready ? 503 : 200).end(JSON.stringify(state()));
});
let closing = false;
const lifetime = setTimeout(() => close(70), 240000);
function close(code = 0) {
  if (closing) return;
  closing = true;
  clearTimeout(lifetime);
  server.close(() => process.exit(code));
  server.closeAllConnections();
  const forced = setTimeout(() => process.exit(code), 500);
  forced.unref();
}
process.on('disconnect', () => close());
process.on('SIGTERM', () => close());
process.on('SIGINT', () => close());
process.on('message', ({ id, op, args = {} }) => {
  try {
    if (op === 'ready') { ready = args.value; log(`ready=${ready}`); publish(); }
    else if (op === 'unavailable') { unavailable = args.value; publish(); }
    else if (op === 'reloadMode') reloadMode = args.value;
    else if (op === 'reload') {
      if (reloadMode === 'reject') throw new Error('reload_rejected');
      if (reloadMode !== 'noop') { loaded = JSON.parse(fs.readFileSync(configFile)); publish(); }
      log(`reload accepted ${loaded.revision}`);
    } else if (op === 'log') log(args.message);
    else if (op === 'noise') fs.appendFileSync(path.join(directory, 'noise.log'), '.');
    else if (op === 'exit') { close(args.code ?? 0); return; }
    else throw new Error('unsupported_control');
    process.send?.({ id, ok: true, state: state(), at: Date.now() });
  } catch (error) { process.send?.({ id, ok: false, error: error.message }); }
});
server.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exit(71); });
server.listen(0, '127.0.0.1', () => {
  publish();
  log('process listening');
  process.send({ type: 'listening', port: server.address().port, state: state() });
});
