/** The input-schema subset used by these tools. Unsupported schema keywords fail at registration. */
export interface StringInputSchema {
  type: 'string';
  description?: string;
  minLength?: number;
  pattern?: string;
}

export interface IntegerInputSchema {
  type: 'integer';
  description?: string;
  minimum?: number;
  maximum?: number;
}

export interface StringArrayInputSchema {
  type: 'array';
  description?: string;
  items: StringInputSchema;
}

type FieldInputSchema = StringInputSchema | IntegerInputSchema | StringArrayInputSchema;

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, FieldInputSchema>;
  required: string[];
  additionalProperties: false;
}

export interface InputValidationIssue {
  path: string;
  keyword: 'type' | 'required' | 'additionalProperties' | 'minLength' | 'pattern' | 'minimum' | 'maximum';
  message: string;
}

type Validator = (value: unknown, path: string) => InputValidationIssue | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(schema: Record<string, unknown>, allowed: string[], path: string): void {
  const unsupported = Object.keys(schema).find((key) => !allowed.includes(key));
  if (unsupported) throw new Error(`${path}: unsupported input schema keyword "${unsupported}"`);
  if (schema.description !== undefined && typeof schema.description !== 'string') {
    throw new Error(`${path}: schema description must be a string`);
  }
}

function compileField(schema: unknown, path: string): Validator {
  if (!isObject(schema)) throw new Error(`${path}: field schema must be an object`);
  switch (schema.type) {
    case 'string': {
      checkKeys(schema, ['type', 'description', 'minLength', 'pattern'], path);
      const minimum = schema.minLength;
      if (minimum !== undefined && (typeof minimum !== 'number' || !Number.isSafeInteger(minimum) || minimum < 0)) {
        throw new Error(`${path}: schema minLength must be a nonnegative safe integer`);
      }
      if (schema.pattern !== undefined && typeof schema.pattern !== 'string') {
        throw new Error(`${path}: schema pattern must be a string`);
      }
      const pattern = schema.pattern === undefined ? undefined : new RegExp(schema.pattern as string, 'u');
      return (value, argumentPath) => {
        if (typeof value !== 'string') return { path: argumentPath, keyword: 'type', message: 'must be a string' };
        if (minimum !== undefined && [...value].length < (minimum as number)) {
          return { path: argumentPath, keyword: 'minLength', message: `must have at least ${minimum} character(s)` };
        }
        if (pattern && !pattern.test(value)) return { path: argumentPath, keyword: 'pattern', message: 'does not match the declared pattern' };
        return undefined;
      };
    }
    case 'integer': {
      checkKeys(schema, ['type', 'description', 'minimum', 'maximum'], path);
      const minimum = schema.minimum;
      const maximum = schema.maximum;
      for (const [key, value] of [['minimum', minimum], ['maximum', maximum]] as const) {
        if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
          throw new Error(`${path}: schema ${key} must be a safe integer`);
        }
      }
      if (minimum !== undefined && maximum !== undefined && (minimum as number) > (maximum as number)) {
        throw new Error(`${path}: schema minimum exceeds maximum`);
      }
      return (value, argumentPath) => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          return { path: argumentPath, keyword: 'type', message: 'must be a safe integer' };
        }
        if (minimum !== undefined && value < (minimum as number)) {
          return { path: argumentPath, keyword: 'minimum', message: `must be at least ${minimum}` };
        }
        if (maximum !== undefined && value > (maximum as number)) {
          return { path: argumentPath, keyword: 'maximum', message: `must be at most ${maximum}` };
        }
        return undefined;
      };
    }
    case 'array': {
      checkKeys(schema, ['type', 'description', 'items'], path);
      if (!isObject(schema.items) || schema.items.type !== 'string') {
        throw new Error(`${path}: only arrays with a string items schema are supported`);
      }
      const item = compileField(schema.items, `${path}.items`);
      return (value, argumentPath) => {
        if (!Array.isArray(value)) return { path: argumentPath, keyword: 'type', message: 'must be an array' };
        for (let index = 0; index < value.length; index++) {
          const issue = item(value[index], `${argumentPath}[${index}]`);
          if (issue) return issue;
        }
        return undefined;
      };
    }
    default:
      throw new Error(`${path}: unsupported input schema type "${String(schema.type)}"`);
  }
}

/** Compile once from the advertised schema; validation never coerces or supplies field defaults. */
export function compileToolInputSchema(schema: unknown): (value: unknown) => InputValidationIssue | undefined {
  if (!isObject(schema)) throw new Error('inputSchema must be an object');
  checkKeys(schema, ['type', 'properties', 'required', 'additionalProperties'], 'inputSchema');
  if (schema.type !== 'object' || !isObject(schema.properties) || schema.additionalProperties !== false) {
    throw new Error('inputSchema requires type object, declared properties and additionalProperties false');
  }
  if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string' || !Object.hasOwn(schema.properties!, name))) {
    throw new Error('inputSchema required must contain only declared property names');
  }
  const required = schema.required as string[];
  const fields = new Map(Object.entries(schema.properties).map(([key, field]) => [key, compileField(field, `inputSchema.properties.${key}`)]));
  return (value) => {
    if (!isObject(value)) return { path: 'arguments', keyword: 'type', message: 'must be an object' };
    for (const key of required) {
      if (!Object.hasOwn(value, key)) return { path: `arguments.${key}`, keyword: 'required', message: `missing required argument "${key}"` };
    }
    for (const key of Object.keys(value)) {
      const field = fields.get(key);
      if (!field) return { path: `arguments.${key}`, keyword: 'additionalProperties', message: 'unknown argument' };
      const issue = field(value[key], `arguments.${key}`);
      if (issue) return issue;
    }
    return undefined;
  };
}
