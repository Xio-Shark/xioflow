import { Buffer } from 'node:buffer';
import { encodeJson } from './codec.js';
import { ISA_V1_REGISTRY } from './registry.generated.js';
import { ISA_V1_OPCODES, type Opcode } from './opcodes.generated.js';
import type {
  Capability,
  Instruction,
  IsaVersion,
  JsonObject,
  Program,
} from './types.js';

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const OP_ID_PATTERN = /^op:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const EVENT_CURSOR_PATTERN = /^event:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const ISA_PATTERN = /^xio\/(\d+)(?:\.(\d+))?$/u;
const REF_PATTERNS = {
  capability: /^cap:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
  workspace: /^workspace:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
  artifact: /^artifact:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
  process: /^process:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
  snapshot: /^snapshot:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
  transaction: /^transaction:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
  lease: /^lease:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
  resume: /^resume:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
  secret: /^secret:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
  cursor: /^cursor:[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u,
} as const;

const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_INSTRUCTIONS = 256;
const MAX_DEPENDENCIES = 64;
const MAX_PRECONDITIONS = 64;

const ARG_RULES: Record<Opcode, { required: string[]; allowed: string[] }> = {
  'fs.read': { required: ['path'], allowed: ['workspace', 'path', 'range'] },
  'fs.write': { required: ['path', 'content'], allowed: ['workspace', 'path', 'content', 'expectedHash'] },
  'fs.patch': { required: ['path', 'patch'], allowed: ['workspace', 'path', 'patch', 'expectedHash'] },
  'fs.move': { required: ['from', 'to'], allowed: ['workspace', 'from', 'to'] },
  'fs.delete': { required: ['path'], allowed: ['workspace', 'path', 'recursive'] },
  'fs.stat': { required: ['path'], allowed: ['workspace', 'path'] },
  'workspace.snapshot': { required: ['label'], allowed: ['workspace', 'label', 'roots'] },
  'workspace.diff': { required: ['from'], allowed: ['workspace', 'from', 'to'] },
  'workspace.commit': { required: ['transaction'], allowed: ['workspace', 'transaction'] },
  'workspace.rollback': { required: ['snapshot'], allowed: ['workspace', 'snapshot', 'roots'] },
  'proc.spawn': { required: ['argv', 'cwd', 'stdio'], allowed: ['argv', 'cwd', 'env', 'secretEnv', 'stdio', 'timeoutMs'] },
  'proc.wait': { required: ['process'], allowed: ['process', 'timeoutMs'] },
  'proc.signal': { required: ['process', 'signals'], allowed: ['process', 'signals', 'graceMs'] },
  'proc.inspect': { required: ['process'], allowed: ['process'] },
  'observe.files': { required: ['paths'], allowed: ['workspace', 'paths', 'depth'] },
  'observe.resources': { required: ['process'], allowed: ['process', 'intervalMs'] },
  'control.status': { required: [], allowed: ['program', 'instruction', 'lease'] },
  'control.health': { required: [], allowed: [] },
  'control.cancel': { required: [], allowed: ['program', 'instruction', 'lease', 'graceMs'] },
  'control.resolve': { required: ['lease', 'decision', 'reason'], allowed: ['lease', 'decision', 'reason', 'evidence'] },
  'control.resume': { required: ['resumeToken'], allowed: ['resumeToken'] },
  'artifact.put': { required: ['content'], allowed: ['content', 'mediaType', 'sensitivity', 'ttlMs'] },
  'artifact.get': { required: ['artifact'], allowed: ['artifact', 'range'] },
  'artifact.stream': { required: ['artifact'], allowed: ['artifact', 'cursor', 'maxBytes'] },
};

const PROGRAM_KEYS = ['isa', 'requestId', 'programId', 'mode', 'capability', 'workspace', 'instructions', 'options'];
const INSTRUCTION_KEYS = ['id', 'op', 'args', 'dependsOn', 'precondition', 'output', 'opId'];
const OPTIONS_KEYS = ['wait', 'maxOutputBytes', 'eventCursor'];

export type ValidationIssueCode =
  | 'invalid_type'
  | 'missing_field'
  | 'unknown_field'
  | 'invalid_value'
  | 'invalid_json'
  | 'unsupported_isa_minor'
  | 'unsupported_opcode'
  | 'duplicate_id'
  | 'duplicate_output'
  | 'duplicate_op_id'
  | 'unknown_reference'
  | 'dependency_cycle'
  | 'capability_missing'
  | 'capability_denied'
  | 'capability_expired'
  | 'resource_exceeded'
  | 'payload_too_large';

export interface ValidationIssue {
  code: ValidationIssueCode;
  path: string;
  message: string;
}

export interface ResourceEstimate {
  instructionCount: number;
  costCounts: Record<string, number>;
  resourceCost: string[];
  requiredCapabilities: string[];
  externalInstructionIds: string[];
  requiresOpId: string[];
}

export interface ValidationPlan {
  negotiatedIsa: IsaVersion;
  instructions: Array<{ id: string; op: Opcode; atomicity: string; observation: string; drivers: string[] }>;
  dependencies: Record<string, string[]>;
  resources: ResourceEstimate;
  capabilityPrecheck: 'complete' | 'partial' | 'not_requested';
}

export interface ValidateProgramOptions {
  supportedIsa?: readonly IsaVersion[];
  capability?: Capability;
  availableCapabilities?: Iterable<string>;
  now?: Date;
  requireCapability?: boolean;
}

export interface ProgramValidationSuccess {
  ok: true;
  program: Program;
  plan: ValidationPlan;
}

export interface ProgramValidationFailure {
  ok: false;
  issues: ValidationIssue[];
}

export type ProgramValidationResult = ProgramValidationSuccess | ProgramValidationFailure;

export class ProgramValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('; '));
    this.name = 'ProgramValidationError';
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addIssue(issues: ValidationIssue[], code: ValidationIssueCode, path: string, message: string): void {
  issues.push({ code, path, message });
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) addIssue(issues, 'unknown_field', `${path}.${key}`, 'unknown field is not permitted');
  }
}

function required(value: Record<string, unknown>, keys: readonly string[], path: string, issues: ValidationIssue[]): void {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) addIssue(issues, 'missing_field', `${path}.${key}`, 'required field is missing');
  }
}

function stringField(value: unknown, path: string, issues: ValidationIssue[], pattern?: RegExp): value is string {
  if (typeof value !== 'string') {
    addIssue(issues, 'invalid_type', path, 'must be a string');
    return false;
  }
  if (pattern && !pattern.test(value)) addIssue(issues, 'invalid_value', path, 'does not match the required pattern');
  return true;
}

function integerField(value: unknown, path: string, issues: ValidationIssue[], minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    addIssue(issues, 'invalid_type', path, 'must be a safe integer');
    return false;
  }
  if (value < minimum || value > maximum) addIssue(issues, 'invalid_value', path, `must be between ${minimum} and ${maximum}`);
  return true;
}

function refField(value: unknown, path: string, issues: ValidationIssue[], kind: keyof typeof REF_PATTERNS): value is string {
  return stringField(value, path, issues, REF_PATTERNS[kind]);
}

function stringArray(value: unknown, path: string, issues: ValidationIssue[], maxItems: number, pattern?: RegExp): value is string[] {
  if (!Array.isArray(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an array');
    return false;
  }
  if (value.length > maxItems) addIssue(issues, 'invalid_value', path, `must contain at most ${maxItems} items`);
  for (let index = 0; index < value.length; index++) stringField(value[index], `${path}[${index}]`, issues, pattern);
  return true;
}

function validateRange(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an object');
    return;
  }
  checkKeys(value, ['start', 'end'], path, issues);
  required(value, ['start', 'end'], path, issues);
  integerField(value.start, `${path}.start`, issues);
  integerField(value.end, `${path}.end`, issues);
}

function validateArgs(op: Opcode, value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an object');
    return;
  }
  const rule = ARG_RULES[op];
  checkKeys(value, rule.allowed, path, issues);
  required(value, rule.required, path, issues);
  const workspace = value.workspace;
  if (workspace !== undefined) refField(workspace, `${path}.workspace`, issues, 'workspace');
  for (const key of ['path', 'from', 'to']) if (value[key] !== undefined) stringField(value[key], `${path}.${key}`, issues);
  if (value.content !== undefined && op !== 'artifact.put') refField(value.content, `${path}.content`, issues, 'artifact');
  for (const key of ['patch', 'artifact']) if (value[key] !== undefined) refField(value[key], `${path}.${key}`, issues, 'artifact');
  for (const key of ['process']) if (value[key] !== undefined) refField(value[key], `${path}.${key}`, issues, 'process');
  for (const key of ['snapshot']) if (value[key] !== undefined) refField(value[key], `${path}.${key}`, issues, 'snapshot');
  for (const key of ['transaction']) if (value[key] !== undefined) refField(value[key], `${path}.${key}`, issues, 'transaction');
  for (const key of ['lease']) if (value[key] !== undefined) refField(value[key], `${path}.${key}`, issues, 'lease');
  if (value.resumeToken !== undefined) refField(value.resumeToken, `${path}.resumeToken`, issues, 'resume');
  if (value.cursor !== undefined) refField(value.cursor, `${path}.cursor`, issues, 'cursor');
  if (value.range !== undefined) validateRange(value.range, `${path}.range`, issues);
  if (value.roots !== undefined) stringArray(value.roots, `${path}.roots`, issues, 64);
  if (value.paths !== undefined) stringArray(value.paths, `${path}.paths`, issues, 64);
  if (value.depth !== undefined) integerField(value.depth, `${path}.depth`, issues, 0, 128);
  if (value.intervalMs !== undefined) integerField(value.intervalMs, `${path}.intervalMs`, issues, 1, 3_600_000);
  for (const key of ['timeoutMs', 'graceMs', 'ttlMs', 'maxBytes']) {
    if (value[key] !== undefined) integerField(value[key], `${path}.${key}`, issues, 0, 315_360_000_000);
  }
  if (value.maxBytes !== undefined) integerField(value.maxBytes, `${path}.maxBytes`, issues, 1, 10 * 1024 * 1024);
  if (value.stdio !== undefined && !['capture', 'inherit', 'ignore', 'stream'].includes(String(value.stdio))) {
    addIssue(issues, 'invalid_value', `${path}.stdio`, 'unsupported stdio mode');
  }
  if (value.argv !== undefined) stringArray(value.argv, `${path}.argv`, issues, 256);
  if (value.signals !== undefined) stringArray(value.signals, `${path}.signals`, issues, 8, /^SIG[A-Z0-9]+$/u);
  if (value.env !== undefined) validateStringMap(value.env, `${path}.env`, issues, 256);
  if (value.secretEnv !== undefined) validateRefMap(value.secretEnv, `${path}.secretEnv`, issues, 'secret', 64);
  if (value.recursive !== undefined && typeof value.recursive !== 'boolean') addIssue(issues, 'invalid_type', `${path}.recursive`, 'must be a boolean');
  if (value.expectedHash !== undefined) stringField(value.expectedHash, `${path}.expectedHash`, issues, /^[A-Fa-f0-9]{64}$/u);
  if (value.label !== undefined) stringField(value.label, `${path}.label`, issues);
  if (value.from !== undefined) stringField(value.from, `${path}.from`, issues);
  if (value.to !== undefined) stringField(value.to, `${path}.to`, issues);
  if (value.revision !== undefined) stringField(value.revision, `${path}.revision`, issues);
  if (value.content !== undefined && op === 'artifact.put') stringField(value.content, `${path}.content`, issues);
  if (value.mediaType !== undefined) stringField(value.mediaType, `${path}.mediaType`, issues);
  if (value.sensitivity !== undefined && !['public', 'internal', 'secret'].includes(String(value.sensitivity))) addIssue(issues, 'invalid_value', `${path}.sensitivity`, 'unsupported sensitivity');
  if (value.decision !== undefined && !['succeeded', 'failed', 'rolled_back', 'partial'].includes(String(value.decision))) addIssue(issues, 'invalid_value', `${path}.decision`, 'unsupported resolution decision');
  for (const key of ['program', 'instruction']) if (value[key] !== undefined) stringField(value[key], `${path}.${key}`, issues);
  if (op === 'control.status' || op === 'control.cancel') {
    if (value.program === undefined && value.instruction === undefined && value.lease === undefined) {
      addIssue(issues, 'missing_field', path, 'one of program, instruction or lease is required');
    }
  }
}

function validateStringMap(value: unknown, path: string, issues: ValidationIssue[], maxProperties: number): void {
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an object');
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > maxProperties) addIssue(issues, 'invalid_value', path, `must contain at most ${maxProperties} entries`);
  for (const key of keys) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(key)) addIssue(issues, 'invalid_value', `${path}.${key}`, 'invalid environment name');
    stringField(value[key], `${path}.${key}`, issues);
  }
}

function validateRefMap(value: unknown, path: string, issues: ValidationIssue[], kind: keyof typeof REF_PATTERNS, maxProperties: number): void {
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an object');
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > maxProperties) addIssue(issues, 'invalid_value', path, `must contain at most ${maxProperties} entries`);
  for (const key of keys) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(key)) addIssue(issues, 'invalid_value', `${path}.${key}`, 'invalid environment name');
    refField(value[key], `${path}.${key}`, issues, kind);
  }
}

function validatePrecondition(value: unknown, path: string, instructionIds: Set<string>, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', path, 'must be an object');
    return;
  }
  if (typeof value.kind !== 'string') {
    addIssue(issues, 'missing_field', `${path}.kind`, 'precondition kind is required');
    return;
  }
  switch (value.kind) {
    case 'file_hash':
      checkKeys(value, ['kind', 'path', 'sha256'], path, issues);
      required(value, ['kind', 'path', 'sha256'], path, issues);
      stringField(value.path, `${path}.path`, issues);
      stringField(value.sha256, `${path}.sha256`, issues, /^[A-Fa-f0-9]{64}$/u);
      break;
    case 'artifact_hash':
      checkKeys(value, ['kind', 'artifact', 'sha256'], path, issues);
      required(value, ['kind', 'artifact', 'sha256'], path, issues);
      refField(value.artifact, `${path}.artifact`, issues, 'artifact');
      stringField(value.sha256, `${path}.sha256`, issues, /^[A-Fa-f0-9]{64}$/u);
      break;
    case 'instruction_status':
      checkKeys(value, ['kind', 'instruction', 'status'], path, issues);
      required(value, ['kind', 'instruction', 'status'], path, issues);
      if (stringField(value.instruction, `${path}.instruction`, issues, ID_PATTERN) && !instructionIds.has(value.instruction)) {
        addIssue(issues, 'unknown_reference', `${path}.instruction`, `instruction '${value.instruction}' is not declared in this program`);
      }
      if (!['admitted', 'succeeded', 'failed', 'indeterminate', 'cancelled', 'rolled_back', 'partial'].includes(String(value.status))) addIssue(issues, 'invalid_value', `${path}.status`, 'unsupported instruction status');
      break;
    case 'workspace_revision':
      checkKeys(value, ['kind', 'workspace', 'revision'], path, issues);
      required(value, ['kind', 'workspace', 'revision'], path, issues);
      refField(value.workspace, `${path}.workspace`, issues, 'workspace');
      stringField(value.revision, `${path}.revision`, issues);
      break;
    default:
      addIssue(issues, 'invalid_value', `${path}.kind`, `unsupported precondition kind '${value.kind}'`);
  }
}

function negotiateIsa(value: unknown, options: ValidateProgramOptions, issues: ValidationIssue[]): IsaVersion | undefined {
  if (!stringField(value, 'isa', issues, ISA_PATTERN)) return undefined;
  const match = ISA_PATTERN.exec(value);
  if (!match || match[1] !== '1') {
    addIssue(issues, 'unsupported_isa_minor', 'isa', 'only xio/1 ISA is supported');
    return undefined;
  }
  const supported = options.supportedIsa ?? ['xio/1.0'];
  const supportedMinors = supported.flatMap((entry) => {
    const candidate = ISA_PATTERN.exec(entry);
    if (!candidate || candidate[1] !== '1') return [];
    return [candidate[2] === undefined ? 0 : Number(candidate[2])];
  });
  const requestedMinor = match[2] === undefined ? undefined : Number(match[2]);
  const selectedMinor = requestedMinor === undefined
    ? Math.max(...supportedMinors, -1)
    : supportedMinors.includes(requestedMinor) ? requestedMinor : -1;
  if (selectedMinor < 0) {
    addIssue(issues, 'unsupported_isa_minor', 'isa', `ISA minor ${value} is not supported by this validator`);
    return undefined;
  }
  return `xio/1.${selectedMinor}` as IsaVersion;
}

function matchesPath(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (pattern.endsWith('**')) return value.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return false;
}

function collectInstructionPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ['path', 'from', 'to']) if (typeof args[key] === 'string') paths.push(args[key] as string);
  for (const key of ['paths', 'roots']) if (Array.isArray(args[key])) paths.push(...args[key].filter((item): item is string => typeof item === 'string'));
  return paths;
}

function checkCapability(
  program: Record<string, unknown>,
  instructions: Array<{ value: Record<string, unknown>; op: Opcode; id: string }>,
  resources: ResourceEstimate,
  options: ValidateProgramOptions,
  issues: ValidationIssue[],
): 'complete' | 'partial' | 'not_requested' {
  const capability = options.capability;
  if (!capability) {
    if (options.requireCapability !== false) addIssue(issues, 'capability_missing', 'capability', 'a capability is required for ISA admission');
    return 'not_requested';
  }
  if (program.capability !== undefined && program.capability !== capability.id) {
    addIssue(issues, 'capability_denied', 'capability', 'program capability does not match the supplied capability');
  }
  const now = options.now ?? new Date();
  const expiresAt = Date.parse(capability.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) addIssue(issues, 'capability_expired', 'capability.expiresAt', 'capability is expired or invalid');
  if (!Number.isSafeInteger(capability.epoch) || capability.epoch < 0) addIssue(issues, 'capability_denied', 'capability.epoch', 'capability epoch must be a non-negative safe integer');
  if (typeof capability.policyVersion !== 'string' || capability.policyVersion.length === 0) addIssue(issues, 'capability_denied', 'capability.policyVersion', 'capability policyVersion is required');
  if (typeof capability.reason !== 'string' || capability.reason.length === 0) addIssue(issues, 'capability_denied', 'capability.reason', 'capability reason is required');
  for (const instruction of instructions) {
    if (!capability.scope.opcodes.includes(instruction.op)) addIssue(issues, 'capability_denied', `instructions.${instruction.id}.op`, `opcode '${instruction.op}' is outside the capability scope`);
    for (const path of collectInstructionPaths(instruction.value.args as Record<string, unknown>)) {
      if (capability.scope.paths.length === 0 || !capability.scope.paths.some((pattern) => matchesPath(pattern, path))) addIssue(issues, 'capability_denied', `instructions.${instruction.id}.args`, `path '${path}' is outside the capability scope`);
    }
    const args = instruction.value.args as Record<string, unknown>;
    for (const key of ['workspace', 'cwd']) {
      if (typeof args[key] === 'string' && (capability.scope.workspaces.length === 0 || !capability.scope.workspaces.includes(args[key] as never))) {
        addIssue(issues, 'capability_denied', `instructions.${instruction.id}.args.${key}`, `workspace '${args[key]}' is outside the capability scope`);
      }
    }
    const secretEnv = args.secretEnv;
    if (isRecord(secretEnv)) for (const [name, secret] of Object.entries(secretEnv)) {
      if (typeof secret !== 'string' || !capability.scope.secrets.includes(secret as never)) addIssue(issues, 'capability_denied', `instructions.${instruction.id}.args.secretEnv.${name}`, 'secret is outside the capability scope');
    }
  }
  if (resources.instructionCount > capability.limits.concurrentOps) addIssue(issues, 'resource_exceeded', 'instructions', 'instruction count exceeds capability concurrentOps limit');
  const processCount = instructions.filter((instruction) => instruction.op === 'proc.spawn').length;
  if (processCount > capability.limits.processes) addIssue(issues, 'resource_exceeded', 'instructions', 'process spawn count exceeds capability process limit');
  const programOptions = program.options;
  if (isRecord(programOptions) && typeof programOptions.maxOutputBytes === 'number' && programOptions.maxOutputBytes > capability.limits.outputBytes) {
    addIssue(issues, 'resource_exceeded', 'options.maxOutputBytes', 'requested output exceeds capability outputBytes limit');
  }
  const available = options.availableCapabilities;
  if (!available) return 'partial';
  const availableSet = new Set(available);
  for (const capabilityName of resources.requiredCapabilities) {
    if (!availableSet.has(capabilityName)) addIssue(issues, 'capability_denied', 'capability', `required capability '${capabilityName}' is unavailable`);
  }
  return 'complete';
}

function buildResources(instructions: Array<{ id: string; op: Opcode }>): ResourceEstimate {
  const costCounts: Record<string, number> = {};
  const capabilities = new Set<string>();
  const externalInstructionIds: string[] = [];
  const requiresOpId: string[] = [];
  for (const instruction of instructions) {
    const metadata = ISA_V1_REGISTRY[instruction.op];
    for (const cost of metadata.resourceCost) costCounts[cost] = (costCounts[cost] ?? 0) + 1;
    for (const capability of metadata.requiredCapabilities) capabilities.add(capability);
    if (metadata.atomicity === 'external') externalInstructionIds.push(instruction.id);
    if (metadata.idempotency !== 'safe') requiresOpId.push(instruction.id);
  }
  return {
    instructionCount: instructions.length,
    costCounts,
    resourceCost: Object.keys(costCounts).sort(),
    requiredCapabilities: [...capabilities].sort(),
    externalInstructionIds,
    requiresOpId,
  };
}

export function lookupOpcode(op: unknown): Opcode | undefined {
  return typeof op === 'string' && (ISA_V1_OPCODES as readonly string[]).includes(op) ? op as Opcode : undefined;
}

export function validateProgram(input: unknown, options: ValidateProgramOptions = {}): ProgramValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ code: 'invalid_type', path: 'program', message: 'must be an object' }] };
  try {
    const encoded = encodeJson(input as JsonObject);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) addIssue(issues, 'payload_too_large', 'program', `encoded size must be at most ${MAX_JSON_BYTES} bytes`);
  } catch (error) {
    addIssue(issues, 'invalid_json', 'program', error instanceof Error ? error.message : String(error));
  }
  checkKeys(input, PROGRAM_KEYS, 'program', issues);
  required(input, ['isa', 'requestId', 'programId', 'mode', 'instructions'], 'program', issues);
  const negotiatedIsa = negotiateIsa(input.isa, options, issues);
  stringField(input.requestId, 'requestId', issues, ID_PATTERN);
  stringField(input.programId, 'programId', issues, ID_PATTERN);
  if (!['plan', 'transaction', 'pipeline'].includes(String(input.mode))) addIssue(issues, 'invalid_value', 'mode', 'unsupported program mode');
  if (input.capability !== undefined) refField(input.capability, 'capability', issues, 'capability');
  if (input.workspace !== undefined) refField(input.workspace, 'workspace', issues, 'workspace');
  if (input.options !== undefined) validateOptions(input.options, issues);
  if (!Array.isArray(input.instructions)) addIssue(issues, 'invalid_type', 'instructions', 'must be an array');
  const rawInstructions = Array.isArray(input.instructions) ? input.instructions : [];
  if (rawInstructions.length === 0) addIssue(issues, 'invalid_value', 'instructions', 'must contain at least one instruction');
  if (rawInstructions.length > MAX_INSTRUCTIONS) addIssue(issues, 'invalid_value', 'instructions', `must contain at most ${MAX_INSTRUCTIONS} instructions`);
  const ids = new Set<string>();
  const declaredIds = new Set<string>(rawInstructions.flatMap((value) => isRecord(value) && typeof value.id === 'string' && ID_PATTERN.test(value.id) ? [value.id] : []));
  const outputs = new Set<string>();
  const opIds = new Set<string>();
  const parsed: Array<{ value: Record<string, unknown>; op: Opcode; id: string }> = [];
  for (let index = 0; index < rawInstructions.length; index++) {
    const path = `instructions[${index}]`;
    const value = rawInstructions[index];
    if (!isRecord(value)) {
      addIssue(issues, 'invalid_type', path, 'must be an object');
      continue;
    }
    checkKeys(value, INSTRUCTION_KEYS, path, issues);
    required(value, INSTRUCTION_KEYS.slice(0, 6), path, issues);
    const id = typeof value.id === 'string' && ID_PATTERN.test(value.id) ? value.id : `#${index}`;
    if (typeof value.id === 'string') stringField(value.id, `${path}.id`, issues, ID_PATTERN);
    if (ids.has(id)) addIssue(issues, 'duplicate_id', `${path}.id`, `instruction id '${id}' is duplicated`);
    ids.add(id);
    const op = lookupOpcode(value.op);
    if (!op) {
      addIssue(issues, 'unsupported_opcode', `${path}.op`, `opcode '${String(value.op)}' is not in the v1 registry`);
      continue;
    }
    validateArgs(op, value.args, `${path}.args`, issues);
    if (!Array.isArray(value.dependsOn)) addIssue(issues, 'invalid_type', `${path}.dependsOn`, 'must be an array');
    else {
      if (value.dependsOn.length > MAX_DEPENDENCIES) addIssue(issues, 'invalid_value', `${path}.dependsOn`, `must contain at most ${MAX_DEPENDENCIES} items`);
      const seenDeps = new Set<string>();
      for (const [dependencyIndex, dependency] of value.dependsOn.entries()) {
        if (typeof dependency !== 'string' || !ID_PATTERN.test(dependency)) {
          addIssue(issues, 'invalid_value', `${path}.dependsOn[${dependencyIndex}]`, 'invalid instruction reference');
        } else if (seenDeps.has(dependency)) {
          addIssue(issues, 'invalid_value', `${path}.dependsOn[${dependencyIndex}]`, 'duplicate dependency');
        }
        seenDeps.add(String(dependency));
      }
    }
    if (!Array.isArray(value.precondition)) addIssue(issues, 'invalid_type', `${path}.precondition`, 'must be an array');
    else {
      if (value.precondition.length > MAX_PRECONDITIONS) addIssue(issues, 'invalid_value', `${path}.precondition`, `must contain at most ${MAX_PRECONDITIONS} items`);
      for (const [preconditionIndex, precondition] of value.precondition.entries()) validatePrecondition(precondition, `${path}.precondition[${preconditionIndex}]`, declaredIds, issues);
    }
    if (typeof value.output === 'string') {
      stringField(value.output, `${path}.output`, issues, ID_PATTERN);
      if (outputs.has(value.output)) addIssue(issues, 'duplicate_output', `${path}.output`, `output '${value.output}' is duplicated`);
      outputs.add(value.output);
    }
    if (value.opId !== undefined) {
      if (stringField(value.opId, `${path}.opId`, issues, OP_ID_PATTERN)) {
        if (opIds.has(value.opId)) addIssue(issues, 'duplicate_op_id', `${path}.opId`, `opId '${value.opId}' is duplicated`);
        opIds.add(value.opId);
      }
    } else if (ISA_V1_REGISTRY[op].idempotency !== 'safe') {
      addIssue(issues, 'invalid_value', `${path}.opId`, `opcode '${op}' requires an opId`);
    }
    parsed.push({ value, op, id });
  }
  for (const [index, instruction] of parsed.entries()) {
    const path = `instructions[${index}]`;
    const dependencies = instruction.value.dependsOn;
    if (Array.isArray(dependencies)) for (const dependency of dependencies) {
      if (typeof dependency === 'string' && !ids.has(dependency)) addIssue(issues, 'unknown_reference', `${path}.dependsOn`, `instruction '${dependency}' is not declared in this program`);
    }
    if (isRecord(instruction.value.args)) {
      const args = instruction.value.args;
      if (typeof args.instruction === 'string' && !ids.has(args.instruction)) addIssue(issues, 'unknown_reference', `${path}.args.instruction`, `instruction '${args.instruction}' is not declared in this program`);
      if (typeof args.program === 'string' && args.program !== input.programId) addIssue(issues, 'unknown_reference', `${path}.args.program`, `program '${args.program}' is not this program`);
    }
  }
  detectCycles(parsed, issues);
  const resources = buildResources(parsed);
  const capabilityPrecheck = checkCapability(input, parsed, resources, options, issues);
  if (issues.length > 0 || !negotiatedIsa) return { ok: false, issues };
  const program = input as unknown as Program;
  return {
    ok: true,
    program,
    plan: {
      negotiatedIsa,
      instructions: parsed.map(({ id, op }) => ({ id, op, atomicity: ISA_V1_REGISTRY[op].atomicity, observation: ISA_V1_REGISTRY[op].observation, drivers: [...ISA_V1_REGISTRY[op].drivers] })),
      dependencies: Object.fromEntries(parsed.map(({ id, value }) => [id, Array.isArray(value.dependsOn) ? value.dependsOn.filter((item): item is string => typeof item === 'string') : []])),
      resources,
      capabilityPrecheck,
    },
  };
}

function validateOptions(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, 'invalid_type', 'options', 'must be an object');
    return;
  }
  checkKeys(value, OPTIONS_KEYS, 'options', issues);
  if (value.wait !== undefined && !['until_terminal', 'until_admitted', 'return_cursor'].includes(String(value.wait))) addIssue(issues, 'invalid_value', 'options.wait', 'unsupported wait mode');
  if (value.maxOutputBytes !== undefined) integerField(value.maxOutputBytes, 'options.maxOutputBytes', issues, 0, 100 * 1024 * 1024);
  if (value.eventCursor !== undefined && value.eventCursor !== null) stringField(value.eventCursor, 'options.eventCursor', issues, EVENT_CURSOR_PATTERN);
}

function detectCycles(parsed: Array<{ value: Record<string, unknown>; op: Opcode; id: string }>, issues: ValidationIssue[]): void {
  const graph = new Map<string, string[]>();
  for (const instruction of parsed) graph.set(instruction.id, Array.isArray(instruction.value.dependsOn) ? instruction.value.dependsOn.filter((item): item is string => typeof item === 'string') : []);
  const state = new Map<string, 'visiting' | 'visited'>();
  const visit = (id: string, stack: string[]): void => {
    if (state.get(id) === 'visiting') {
      addIssue(issues, 'dependency_cycle', `instructions.${id}.dependsOn`, `dependency cycle detected: ${[...stack, id].join(' -> ')}`);
      return;
    }
    if (state.get(id) === 'visited') return;
    state.set(id, 'visiting');
    for (const dependency of graph.get(id) ?? []) if (graph.has(dependency)) visit(dependency, [...stack, id]);
    state.set(id, 'visited');
  };
  for (const id of graph.keys()) visit(id, []);
}

export function assertValidProgram(input: unknown, options?: ValidateProgramOptions): ProgramValidationSuccess {
  const result = validateProgram(input, options);
  if (!result.ok) throw new ProgramValidationError(result.issues);
  return result;
}
