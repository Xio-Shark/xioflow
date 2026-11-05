import fs from 'node:fs';
import path from 'node:path';

const registryPath = path.resolve('spec/isa-v1/registry.json');
const outputPath = path.resolve('src/isa/opcodes.generated.ts');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
if (!Array.isArray(registry.opcodes) || registry.opcodes.some((entry) => typeof entry?.op !== 'string')) {
  throw new Error('registry.opcodes must contain opcode names');
}
const opcodes = registry.opcodes.map((entry) => entry.op);
if (new Set(opcodes).size !== opcodes.length) throw new Error('registry contains duplicate opcodes');

const source = `/** Generated from spec/isa-v1/registry.json. Do not edit by hand. */\nexport const ISA_V1_OPCODES = ${JSON.stringify(opcodes, null, 2)} as const;\n\nexport type Opcode = typeof ISA_V1_OPCODES[number];\n`;
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, source);
console.log(`ISA opcode types generated: ${opcodes.length} opcodes`);
