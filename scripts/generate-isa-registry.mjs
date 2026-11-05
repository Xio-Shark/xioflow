import fs from 'node:fs';
import path from 'node:path';

const registryPath = path.resolve('spec/isa-v1/registry.json');
const outputPath = path.resolve('src/isa/registry.generated.ts');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
if (!Array.isArray(registry.opcodes) || registry.opcodes.some((entry) => typeof entry?.op !== 'string')) {
  throw new Error('registry.opcodes must contain opcode entries');
}
const entries = Object.fromEntries(registry.opcodes.map((entry) => {
  const { op, ...metadata } = entry;
  return [op, metadata];
}));

const source = `/** Generated from spec/isa-v1/registry.json. Do not edit by hand. */\nimport type { Opcode } from './opcodes.generated.js';\n\nexport const ISA_V1_REGISTRY = ${JSON.stringify(entries, null, 2)} as const;\n\nexport type OpcodeMetadata = (typeof ISA_V1_REGISTRY)[Opcode];\n`;
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, source);
console.log(`ISA registry metadata generated: ${Object.keys(entries).length} opcodes`);
