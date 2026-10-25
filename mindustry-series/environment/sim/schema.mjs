function canonical(value) {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
      : entry,
  );
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const show = (value) => JSON.stringify(value);
const where = (path) => (path ? `${path}: ` : '');
const join = (path, key) => (path ? `${path}.${key}` : String(key));
const chars = (text) => [...text].length;

function typeMatches(type, value) {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#')) throw new Error(`Unsupported $ref ${ref}`);
  return ref.slice(1).split('/').filter(Boolean).reduce((node, part) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

const KEYWORDS = {
  $ref: (rule, value, path, root) => check(resolveRef(root, rule), value, path, root),
  type(rule, value, path) {
    const types = Array.isArray(rule) ? rule : [rule];
    return types.some((type) => typeMatches(type, value)) ? null : `${where(path)}${show(value)} is not of type ${types.join(' or ')}`;
  },
  enum: (rule, value, path) => (rule.some((option) => canonical(option) === canonical(value)) ? null : `${where(path)}${show(value)} is not one of ${show(rule)}`),
  const: (rule, value, path) => (canonical(rule) === canonical(value) ? null : `${where(path)}${show(rule)} was expected`),
  minimum: (rule, value, path) => (typeof value === 'number' && value < rule ? `${where(path)}${value} is less than the minimum of ${rule}` : null),
  maximum: (rule, value, path) => (typeof value === 'number' && value > rule ? `${where(path)}${value} is greater than the maximum of ${rule}` : null),
  exclusiveMinimum: (rule, value, path) => (typeof value === 'number' && value <= rule ? `${where(path)}${value} must be greater than ${rule}` : null),
  exclusiveMaximum: (rule, value, path) => (typeof value === 'number' && value >= rule ? `${where(path)}${value} must be less than ${rule}` : null),
  multipleOf: (rule, value, path) => (typeof value === 'number' && !Number.isInteger(value / rule) ? `${where(path)}${value} is not a multiple of ${rule}` : null),
  minLength: (rule, value, path) => (typeof value === 'string' && chars(value) < rule ? `${where(path)}${show(value)} is shorter than ${rule} characters` : null),
  maxLength: (rule, value, path) => (typeof value === 'string' && chars(value) > rule ? `${where(path)}${show(value)} is longer than ${rule} characters` : null),
  pattern: (rule, value, path) => (typeof value === 'string' && !new RegExp(rule, 'u').test(value) ? `${where(path)}${show(value)} does not match ${show(rule)}` : null),
  minItems: (rule, value, path) => (Array.isArray(value) && value.length < rule ? `${where(path)}needs at least ${rule} items` : null),
  maxItems: (rule, value, path) => (Array.isArray(value) && value.length > rule ? `${where(path)}allows at most ${rule} items` : null),
  uniqueItems: (rule, value, path) => (rule && Array.isArray(value) && new Set(value.map(canonical)).size !== value.length ? `${where(path)}has repeated items` : null),
  prefixItems(rule, value, path, root) {
    if (!Array.isArray(value)) return null;
    for (let index = 0; index < rule.length && index < value.length; index += 1) {
      const problem = check(rule[index], value[index], join(path, index), root);
      if (problem) return problem;
    }
    return null;
  },
  items(rule, value, path, root, schema) {
    if (!Array.isArray(value)) return null;
    for (let index = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0; index < value.length; index += 1) {
      const problem = check(rule, value[index], join(path, index), root);
      if (problem) return problem;
    }
    return null;
  },
  contains: (rule, value, path, root) => (Array.isArray(value) && !value.some((item) => check(rule, item, path, root) == null) ? `${where(path)}has no item of the required kind` : null),
  required(rule, value, path) {
    if (!isObject(value)) return null;
    const missing = rule.find((name) => !Object.hasOwn(value, name));
    return missing == null ? null : `${show(join(path, missing))} is required`;
  },
  properties(rule, value, path, root) {
    if (!isObject(value)) return null;
    for (const [name, sub] of Object.entries(rule)) {
      const problem = Object.hasOwn(value, name) ? check(sub, value[name], join(path, name), root) : null;
      if (problem) return problem;
    }
    return null;
  },
  patternProperties(rule, value, path, root) {
    if (!isObject(value)) return null;
    for (const [pattern, sub] of Object.entries(rule)) {
      for (const name of Object.keys(value).filter((key) => new RegExp(pattern, 'u').test(key))) {
        const problem = check(sub, value[name], join(path, name), root);
        if (problem) return problem;
      }
    }
    return null;
  },
  additionalProperties(rule, value, path, root, schema) {
    if (!isObject(value)) return null;
    const patterns = Object.keys(schema.patternProperties ?? {}).map((pattern) => new RegExp(pattern, 'u'));
    const extras = Object.keys(value).filter((name) => !Object.hasOwn(schema.properties ?? {}, name) && !patterns.some((pattern) => pattern.test(name)));
    if (rule === false && extras.length) return `${extras.map((name) => show(join(path, name))).join(', ')} ${extras.length === 1 ? 'is' : 'are'} not allowed`;
    if (!isObject(rule)) return null;
    for (const name of extras) {
      const problem = check(rule, value[name], join(path, name), root);
      if (problem) return problem;
    }
    return null;
  },
  propertyNames(rule, value, path, root) {
    if (!isObject(value)) return null;
    for (const name of Object.keys(value)) if (check(rule, name, '', root)) return `${where(path)}${show(name)} is not an allowed name`;
    return null;
  },
  minProperties: (rule, value, path) => (isObject(value) && Object.keys(value).length < rule ? `${where(path)}needs at least ${rule} properties` : null),
  maxProperties: (rule, value, path) => (isObject(value) && Object.keys(value).length > rule ? `${where(path)}allows at most ${rule} properties` : null),
  dependentRequired(rule, value, path) {
    if (!isObject(value)) return null;
    for (const [name, needs] of Object.entries(rule)) {
      const missing = Object.hasOwn(value, name) ? needs.find((need) => !Object.hasOwn(value, need)) : undefined;
      if (missing != null) return `${show(join(path, missing))} is required with ${show(join(path, name))}`;
    }
    return null;
  },
  allOf(rule, value, path, root) {
    for (const sub of rule) {
      const problem = check(sub, value, path, root);
      if (problem) return problem;
    }
    return null;
  },
  anyOf: (rule, value, path, root) => (rule.some((sub) => check(sub, value, path, root) == null) ? null : `${where(path)}${show(value)} matches none of the allowed forms`),
  oneOf(rule, value, path, root) {
    const matches = rule.filter((sub) => check(sub, value, path, root) == null).length;
    return matches === 1 ? null : `${where(path)}${show(value)} must match exactly one allowed form (matches ${matches})`;
  },
  not: (rule, value, path, root) => (check(rule, value, path, root) == null ? `${where(path)}${show(value)} is not allowed` : null),
  if(rule, value, path, root, schema) {
    const branch = check(rule, value, path, root) == null ? schema.then : schema.else;
    return branch == null ? null : check(branch, value, path, root);
  },
};

function check(schema, value, path, root) {
  if (schema === true || schema == null) return null;
  if (schema === false) return `${where(path)}no value is allowed`;
  for (const [keyword, rule] of Object.entries(schema)) {
    const problem = KEYWORDS[keyword]?.(rule, value, path, root, schema) ?? null;
    if (problem) return problem;
  }
  return null;
}

export function validate(schema, value) {
  return check(schema, value, '', schema);
}
