import fs from 'node:fs';
import readline from 'node:readline';
import { taskDefinitions } from './task-cases.mjs';
import { ARMS } from './task-host.mjs';
import { TaskEpisode } from './task-episode.mjs';

const args = process.argv.slice(2);
if (args[0] === '--list' && args.length <= 2) {
  console.log(JSON.stringify(taskDefinitions(args[1] ?? 'dev').map((task) => task.publicTask), null, 2));
} else if (args.length < 2 || !ARMS.includes(args[1]) ||
    !(args.length === 2 || (args.length === 4 && args[2] === '--trace'))) {
  console.error('Usage: node audit/interaction/task-session.mjs TASK_ID full|jq|structured [--trace NEW_FILE]\n       node audit/interaction/task-session.mjs --list [dev|heldout]');
  process.exitCode = 2;
} else {
  const episode = new TaskEpisode(args[0], args[1]);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    console.log(JSON.stringify(episode.ready));
    for await (const line of lines) {
      console.log(JSON.stringify(episode.handleLine(line)));
      if (episode.finished) break;
    }
  } finally {
    lines.close();
    episode.close();
    if (args[3]) fs.writeFileSync(args[3], `${JSON.stringify(episode.trace, null, 2)}\n`, { flag: 'wx' });
  }
  process.exitCode = episode.verdict?.passed ? 0 : 1;
}
