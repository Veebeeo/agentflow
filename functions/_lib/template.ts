/**
 * Placeholder resolution for step config.
 *
 * Steps refer to earlier results as {{steps.0.output.text}}, to the trigger
 * payload as {{run.input.email}}, and to stored credentials as
 * {{secrets.STRIPE_KEY}}.
 *
 * This is a lookup over a fixed context object, not an expression evaluator.
 * There is no eval, no Function constructor and no template engine, because
 * step config is tenant-controlled input and any of those turns a workflow
 * builder into remote code execution.
 */

export interface TemplateContext {
  run: { input: unknown; id: string };
  steps: Record<string, { output: unknown; status: string }>;
  secrets: Record<string, string>;
  now: string;
}

const PATTERN = /\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g;
const MAX_DEPTH = 8;

function readPath(context: TemplateContext, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current: unknown = context;

  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    // Own properties only. Without this, {{constructor.prototype}} walks out of
    // the context object and into the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function renderString(input: string, context: TemplateContext): string {
  return input.replace(PATTERN, (_match, path: string) => stringify(readPath(context, path)));
}

/**
 * Walks a config object and resolves every string leaf.
 * `usedSecrets` collects the names that were substituted so the caller can
 * redact them before persisting the step input.
 */
export function renderValue<T>(value: T, context: TemplateContext, depth = 0): T {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return renderString(value, context) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => renderValue(v, context, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderValue(v, context, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** Which {{secrets.X}} names a config references, so only those get decrypted. */
export function referencedSecrets(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > MAX_DEPTH) return found;
  if (typeof value === 'string') {
    for (const match of value.matchAll(PATTERN)) {
      const path = match[1] ?? '';
      if (path.startsWith('secrets.')) {
        const name = path.slice('secrets.'.length).split('.')[0];
        if (name) found.add(name);
      }
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => referencedSecrets(v, found, depth + 1));
    return found;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((v) => referencedSecrets(v, found, depth + 1));
  }
  return found;
}

/** Replaces resolved secret values with a marker before anything is stored. */
export function redactSecretValues<T>(value: T, secrets: Record<string, string>): T {
  const values = Object.values(secrets).filter((v) => v.length >= 6);
  if (values.length === 0) return value;

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return node;
    if (typeof node === 'string') {
      return values.reduce((acc, secret) => acc.split(secret).join('[secret]'), node);
    }
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v, depth + 1);
      return out;
    }
    return node;
  };

  return walk(value, 0) as T;
}
