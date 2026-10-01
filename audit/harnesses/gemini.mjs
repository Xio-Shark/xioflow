import fs from 'node:fs';
import path from 'node:path';

// Gemini CLI. 0.46 maps GOOGLE_GEMINI_BASE_URL to auth type "gateway", which headless validation rejects
// ("Invalid auth method selected.", exit 41). Pinning the auth type in settings keeps the base URL override.
function configure({ home, baseUrl, mcp }) {
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini/settings.json'), JSON.stringify({
    security: { auth: { selectedType: 'gemini-api-key' } },
    ...(mcp ? { mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args, trust: true } } } : {}),
  }));
  return { GEMINI_API_KEY: 'dummy', GOOGLE_GEMINI_BASE_URL: baseUrl };
}
const flags = ['--approval-mode', 'yolo', '-o', 'json', '--skip-trust'];

export default {
  name: 'gemini',
  bin: 'gemini',
  versionArgs: ['--version'],
  launch: (ctx) => ({ args: ['-p', ctx.prompt, ...flags], env: configure(ctx) }),
  resume: (ctx) => ({ args: ['--resume', 'latest', '-p', ctx.prompt, ...flags], env: configure(ctx) }),
};
