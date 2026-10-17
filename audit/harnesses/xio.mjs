import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const rlFix = path.join(home, 'xf-rl-fix.mjs');
  fs.writeFileSync(rlFix, [
    "import readline from 'node:readline';",
    "import readlinePromises from 'node:readline/promises';",
    "if (process.argv[1] && (process.argv[1].includes('xiocode') || process.argv[1].endsWith('/xio'))) {",
    "  Object.defineProperty(process.stdin, 'isTTY', { value: 1, configurable: true });",
    "  Object.defineProperty(process.stdout, 'isTTY', { value: 1, configurable: true });",
    '  let primary = null;',
    '  const origPQuestion = readlinePromises.Interface.prototype.question;',
    '  readlinePromises.Interface.prototype.question = function (...args) {',
    '    if (!primary) primary = this;',
    '    return origPQuestion.apply(primary, args);',
    '  };',
    '  const origClose = readline.Interface.prototype.close;',
    '  readline.Interface.prototype.close = function (...args) {',
    '    if (primary && this !== primary) return this;',
    '    primary = null;',
    '    return origClose.apply(this, args);',
    '  };',
    '}',
  ].join('\n'));
  return {
    XIO_HOME: path.join(home, '.xiocode'),
    XIO_CONFIG: config,
    MOCK_API_KEY: 'dummy',
    XIO_NO_UPDATE_CHECK: '1',
    NODE_OPTIONS: `--import ${pathToFileURL(rlFix).href}`,
  };
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
      const ynMatch = /\[y\/N\] /.exec(rest);
      const selectMatch = /Select number: /.exec(rest);
      const approval = ynMatch && (!selectMatch || ynMatch.index < selectMatch.index)
        ? { index: ynMatch.index, len: ynMatch[0].length, reply: 'y\n' }
        : selectMatch
          ? { index: selectMatch.index, len: selectMatch[0].length, reply: '1\n' }
          : null;
      if (ready < 0 && !approval) return;
      if (approval && (ready < 0 || approval.index < ready)) {
        cursor += approval.index + approval.len;
        write(approval.reply);
      } else {
        cursor += ready + 5;
        write(prompted ? '/exit\n' : `${prompt}\n`);
        prompted = true;
      }
    }
  });
}

const localXio = path.resolve(import.meta.dirname, '../../../xiocode/bin/xio');

export default {
  name: 'xio',
  bin: fs.existsSync(localXio) ? localXio : 'xio',
  versionArgs: ['--version'],
  variants: {
    reaper: { XIOCODE_KERNEL_DRIVER: 'reaper' },
    node: { XIOCODE_KERNEL_DRIVER: 'node' },
    builtin: { XIOCODE_PROCESS_KERNEL: '0' },
  },
  launch: (ctx) => ({ args: [], env: configure(ctx), interact }),
  resume: (ctx) => ({ args: ['--continue'], env: configure(ctx), interact }),
};
