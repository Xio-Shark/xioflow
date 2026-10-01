import fs from 'node:fs';
import path from 'node:path';

// xiocode. Execution layer is selected by environment (see variants): the kernel with the reaper driver
// (default), the kernel with the node driver, or the built-in supervisor.
function configure({ home, baseUrl, mcp }) {
  const config = path.join(home, 'xio-config.toml');
  fs.writeFileSync(config, [
    '[general]', 'default_provider = "mock"', 'default_model = "mock-1"', '',
    '[providers.mock]', 'kind = "openai"', `base_url = "${baseUrl}/v1"`, 'model = "mock-1"', 'api_key_env = "MOCK_API_KEY"', '',
    // A non-interactive session treats an unknown directory as untrusted and blocks bash, and bash itself
    // counts as a high-risk tool that needs explicit permission when nobody can answer a prompt.
    '[trust]', 'mode = "trust"', '',
    '[permissions]', 'allow_high_risk = true', '',
    ...(mcp ? [`[mcp.servers.${mcp.name}]`, `command = ${JSON.stringify(mcp.command)}`, `args = [${mcp.args.map((a) => JSON.stringify(a)).join(', ')}]`, ''] : []),
  ].join('\n'));
  return { XIO_HOME: path.join(home, '.xiocode'), XIO_CONFIG: config, MOCK_API_KEY: 'dummy', XIO_NO_UPDATE_CHECK: '1' };
}

// `xio -p` is a non-interactive session: it only auto-runs a four-command allowlist (pwd, true, false, ls) and
// refuses every other shell command, with no flag to lift that. The audit therefore drives the line REPL
// (what `xio` falls back to without a TTY) over a pipe and answers its one-time approval prompts.
function interact({ prompt, write, onOutput }) {
  let cursor = 0;
  let prompted = false;
  onOutput((text) => {
    for (;;) {
      const rest = text.slice(cursor);
      const ready = rest.indexOf('xio> ');
      const approval = rest.search(/\[y\/N\] /);
      if (ready < 0 && approval < 0) return;
      if (approval >= 0 && (ready < 0 || approval < ready)) {
        cursor += approval + 6;
        write('y\n');
      } else {
        cursor += ready + 5;
        write(prompted ? '/exit\n' : `${prompt}\n`);
        prompted = true;
      }
    }
  });
}

export default {
  name: 'xio',
  bin: 'xio',
  versionArgs: ['--version'],
  variants: {
    reaper: { XIOCODE_KERNEL_DRIVER: 'reaper' },
    node: { XIOCODE_KERNEL_DRIVER: 'node' },
    builtin: { XIOCODE_PROCESS_KERNEL: '0' },
  },
  launch: (ctx) => ({ args: [], env: configure(ctx), interact }),
  resume: (ctx) => ({ args: ['--continue'], env: configure(ctx), interact }),
};
