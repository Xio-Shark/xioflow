import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('spec/isa-v1');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const capability = readJson('capability.schema.json');
const instruction = readJson('instruction.schema.json');
const program = readJson('program.schema.json');
const result = readJson('result.schema.json');

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

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertStrictObject = (schema, label) => {
  assert(schema?.type === 'object', `${label}: root type must be object`);
  assert(schema?.additionalProperties === false, `${label}: unknown fields must be rejected`);
};

assert(capability.$id === 'xio://schema/isa-v1/capability', 'capability: unexpected $id');
assert(instruction.$id === 'xio://schema/isa-v1/instruction', 'instruction: unexpected $id');
assert(program.$id === 'xio://schema/isa-v1/program', 'program: unexpected $id');
assert(result.$id === 'xio://schema/isa-v1/result', 'result: unexpected $id');

assertStrictObject(capability, 'capability');
assertStrictObject(instruction, 'instruction');
assertStrictObject(program, 'program');
assertStrictObject(result, 'result');

const requiredCapabilityFields = ['id', 'issuer', 'policyVersion', 'reason', 'scope', 'limits', 'expiresAt', 'epoch'];
assert(JSON.stringify(capability.required) === JSON.stringify(requiredCapabilityFields), 'capability: required fields drifted');
assertStrictObject(capability.$defs.CapabilityScope, 'capability.scope');
assertStrictObject(capability.$defs.CapabilityLimits, 'capability.limits');
assert(capability.$defs.CapabilityScope.required.join(',') === 'opcodes,workspaces,paths,secrets', 'capability.scope: required fields drifted');
assert(capability.$defs.CapabilityLimits.required.join(',') === 'cpuMs,memoryBytes,outputBytes,concurrentOps,processes', 'capability.limits: required fields drifted');

const requiredInstructionFields = ['id', 'op', 'args', 'dependsOn', 'precondition', 'output'];
assert(JSON.stringify(instruction.required) === JSON.stringify(requiredInstructionFields), 'instruction: required fields drifted');
assert(instruction.properties.dependsOn.maxItems === 64, 'instruction.dependsOn: maxItems must be 64');
assert(instruction.properties.precondition.maxItems === 64, 'instruction.precondition: maxItems must be 64');
assert(instruction.properties.dependsOn.uniqueItems === true, 'instruction.dependsOn: duplicate dependencies must be rejected');
assert(instruction.properties.opId.$ref === '#/$defs/OperationId', 'instruction.opId: must use OperationId');
assert(instruction.$defs.OperationId.pattern === '^op:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$', 'instruction.opId: invalid pattern');
assert(instruction.$defs.OutputRef.pattern === '^[A-Za-z][A-Za-z0-9._:-]{0,127}$', 'instruction.output: invalid pattern');
assert(instruction.allOf.length === expectedOps.length, 'instruction: one op-to-args mapping is required per opcode');

const actualInstructionOps = instruction.properties.op.enum;
assert(JSON.stringify(actualInstructionOps) === JSON.stringify(expectedOps), 'instruction.op enum drifted');
const argDefs = instruction.properties.args.oneOf.map((entry) => entry.$ref?.split('/').pop());
assert(argDefs.length === expectedOps.length && new Set(argDefs).size === expectedOps.length, 'instruction.args: each opcode needs one unique args definition');
for (const name of argDefs) {
  assertStrictObject(instruction.$defs[name], `instruction.$defs.${name}`);
}

const requiredProgramFields = ['isa', 'requestId', 'programId', 'mode', 'instructions'];
assert(JSON.stringify(program.required) === JSON.stringify(requiredProgramFields), 'program: required fields drifted');
assert(program.properties.instructions.maxItems === 256, 'program.instructions: maxItems must be 256');
assert(program.properties.instructions.items.$ref === 'xio://schema/isa-v1/instruction', 'program.instructions: must reference instruction schema');
assert(program.$defs.ExecutionOptions.additionalProperties === false, 'program.options: unknown fields must be rejected');
assert(program.xioLimits?.maxJsonBytes === 10485760, 'program limits: maxJsonBytes drifted');
assert(program.xioLimits?.maxInstructionCount === 256, 'program limits: maxInstructionCount drifted');
assert(program.xioLimits?.maxDependencyCount === 64, 'program limits: maxDependencyCount drifted');
assert(program.xioLimits?.maxPreconditionCount === 64, 'program limits: maxPreconditionCount drifted');
assert(program.xioLimits?.maxArtifactReferenceCount === 1024, 'program limits: maxArtifactReferenceCount drifted');
assert(program.xioLimits?.maxNestingDepth === 32, 'program limits: maxNestingDepth drifted');

const requiredResultFields = ['isa', 'requestId', 'status', 'results', 'events'];
assert(JSON.stringify(result.required) === JSON.stringify(requiredResultFields), 'result: required fields drifted');
assert(result.properties.results.maxItems === 256, 'result.results: maxItems must be 256');
assert(result.$defs.InstructionResult.required.includes('artifactRefs'), 'result.instruction: artifactRefs is required');
assert(result.$defs.InstructionResult.properties.artifactRefs?.items?.$ref?.includes('ArtifactRef'), 'result.instruction: artifactRefs must use ArtifactRef');
const indeterminateRule = result.$defs.InstructionResult.allOf?.find((rule) => rule.if?.properties?.status?.const === 'indeterminate');
assert(indeterminateRule, 'result: indeterminate rule is missing');
assert(JSON.stringify(indeterminateRule.then.required) === JSON.stringify(['lease', 'possibleEffects', 'nextActions']), 'result: indeterminate evidence requirements drifted');
for (const name of ['Observation', 'Effects', 'Replay', 'Rollback', 'InstructionResult', 'EventPage']) {
  assertStrictObject(result.$defs[name], `result.$defs.${name}`);
}

console.log('ISA schema check: PASS (capability, instruction, program, result)');
