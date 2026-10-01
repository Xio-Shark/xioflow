import baseline from './baseline.mjs';
import pipeHold from './pipe-hold.mjs';
import orphanAtExit from './orphan-at-exit.mjs';
import unconfirmedStop from './unconfirmed-stop.mjs';
import killMidTool from './kill-mid-tool.mjs';
import killBeforeReport from './kill-before-report.mjs';
import outputFlood from './output-flood.mjs';
import cancelTree from './cancel-tree.mjs';
import { mcpOrphanExit, mcpOrphanKill } from './mcp-orphan.mjs';
import spawnFailure from './spawn-failure.mjs';

export const SCENARIOS = Object.fromEntries([
  baseline, pipeHold, orphanAtExit, unconfirmedStop, killMidTool, killBeforeReport, outputFlood, cancelTree,
  mcpOrphanExit, mcpOrphanKill, spawnFailure,
].map((s) => [s.name, s]));
