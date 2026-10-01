import fs from 'node:fs';
import path from 'node:path';

// Qwen Code (a Gemini CLI fork that also speaks OpenAI Chat Completions). It is not installed globally here:
// XF_QWEN_BIN points at an isolated install (`npm install --prefix <dir> @qwen-code/qwen-code`).
function configure({ home, baseUrl, mcp }) {
  fs.mkdirSync(path.join(home, '.qwen'), { recursive: true });
  fs.writeFileSync(path.join(home, '.qwen/settings.json'), JSON.stringify({
    security: { auth: { selectedType: 'openai' } },
    ...(mcp ? { mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args, trust: true } } } : {}),
  }));
  return { OPENAI_API_KEY: 'dummy', OPENAI_BASE_URL: `${baseUrl}/v1`, OPENAI_MODEL: 'mock-1' };
}
const flags = ['--approval-mode', 'yolo'];

export default {
  name: 'qwen',
  bin: process.env.XF_QWEN_BIN ?? 'qwen',
  versionArgs: ['--version'],
  launch: (ctx) => ({ args: ['-p', ctx.prompt, ...flags], env: configure(ctx) }),
  resume: (ctx) => ({ args: ['--continue', '-p', ctx.prompt, ...flags], env: configure(ctx) }),
};
