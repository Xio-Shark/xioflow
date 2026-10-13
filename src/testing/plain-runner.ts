/**
 * Plain-node runner for the shared conformance contract suite.
 *
 * The contract suite (`./contract-suite`) is authored against the vitest API
 * (describe/it/beforeEach/afterEach/expect). Third-party implementers who do
 * not already use vitest should not need to install it just to obtain a
 * green/red verdict. This module implements the minimal subset of the vitest
 * API that the suite uses, executes the suite sequentially and prints a
 * machine-readable JSON report.
 *
 * Usage (consumer side, no vitest required):
 *
 *   // conformance.mjs
 *   import { installPlainEnvironment, runPlainSuite } from '@xioflow/kernel/testing/plain';
 *   import { defineContractTestSuite } from '@xioflow/kernel/testing';
 *
 *   installPlainEnvironment();
 *   defineContractTestSuite('my-framework', async (ctx) => {
 *     // ctx: { domain, driver, supervisor, tempDir, workflowType, cleanup }
 *     return { ...ctx };
 *   });
 *   const report = await runPlainSuite({ consumerName: 'my-framework' });
 *   process.exit(report.failed > 0 || report.errors.length > 0 ? 1 : 0);
 *
 * The report shape is stable:
 *   { consumer, startedAt, finishedAt, passed, failed, skipped,
 *     failures: [{ suite, test, error }], errors: [{ phase, error }] }
 */

/* ---------- test collection ---------- */

interface PlainTest {
  suite: string;
  name: string;
  fn: () => void | Promise<void>;
  skip?: boolean;
}

interface PlainHooks {
  beforeEach: Array<() => void | Promise<void>>;
  afterEach: Array<() => void | Promise<void>>;
}

const tests: PlainTest[] = [];
const hooks = new Map<string, PlainHooks>();
let currentSuite = '';
let installed = false;

function hookBucket(suite: string): PlainHooks {
  let bucket = hooks.get(suite);
  if (!bucket) {
    bucket = { beforeEach: [], afterEach: [] };
    hooks.set(suite, bucket);
  }
  return bucket;
}

interface DescribeFn {
  (name: string, fn: () => void): void;
  skip?(name: string, fn: () => void): void;
  only?(name: string, fn: () => void): void;
}

interface ItFn {
  (name: string, fn: () => void | Promise<void>, timeout?: number): void;
  skip?(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  only?(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  todo?(name: string): void;
}

function makeDescribe(): DescribeFn {
  const describe = ((name: string, fn: () => void) => {
    const previous = currentSuite;
    currentSuite = currentSuite ? `${currentSuite} > ${name}` : name;
    hookBucket(currentSuite);
    try {
      fn();
    } finally {
      currentSuite = previous;
    }
  }) as DescribeFn;
  describe.skip = (name: string, fn: () => void) => {
    const previous = currentSuite;
    currentSuite = currentSuite ? `${currentSuite} > ${name}` : name;
    hookBucket(currentSuite);
    currentSuite = previous;
    void fn;
  };
  describe.only = (name: string, fn: () => void) => describe(name, fn);
  return describe;
}

function makeIt(): ItFn {
  const it = ((name: string, fn: () => void | Promise<void>) => {
    tests.push({ suite: currentSuite, name, fn });
  }) as ItFn;
  it.skip = (name: string, fn: () => void | Promise<void>) => {
    tests.push({ suite: currentSuite, name, fn, skip: true });
  };
  it.only = (name: string, fn: () => void | Promise<void>) => it(name, fn);
  it.todo = (name: string) => {
    tests.push({ suite: currentSuite, name, fn: () => {}, skip: true });
  };
  return it;
}

/** Test-framework API surface provided by the environment. */
export interface TestEnvironment {
  describe: DescribeFn;
  it: ItFn;
  expect: ExpectApi;
  beforeEach(fn: () => void | Promise<void>): void;
  afterEach(fn: () => void | Promise<void>): void;
}

/**
 * Resolves the vitest-compatible API from the environment. Runners install it
 * onto globalThis before calling the suite: vitest (with `globals: true`)
 * provides the real API; {@link installPlainEnvironment} provides the
 * dependency-free shim.
 */
export function resolveTestEnvironment(): TestEnvironment {
  const g = globalThis as unknown as Record<string, unknown>;
  const env = (g.__xioflowTestEnv ?? g) as Partial<TestEnvironment>;
  if (typeof env.describe !== 'function' || typeof env.it !== 'function' || typeof env.expect !== 'function') {
    throw new Error(
      'No test environment installed. Under vitest enable `globals: true`; ' +
        'otherwise call installPlainEnvironment() from "@xioflow/kernel/testing/plain" first.'
    );
  }
  return env as TestEnvironment;
}

/** Installs the minimal vitest-compatible describe/it/hooks/expect onto globalThis. */
export function installPlainEnvironment(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as Record<string, unknown>;
  g.describe = makeDescribe();
  g.it = makeIt();
  g.test = g.it;
  g.beforeEach = (fn: () => void | Promise<void>) => {
    hookBucket(currentSuite).beforeEach.push(fn);
  };
  g.afterEach = (fn: () => void | Promise<void>) => {
    hookBucket(currentSuite).afterEach.push(fn);
  };
  g.beforeAll = (fn: () => void | Promise<void>) => {
    hookBucket(currentSuite).beforeEach.push(fn);
  };
  g.afterAll = (fn: () => void | Promise<void>) => {
    hookBucket(currentSuite).afterEach.push(fn);
  };
  // A global expect whose return value also carries rejects/resolves when the
  // received value is promise-like, so `await expect(p).rejects.toThrowError()` works.
  g.expect = makeWrappedExpect();
  g.__xioflowTestEnv = g;
}

/* ---------- equality (vitest-compatible subset) ---------- */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAsymmetricMatcher(value: unknown): value is AsymmetricMatcher {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { asymmetricMatch?: unknown }).asymmetricMatch === 'function'
  );
}

function equals(a: unknown, b: unknown, strict: boolean): boolean {
  // vitest semantics: an asymmetric matcher on either side is consulted, not compared
  if (isAsymmetricMatcher(b)) return b.asymmetricMatch(a);
  if (isAsymmetricMatcher(a)) return a.asymmetricMatch(b);
  if (Object.is(a, b)) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (!isObject(a) || !isObject(b)) return false;
  if (strict && a.constructor !== b.constructor) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      // vitest toEqual ignores holes; strict compares them
      const aHas = index in a;
      const bHas = index in b;
      if (strict && aHas !== bHas) return false;
      if (!equals(a[index], b[index], strict)) return false;
    }
    return true;
  }
  if (a instanceof Error || b instanceof Error) {
    if (!(a instanceof Error) || !(b instanceof Error)) return false;
    return a.message === b.message && (strict ? a.name === b.name : true);
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (!strict) {
    // toEqual ignores keys whose value is undefined
    const aDefined = aKeys.filter((key) => a[key] !== undefined);
    const bDefined = bKeys.filter((key) => b[key] !== undefined);
    if (aDefined.length !== bDefined.length) return false;
    for (const key of aDefined) {
      if (!(key in b) || !equals(a[key], b[key], strict)) return false;
    }
    return true;
  }
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!(key in b) || !equals(a[key], b[key], strict)) return false;
  }
  return true;
}

function matchesObject(received: unknown, expected: unknown): boolean {
  if (!isObject(expected)) return equals(received, expected, false);
  if (!isObject(received)) return false;
  for (const key of Object.keys(expected)) {
    const expectedValue = expected[key];
    const receivedValue = received[key];
    if (expectedValue && typeof expectedValue === 'object' && 'asymmetricMatch' in (expectedValue as object)) {
      if (!(expectedValue as { asymmetricMatch(v: unknown): boolean }).asymmetricMatch(receivedValue)) return false;
      continue;
    }
    if (isObject(expectedValue) && isObject(receivedValue) && !(expectedValue instanceof RegExp)) {
      if (!matchesObject(receivedValue, expectedValue)) return false;
      continue;
    }
    if (!equals(receivedValue, expectedValue, false)) return false;
  }
  return true;
}

/* ---------- expect ---------- */

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner) => (typeof inner === 'bigint' ? String(inner) : inner)) ?? String(value);
  } catch {
    return String(value);
  }
}

interface AsymmetricMatcher {
  asymmetricMatch(other: unknown): boolean;
  toString(): string;
}

interface RejectsMatchers {
  toThrow(expected?: unknown): Promise<void>;
  toThrowError(expected?: unknown): Promise<void>;
  toSatisfy(fn: (value: unknown) => boolean): Promise<void>;
}

interface ResolvesMatchers {
  toBe(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
  toSatisfy(fn: (value: unknown) => boolean): Promise<void>;
}

interface AssertionBudget {
  count: number;
  called: number;
}

/** All matchers, available both directly and negated under `.not`. */
interface CoreMatchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toMatch(expected: string | RegExp): void;
  toMatchObject(expected: unknown): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeInstanceOf(constructor: new (...args: never[]) => unknown): void;
  toHaveProperty(key: string, expected?: unknown): void;
  toHaveLength(expected: number): void;
  toSatisfy(fn: (received: unknown) => boolean): void;
  toThrow(expected?: unknown): void;
  toThrowError(expected?: unknown): void;
}

interface ExpectMatchers extends CoreMatchers {
  /** Negated matchers (`expect(x).not.toBe(y)`). */
  not: CoreMatchers;
  /** Present when the received value is promise-like. */
  rejects?: RejectsMatchers;
  /** Present when the received value is promise-like. */
  resolves?: ResolvesMatchers;
}

interface ExpectApi {
  (value: Promise<unknown>): ExpectMatchers & { rejects: RejectsMatchers; resolves: ResolvesMatchers };
  (value: unknown): ExpectMatchers;
  any(constructor: new (...args: never[]) => unknown): AsymmetricMatcher;
  anything(): AsymmetricMatcher;
  arrayContaining(expected: unknown[]): AsymmetricMatcher;
  objectContaining(expected: Record<string, unknown>): AsymmetricMatcher;
  assertions(count: number): void;
}

const NOT_A_PROMISE = 'received value is not a promise-like object';

function makeMatchers(value: unknown, budget: AssertionBudget | undefined, negated: boolean): ExpectMatchers {
  const check = (ok: boolean, message: string): void => {
    if (budget) budget.called += 1;
    if (negated ? ok : !ok) {
      throw new AssertionError(negated ? `expected NOT: ${message}` : message);
    }
  };
  const matchers: CoreMatchers = {
    toBe(expected: unknown) {
      check(Object.is(value, expected), `expected ${stringify(value)} to be ${stringify(expected)}`);
    },
    toEqual(expected: unknown) {
      check(equals(value, expected, false), `expected ${stringify(value)} to equal ${stringify(expected)}`);
    },
    toStrictEqual(expected: unknown) {
      check(equals(value, expected, true), `expected ${stringify(value)} to strictly equal ${stringify(expected)}`);
    },
    toContain(expected: unknown) {
      if (typeof value === 'string') {
        check(value.includes(String(expected)), `expected ${JSON.stringify(value)} to contain ${stringify(expected)}`);
        return;
      }
      if (Array.isArray(value)) {
        check(value.some((item) => equals(item, expected, false)), `expected ${stringify(value)} to contain ${stringify(expected)}`);
        return;
      }
      throw new AssertionError(`toContain expects a string or array, received ${typeof value}`);
    },
    toMatch(expected: string | RegExp) {
      if (typeof value !== 'string') throw new AssertionError(`toMatch expects a string, received ${typeof value}`);
      const ok = expected instanceof RegExp ? expected.test(value) : value.includes(expected);
      check(ok, `expected ${JSON.stringify(value)} to match ${String(expected)}`);
    },
    toMatchObject(expected: unknown) {
      check(matchesObject(value, expected), `expected ${stringify(value)} to match object ${stringify(expected)}`);
    },
    toBeDefined() {
      check(value !== undefined, 'expected value to be defined, received undefined');
    },
    toBeUndefined() {
      check(value === undefined, `expected ${stringify(value)} to be undefined`);
    },
    toBeNull() {
      check(value === null, `expected ${stringify(value)} to be null`);
    },
    toBeTruthy() {
      check(Boolean(value), `expected ${stringify(value)} to be truthy`);
    },
    toBeFalsy() {
      check(!value, `expected ${stringify(value)} to be falsy`);
    },
    toBeGreaterThan(expected: number) {
      check(typeof value === 'number' && value > expected, `expected ${stringify(value)} to be greater than ${expected}`);
    },
    toBeGreaterThanOrEqual(expected: number) {
      check(typeof value === 'number' && value >= expected, `expected ${stringify(value)} to be >= ${expected}`);
    },
    toBeLessThan(expected: number) {
      check(typeof value === 'number' && value < expected, `expected ${stringify(value)} to be less than ${expected}`);
    },
    toBeLessThanOrEqual(expected: number) {
      check(typeof value === 'number' && value <= expected, `expected ${stringify(value)} to be <= ${expected}`);
    },
    toBeInstanceOf(constructor: new (...args: never[]) => unknown) {
      check(value instanceof constructor, `expected ${stringify(value)} to be instance of ${constructor.name}`);
    },
    toHaveLength(expected: number) {
      const length = isObject(value) || Array.isArray(value) ? (value as { length?: unknown }).length : undefined;
      check(length === expected, `expected ${stringify(value)} to have length ${expected}`);
    },
    toHaveProperty(key: string, expected?: unknown) {
      // chai/vitest semantics: a literal own key first (keys may contain dots),
      // then a dotted path.
      const hasLiteral = isObject(value) && key in value;
      let current: unknown = hasLiteral ? (value as Record<string, unknown>)[key] : value;
      let found = hasLiteral;
      if (!found) {
        for (const segment of key.split('.')) {
          if (isObject(current) && segment in current) {
            current = current[segment];
          } else {
            found = false;
            break;
          }
          found = true;
        }
      }
      if (expected !== undefined) {
        check(found && equals(current, expected, false), `expected ${stringify(value)} to have property ${key} = ${stringify(expected)}`);
      } else {
        check(found, `expected ${stringify(value)} to have property ${key}`);
      }
    },
    toSatisfy(fn: (received: unknown) => boolean) {
      check(typeof fn === 'function' && fn(value) === true, `expected ${stringify(value)} to satisfy predicate`);
    },
    toThrow(expected?: unknown) {
      const outcome = captureThrown(value);
      if (negated) {
        check(!outcome.threw, 'expected function not to throw');
        return;
      }
      if (!outcome.threw) throw new AssertionError('expected function to throw, but it did not');
      matchThrown(outcome.thrown, expected);
    },
    toThrowError(expected?: unknown) {
      const outcome = captureThrown(value);
      if (negated) {
        check(!outcome.threw, 'expected function not to throw');
        return;
      }
      if (!outcome.threw) throw new AssertionError('expected function to throw, but it did not');
      matchThrown(outcome.thrown, expected);
    },
  };
  // `not` is created lazily: eager construction would recurse infinitely
  // (each negated matcher set carries its own `not`).
  let negatedMatchers: CoreMatchers | undefined;
  Object.defineProperty(matchers, 'not', {
    get() {
      if (!negatedMatchers) {
        negatedMatchers = makeMatchers(value, budget, !negated) as unknown as CoreMatchers;
      }
      return negatedMatchers;
    },
    enumerable: false,
  });
  // rejects/resolves are always present so the type and the runtime agree. On a
  // promise-like value they await the real settlement; otherwise they fail with
  // an explicit message instead of a TypeError.
  const thenable =
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function';
  const reject = async () => {
    throw new AssertionError(NOT_A_PROMISE);
  };
  const asyncMatchers = thenable
    ? {
        rejects: rejectsMatchers(value as Promise<unknown>),
        resolves: resolvesMatchers(value as Promise<unknown>),
      }
    : {
        rejects: { toThrow: reject, toThrowError: reject, toSatisfy: reject } as RejectsMatchers,
        resolves: { toBe: reject, toEqual: reject, toSatisfy: reject } as ResolvesMatchers,
      };
  (matchers as unknown as { rejects: RejectsMatchers }).rejects = asyncMatchers.rejects;
  (matchers as unknown as { resolves: ResolvesMatchers }).resolves = asyncMatchers.resolves;
  return matchers as unknown as ExpectMatchers;
}

function captureThrown(value: unknown): { threw: boolean; thrown?: unknown } {
  if (typeof value !== 'function') {
    throw new AssertionError('toThrow expects the received value to be a function');
  }
  try {
    value();
    return { threw: false };
  } catch (error) {
    return { threw: true, thrown: error };
  }
}

function matchThrown(thrown: unknown, expected?: unknown): void {
  if (expected === undefined) return;
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  if (typeof expected === 'string') {
    if (!message.includes(expected)) {
      throw new AssertionError(`expected error message ${JSON.stringify(message)} to contain ${JSON.stringify(expected)}`);
    }
    return;
  }
  if (expected instanceof RegExp) {
    if (!expected.test(message)) {
      throw new AssertionError(`expected error message ${JSON.stringify(message)} to match ${expected}`);
    }
    return;
  }
  if (typeof expected === 'function') {
    if (!(thrown instanceof (expected as new (...args: never[]) => unknown))) {
      throw new AssertionError(`expected error to be instance of ${expected.name}, received ${(thrown as object)?.constructor?.name}`);
    }
    return;
  }
  throw new AssertionError(`unsupported toThrow matcher: ${stringify(expected)}`);
}

function makeExpect(assertionBudget?: AssertionBudget): ExpectApi {
  const expect = ((value: unknown) => makeMatchers(value, assertionBudget, false)) as ExpectApi;
  expect.any = (constructor: new (...args: never[]) => unknown): AsymmetricMatcher => {
    // vitest semantics: `expect.any(String)` matches primitive strings, etc.
    const ctor = constructor as unknown;
    const matchPrimitive = (other: unknown): boolean | undefined => {
      if (ctor === String) return typeof other === 'string' || other instanceof String;
      if (ctor === Number) return typeof other === 'number' || other instanceof Number;
      if (ctor === Boolean) return typeof other === 'boolean' || other instanceof Boolean;
      if (ctor === BigInt) return typeof other === 'bigint' || other instanceof BigInt;
      if (ctor === Symbol) return typeof other === 'symbol';
      if (ctor === Function) return typeof other === 'function';
      if (ctor === Array) return Array.isArray(other);
      if (ctor === Object) return isObject(other);
      return undefined;
    };
    return {
      asymmetricMatch: (other: unknown) => {
        const primitive = matchPrimitive(other);
        return primitive ?? other instanceof constructor;
      },
      toString: () => `Any(${constructor.name})`,
    };
  };
  expect.anything = (): AsymmetricMatcher => ({
    asymmetricMatch: (other: unknown) => other !== null && other !== undefined,
    toString: () => 'Anything',
  });
  expect.arrayContaining = (expected: unknown[]): AsymmetricMatcher => ({
    asymmetricMatch: (other: unknown) =>
      Array.isArray(other) && expected.every((item) => other.some((candidate) => equals(candidate, item, false))),
    toString: () => `ArrayContaining(${stringify(expected)})`,
  });
  expect.objectContaining = (expected: Record<string, unknown>): AsymmetricMatcher => ({
    asymmetricMatch: (other: unknown) => matchesObject(other, expected),
    toString: () => `ObjectContaining(${stringify(expected)})`,
  });
  expect.assertions = (count: number) => {
    if (!assertionBudget) {
      throw new AssertionError('expect.assertions is only valid inside a test body');
    }
    assertionBudget.count = count;
  };
  return expect;
}

/* ---------- async expect wrappers ---------- */

function rejectsMatchers(promise: Promise<unknown>): RejectsMatchers {
  const run = async (expected?: unknown) => {
    let thrown: unknown;
    let didThrow = false;
    try {
      await promise;
    } catch (error) {
      didThrow = true;
      thrown = error;
    }
    if (!didThrow) throw new AssertionError('expected promise to reject, but it resolved');
    matchThrown(thrown, expected);
  };
  return {
    toThrow: run,
    toThrowError: run,
    async toSatisfy(fn: (value: unknown) => boolean) {
      let thrown: unknown;
      let didThrow = false;
      try {
        await promise;
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      if (!didThrow) throw new AssertionError('expected promise to reject, but it resolved');
      if (fn(thrown) !== true) {
        throw new AssertionError(`expected rejected value ${stringify(thrown)} to satisfy predicate`);
      }
    },
  };
}

function resolvesMatchers(promise: Promise<unknown>): ResolvesMatchers {
  const settle = async () => {
    try {
      return { value: await promise, thrown: false as const };
    } catch (error) {
      return { thrown: true as const, error };
    }
  };
  return {
    async toBe(expected: unknown) {
      const result = await settle();
      if (result.thrown) throw new AssertionError(`expected promise to resolve, but it rejected: ${String(result.error)}`);
      if (!Object.is(result.value, expected)) {
        throw new AssertionError(`expected ${stringify(result.value)} to be ${stringify(expected)}`);
      }
    },
    async toEqual(expected: unknown) {
      const result = await settle();
      if (result.thrown) throw new AssertionError(`expected promise to resolve, but it rejected: ${String(result.error)}`);
      if (!equals(result.value, expected, false)) {
        throw new AssertionError(`expected ${stringify(result.value)} to equal ${stringify(expected)}`);
      }
    },
    async toSatisfy(fn: (value: unknown) => boolean) {
      const result = await settle();
      if (result.thrown) throw new AssertionError(`expected promise to resolve, but it rejected: ${String(result.error)}`);
      if (fn(result.value) !== true) {
        throw new AssertionError(`expected resolved value ${stringify(result.value)} to satisfy predicate`);
      }
    },
  };
}

/* ---------- expect factory ---------- */

function makeWrappedExpect(budget?: AssertionBudget): ExpectApi {
  // rejects/resolves are always attached by makeMatchers; on non-promise values
  // they fail with an explicit message rather than a TypeError.
  return makeExpect(budget);
}

/* ---------- suite execution ---------- */

export interface PlainFailure {
  suite: string;
  test: string;
  error: string;
}

export interface PlainReport {
  consumer: string;
  startedAt: string;
  finishedAt: string;
  passed: number;
  failed: number;
  skipped: number;
  failures: PlainFailure[];
  errors: Array<{ phase: string; error: string }>;
}

function collectHookChain(suite: string, kind: 'beforeEach' | 'afterEach'): Array<() => void | Promise<void>> {
  const chain: Array<() => void | Promise<void>> = [];
  const segments = suite.split(' > ');
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix ? `${prefix} > ${segment}` : segment;
    const bucket = hooks.get(prefix);
    if (bucket) chain.push(...bucket[kind]);
  }
  return chain;
}

/**
 * Executes the collected suite sequentially and returns a machine-readable report.
 * Prints the JSON report to stdout unless `quiet` is set.
 */
export async function runPlainSuite(options?: { consumerName?: string; quiet?: boolean }): Promise<PlainReport> {
  const startedAt = new Date().toISOString();
  const report: PlainReport = {
    consumer: options?.consumerName ?? 'unknown',
    startedAt,
    finishedAt: startedAt,
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    errors: [],
  };

  // Background supervision chains (e.g. an executeProcess promise still settling
  // after a cancel) can surface after their test finished. Under plain node the
  // default behavior would crash the process; vitest collects these instead.
  // Collect them into report.errors with the same semantics: visible, and the
  // run exits non-zero, so they are never silently swallowed.
  const onUnhandled = (error: unknown, phase: string) => {
    report.errors.push({
      phase,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  };
  const rejectionListener = (reason: unknown) => onUnhandled(reason, 'unhandledRejection');
  const exceptionListener = (error: unknown) => onUnhandled(error, 'uncaughtException');
  process.on('unhandledRejection', rejectionListener);
  process.on('uncaughtException', exceptionListener);

  for (const test of tests) {
    if (test.skip) {
      report.skipped += 1;
      continue;
    }
    const budget = { count: 0, called: 0 };
    (globalThis as unknown as Record<string, unknown>).expect = makeWrappedExpect(budget);
    try {
      for (const hook of collectHookChain(test.suite, 'beforeEach')) await hook();
      await test.fn();
      if (budget.count > 0 && budget.called !== budget.count) {
        throw new AssertionError(`expected ${budget.count} assertions, but ${budget.called} were called`);
      }
      for (const hook of collectHookChain(test.suite, 'afterEach').reverse()) await hook();
      report.passed += 1;
    } catch (error) {
      report.failed += 1;
      report.failures.push({
        suite: test.suite,
        test: test.name,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      try {
        for (const hook of collectHookChain(test.suite, 'afterEach').reverse()) await hook();
      } catch (hookError) {
        report.errors.push({
          phase: `afterEach(${test.name})`,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  process.off('unhandledRejection', rejectionListener);
  process.off('uncaughtException', exceptionListener);
  if (!options?.quiet) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
