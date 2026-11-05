import { ISA_V1_REGISTRY } from './registry.generated.js';
import {
  validateProgram,
  type ProgramValidationFailure,
  type ValidateProgramOptions,
  type ValidationIssue,
  type ValidationPlan,
} from './validator.js';
import type { IsaVersion, Opcode } from './types.js';

export type PlanStatus = 'admitted' | 'rejected' | 'unsupported' | 'indeterminate';
export type DriverCheckStatus = 'available' | 'unsupported' | 'unknown';

export interface PlanSchemaInfo {
  id: 'xio://schema/isa-v1/program';
  version: '1.0';
}

export interface PlanDriver {
  name: string;
  version?: string;
  opcodes?: readonly Opcode[];
  capabilities?: readonly string[];
}

export interface PlanDriverCheck {
  instructionId: string;
  op: Opcode;
  required: string[];
  status: DriverCheckStatus;
  selected?: string;
}

export interface PlanExecutionOptions extends ValidateProgramOptions {
  drivers?: readonly PlanDriver[];
}

export interface PlanReport {
  schema: PlanSchemaInfo;
  isa?: IsaVersion;
  requestId?: string;
  programId?: string;
  mode: 'plan';
  status: PlanStatus;
  capability: ValidationPlan['capabilityPrecheck'] | 'rejected';
  dependencies?: ValidationPlan['dependencies'];
  resources?: ValidationPlan['resources'];
  instructions?: ValidationPlan['instructions'];
  drivers: PlanDriverCheck[];
  issues: ValidationIssue[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requestMetadata(input: unknown): Pick<PlanReport, 'requestId' | 'programId' | 'isa'> {
  const value = recordOf(input);
  return {
    requestId: typeof value?.requestId === 'string' ? value.requestId : undefined,
    programId: typeof value?.programId === 'string' ? value.programId : undefined,
    isa: typeof value?.isa === 'string' ? value.isa as IsaVersion : undefined,
  };
}

function driverChecks(plan: ValidationPlan | undefined, drivers: readonly PlanDriver[] | undefined): PlanDriverCheck[] {
  if (!plan) return [];
  return plan.instructions.map((instruction) => {
    const required = [...ISA_V1_REGISTRY[instruction.op].drivers];
    if (!drivers) return { instructionId: instruction.id, op: instruction.op, required, status: 'unknown' };
    const selected = required.map((name) => drivers.find((driver) => driver.name === name && (!driver.opcodes || driver.opcodes.includes(instruction.op))));
    const available = selected.every((driver): driver is PlanDriver => driver !== undefined);
    return available
      ? { instructionId: instruction.id, op: instruction.op, required, status: 'available', selected: selected.map((driver) => driver.name).join(',') }
      : { instructionId: instruction.id, op: instruction.op, required, status: 'unsupported' };
  });
}

function classify(issues: ValidationIssue[], checks: PlanDriverCheck[]): PlanStatus {
  if (issues.some((issue) => issue.code === 'unsupported_isa_minor' || issue.code === 'unsupported_opcode')) return 'unsupported';
  if (checks.some((check) => check.status === 'unsupported')) return 'unsupported';
  return issues.length > 0 ? 'rejected' : 'admitted';
}

export function planProgram(input: unknown, options: PlanExecutionOptions = {}): PlanReport {
  const metadata = requestMetadata(input);
  const result = validateProgram(input, options);
  if (!result.ok) {
    const failure = result as ProgramValidationFailure;
    return {
      schema: { id: 'xio://schema/isa-v1/program', version: '1.0' },
      ...metadata,
      mode: 'plan',
      status: classify(failure.issues, []),
      capability: failure.issues.some((issue) => issue.code.startsWith('capability_') || issue.code === 'resource_exceeded') ? 'rejected' : 'rejected',
      drivers: [],
      issues: failure.issues,
    };
  }
  const drivers = driverChecks(result.plan, options.drivers);
  const issues: ValidationIssue[] = [];
  if (recordOf(input)?.mode !== 'plan') {
    issues.push({ code: 'invalid_value', path: 'mode', message: 'planProgram only accepts mode=plan' });
  }
  const status = classify(issues, drivers);
  return {
    schema: { id: 'xio://schema/isa-v1/program', version: '1.0' },
    ...metadata,
    isa: result.plan.negotiatedIsa,
    mode: 'plan',
    status,
    capability: result.plan.capabilityPrecheck,
    dependencies: result.plan.dependencies,
    resources: result.plan.resources,
    instructions: result.plan.instructions,
    drivers,
    issues,
  };
}

export function executePlan(input: unknown, options: Omit<PlanExecutionOptions, 'drivers'> & { drivers?: readonly PlanDriver[] } = {}): PlanReport {
  return planProgram(input, options);
}
