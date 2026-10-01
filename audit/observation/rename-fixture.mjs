import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function createRenameFixture(root, scenario) {
  if (!['comment', 'new-caller'].includes(scenario)) throw new Error('Unknown rename scenario');
  fs.writeFileSync(path.join(root, 'util.mjs'), 'export function foo(n) { return n * 2; }\n');
  fs.writeFileSync(path.join(root, 'caller.mjs'), "import { foo } from './util.mjs';\nconsole.log(foo(3));\n");
  fs.writeFileSync(path.join(root, 'worker.mjs'), "import { foo } from './util.mjs';\nexport function run(n) { return foo(n) + 1; }\n");
  if (scenario === 'new-caller') {
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(root, `extra-${i}.mjs`),
      `import { foo } from './util.mjs';\nexport function compute(n) { return foo(n) + ${i}; }\n`);
  }
}

export function applyCompetingChange(root, scenario) {
  if (scenario === 'comment') {
    const caller = path.join(root, 'caller.mjs');
    fs.writeFileSync(caller, `// concurrent agent comment\n${fs.readFileSync(caller, 'utf8')}`);
  } else if (scenario === 'new-caller') {
    fs.writeFileSync(path.join(root, 'new-caller.mjs'),
      "// Added concurrently; preserve this module.\nimport { foo } from './util.mjs';\nexport function late(n) { return foo(n) + 100; }\n");
  } else throw new Error('Unknown rename scenario');
}

/** Hidden executable checks, not supplied to the model as source. */
export function checkRenameFixture(workspace, scenario, home) {
  const modules = [{ file: 'worker.mjs', symbol: 'run', offset: 1 }];
  if (scenario === 'new-caller') {
    for (let i = 1; i <= 5; i++) modules.push({ file: `extra-${i}.mjs`, symbol: 'compute', offset: i });
    modules.push({ file: 'new-caller.mjs', symbol: 'late', offset: 100 });
  } else if (scenario !== 'comment') throw new Error('Unknown rename scenario');
  const url = (file) => JSON.stringify(pathToFileURL(path.join(workspace, file)).href);
  const script = `const u=await import(${url('util.mjs')}); if(typeof u.bar!=='function'||'foo' in u) throw Error('rename missing');
    for(const n of [0,-2,5]) if(u.bar(n)!==n*2) throw Error('export behavior changed');
    ${modules.map(({ file, symbol, offset }) => `{ const m=await import(${url(file)}); for(const n of [0,-2,5]) if(m[${JSON.stringify(symbol)}](n)!==n*2+${offset}) throw Error('caller behavior changed'); }`).join('\n')}`;
  const options = { encoding: 'utf8', timeout: 5000, env: { HOME: home, PATH: path.dirname(process.execPath) } };
  const checked = spawnSync(process.execPath, ['--input-type=module', '-e', script], options);
  const caller = spawnSync(process.execPath, [path.join(workspace, 'caller.mjs')], options);
  const names = fs.readdirSync(workspace).filter((name) => name !== '.git').sort();
  const expected = ['util.mjs', 'caller.mjs', ...modules.map(({ file }) => file)].sort();
  const markerFile = scenario === 'comment' ? 'caller.mjs' : 'new-caller.mjs';
  const marker = scenario === 'comment' ? '// concurrent agent comment' : '// Added concurrently; preserve this module.';
  const preserved = fs.existsSync(path.join(workspace, markerFile)) && fs.readFileSync(path.join(workspace, markerFile), 'utf8').includes(marker);
  return { passed: checked.status === 0 && caller.status === 0 && caller.stdout === '6\n'
    && JSON.stringify(names) === JSON.stringify(expected) && preserved,
    modulesExit: checked.status, callerExit: caller.status, expectedModules: modules.length + 1, competingChangePreserved: preserved };
}
