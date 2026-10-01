import fs from 'node:fs';
import path from 'node:path';

// Claude Code. Only the Bash tool is pre-approved (no blanket permission bypass); telemetry, the updater and
// other non-essential traffic are switched off so the only network peer is the local endpoint.
function environment({ home, baseUrl }) {
  return {
    ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'dummy', CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}
function flags({ home, mcp }) {
  const base = ['--output-format', 'json', '--allowedTools', 'Bash'];
  if (!mcp) return base;
  const config = path.join(home, 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args } } }));
  return [...base, '--mcp-config', config, '--strict-mcp-config'];
}

export default {
  name: 'claude',
  bin: 'claude',
  versionArgs: ['--version'],
  launch: (ctx) => ({ args: ['-p', ctx.prompt, ...flags(ctx)], env: environment(ctx) }),
  resume: (ctx) => ({ args: ['-p', ctx.prompt, '--continue', ...flags(ctx)], env: environment(ctx) }),
};
