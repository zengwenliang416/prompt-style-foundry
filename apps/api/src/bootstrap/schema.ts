import apiDocument from '@onepic/contracts/openapi/api-v1.json' with { type: 'json' };

/**
 * Schema access for fastify request/response validation.
 *
 * Fastify's validator/serializer resolve `$ref` pointers only inside a single
 * schema object, so contract schemas taken from the OpenAPI document must be
 * dereferenced before being handed to a route. The document itself stays the
 * single source of truth; this module never re-declares schema content.
 */

type SchemaMap = Record<string, unknown>;

const components: SchemaMap =
  (apiDocument as unknown as { components?: { schemas?: SchemaMap } }).components?.schemas ?? {};

const REF_PREFIX = '#/components/schemas/';

function resolveRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(resolveRefs);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const ref = record['$ref'];
  if (typeof ref === 'string' && ref.startsWith(REF_PREFIX)) {
    const target = components[ref.slice(REF_PREFIX.length)];
    if (target === undefined) {
      throw new Error(`Unresolvable schema reference: ${ref}`);
    }
    return resolveRefs(target);
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    resolved[key] = resolveRefs(item);
  }
  return resolved;
}

/** Returns a fully dereferenced copy of the named contract schema. */
export function openApiSchema(name: string): Record<string, unknown> {
  const schema = components[name];
  if (schema === undefined) {
    throw new Error(`Schema "${name}" does not exist in the OpenAPI document.`);
  }
  return resolveRefs(schema) as Record<string, unknown>;
}
