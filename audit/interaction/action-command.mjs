// A real CLI transport; permissions and version checks remain in the broker.
try {
  const [command, ...rest] = process.argv.slice(2);
  const operations = { 'config-set': 'set_config', 'config-reload': 'reload' };
  if (!operations[command] || rest.length % 2) throw new Error('Use config-set/config-reload and named option pairs');
  const names = { '--instance': 'instanceId', '--expected-revision': 'expectedRevision', '--setting': 'setting' };
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = names[rest[i]];
    if (!name || Object.hasOwn(args, name)) throw new Error('Unknown or duplicate option');
    args[name] = name === 'instanceId' ? rest[i + 1] : Number(rest[i + 1]);
  }
  if (!process.send) throw new Error('Owned broker IPC required');
  process.once('message', (response) => {
    process.stdout.write(`${JSON.stringify(response)}\n`, () => process.exit(0));
  });
  process.on('disconnect', () => process.exit(72));
  process.send({ op: operations[command], args });
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: { code: 'command_usage', message: error.message } })}\n`, () => process.exit(2));
}
