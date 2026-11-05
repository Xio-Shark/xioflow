import fs from 'node:fs';
import path from 'node:path';

const registryPath = path.resolve('spec/isa-v1/registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const generatedOpcodeSource = fs.readFileSync(path.resolve('src/isa/opcodes.generated.ts'), 'utf8');

const requiredFields = [
  'op',
  'version',
  'inputSchema',
  'outputSchema',
  'requiredCapabilities',
  'atomicity',
  'observation',
  'idempotency',
  'rollback',
  'resourceCost',
  'drivers',
];
const schemaDocuments = new Map([
  ['instruction.schema.json', JSON.parse(fs.readFileSync(path.resolve('spec/isa-v1/instruction.schema.json'), 'utf8'))],
  ['result.schema.json', JSON.parse(fs.readFileSync(path.resolve('spec/isa-v1/result.schema.json'), 'utf8'))],
]);
const programSchema = JSON.parse(fs.readFileSync(path.resolve('spec/isa-v1/program.schema.json'), 'utf8'));
const expectedOps = [
  'fs.read',
  'fs.write',
  'fs.patch',
  'fs.move',
  'fs.delete',
  'fs.stat',
  'workspace.snapshot',
  'workspace.diff',
  'workspace.commit',
  'workspace.rollback',
  'proc.spawn',
  'proc.wait',
  'proc.signal',
  'proc.inspect',
  'observe.files',
  'observe.resources',
  'control.status',
  'control.health',
  'control.cancel',
  'control.resolve',
  'control.resume',
  'artifact.put',
  'artifact.get',
  'artifact.stream',
];

if (registry.registrySchema !== 'xio/isa-registry/1') {
  throw new Error(`unexpected registry schema: ${registry.registrySchema}`);
}
if (registry.isa !== 'xio/1') throw new Error(`unexpected ISA: ${registry.isa}`);
if (registry.registryVersion !== '1.0') throw new Error(`unexpected registry version: ${registry.registryVersion}`);
if (registry.sourceOfTruth !== true) throw new Error('registry must declare sourceOfTruth=true');
if (!Array.isArray(registry.opcodes)) throw new Error('registry.opcodes must be an array');
if (programSchema.$id !== 'xio://schema/isa-v1/program') throw new Error('program schema id is not v1');
if (!programSchema.properties?.instructions?.items?.$ref?.endsWith('/instruction')) {
  throw new Error('program schema must reference instruction schema');
}

const seen = new Set();
const seenInputSchemas = new Set();
for (const opcode of registry.opcodes) {
  for (const field of requiredFields) {
    if (!(field in opcode)) throw new Error(`${opcode.op ?? '<unknown>'}: missing ${field}`);
  }
  if (seen.has(opcode.op)) throw new Error(`duplicate opcode: ${opcode.op}`);
  seen.add(opcode.op);
  if (!/^1\.0$/.test(opcode.version)) throw new Error(`${opcode.op}: unsupported opcode version ${opcode.version}`);
  for (const [kind, ref] of [['input', opcode.inputSchema], ['output', opcode.outputSchema]]) {
    const match = /^\.\/(instruction|result)\.schema\.json#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/.exec(ref);
    if (!match) throw new Error(`${opcode.op}: invalid ${kind} schema reference ${ref}`);
    const document = schemaDocuments.get(`${match[1]}.schema.json`);
    if (!document?.$defs?.[match[2]]) {
      throw new Error(`${opcode.op}: ${kind} schema definition does not exist: ${ref}`);
    }
    if (kind === 'input') {
      if (seenInputSchemas.has(ref)) throw new Error(`duplicate input schema reference: ${ref}`);
      seenInputSchemas.add(ref);
    }
  }
  for (const field of ['requiredCapabilities', 'resourceCost', 'drivers']) {
    if (!Array.isArray(opcode[field]) || opcode[field].length === 0) {
      throw new Error(`${opcode.op}: ${field} must be a non-empty array`);
    }
  }
}

const actualOps = [...seen];
if (actualOps.length !== expectedOps.length || actualOps.some((op) => !expectedOps.includes(op))) {
  throw new Error(`opcode catalog mismatch: expected ${expectedOps.length}, got ${actualOps.length}`);
}
const generatedOpcodeMatch = /ISA_V1_OPCODES = (\[[\s\S]*?\]) as const/u.exec(generatedOpcodeSource);
if (!generatedOpcodeMatch) throw new Error('generated opcode source is missing ISA_V1_OPCODES');
const generatedOps = JSON.parse(generatedOpcodeMatch[1]);
if (JSON.stringify(generatedOps) !== JSON.stringify(actualOps)) throw new Error('generated opcode types drifted from registry');
const instructionSchema = schemaDocuments.get('instruction.schema.json');
const instructionOps = instructionSchema?.properties?.op?.enum;
if (!Array.isArray(instructionOps) || instructionOps.length !== expectedOps.length || instructionOps.some((op) => !expectedOps.includes(op))) {
  throw new Error('instruction schema opcode enum drifted from registry');
}
console.log(`ISA registry check: PASS (${actualOps.length} opcodes)`);
