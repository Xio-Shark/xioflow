import fs from 'node:fs';
import path from 'node:path';

// Codex CLI. `codex exec` never prompts; its default sandbox is read-only, so the audit runs it with
// workspace-write (writes allowed in the cwd and the temp dir, which is where the fixture's run dir lives).
// The sandbox mode goes through -c because `codex exec resume` does not accept -s.
const tomlString = (value) => JSON.stringify(value);

function common({ home, baseUrl, mcp }) {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return {
    flags: [
      '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"',
      ...(mcp ? ['-c', `mcp_servers.${mcp.name}={ command = ${tomlString(mcp.command)}, args = [${mcp.args.map(tomlString).join(', ')}] }`] : []),
      '-c', `model_providers.mock={ name = "mock", base_url = "${baseUrl}/v1", wire_api = "responses" }`,
      '-c', 'model_provider="mock"', '-m', 'mock-1',
      // Keep the local endpoint the only network peer: no Statsig metrics, no feedback flow, no update check.
      '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'check_for_update_on_startup=false',
    ],
    env: { CODEX_HOME: path.join(home, '.codex') },
  };
}

export default {
  name: 'codex',
  bin: 'codex',
  versionArgs: ['--version'],
  launch(ctx) {
    const { flags, env } = common(ctx);
    return { args: ['exec', ...flags, ctx.prompt], env };
  },
  resume(ctx) {
    const { flags, env } = common(ctx);
    return { args: ['exec', 'resume', '--last', ...flags, ctx.prompt], env };
  },
};
