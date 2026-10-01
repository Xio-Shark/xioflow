import fs from 'node:fs';
import path from 'node:path';

// opencode. --standalone keeps it off the user's background service; XDG_* move every data dir into the sandbox.
function configure({ home, baseUrl, mcp }) {
  const config = path.join(home, 'opencode.json');
  fs.writeFileSync(config, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'mock', options: { baseURL: `${baseUrl}/v1`, apiKey: 'dummy' }, models: { 'mock-1': { name: 'mock-1' } } } },
    ...(mcp ? { mcp: { [mcp.name]: { type: 'local', command: [mcp.command, ...mcp.args], enabled: true } } } : {}),
  }, null, 2));
  return {
    OPENCODE_CONFIG: config,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'),
  };
}
const flags = ['--standalone', '--auto', '--format', 'json', '-m', 'mock/mock-1'];

export default {
  name: 'opencode',
  bin: 'opencode',
  versionArgs: ['--version'],
  launch: (ctx) => ({ args: ['run', ...flags, ctx.prompt], env: configure(ctx) }),
  resume: (ctx) => ({ args: ['run', ...flags, '--continue', ctx.prompt], env: configure(ctx) }),
};
