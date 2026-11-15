/**
 * The output schema of the AI analysis contract v1 (§3.3): a narrow subset of JSON Schema the caller sends to say what
 * it wants back. Ported from the contract's `ai-contract-schema.mjs` so the engine reads a schema exactly as the
 * caller's checker does, with two holes closed: the subset's keywords are type-checked (`enum: 5` or `maxItems: "3"`
 * used to pass and then throw while validating), and a schema is bounded in depth and size (it arrives from the network).
 *
 *   type (string|number|integer|boolean|object|array|null; an array of them = a union, e.g. nullable)
 *   properties · required · additionalProperties (a schema or false) · items · maxItems · enum
 *   minimum · maximum · maxLength · description
 */

type Schema = Record<string, unknown>;

const KINDS = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'maxItems', 'enum', 'minimum', 'maximum', 'maxLength', 'description']);
const MAX_DEPTH = 32;
const MAX_NODES = 2000;

const isObject = (value: unknown): value is Schema => value !== null && typeof value === 'object' && !Array.isArray(value);
const typesOf = (schema: Schema): string[] => {
  const type = schema.type;
  return Array.isArray(type) ? type.filter((t): t is string => typeof t === 'string') : typeof type === 'string' ? [type] : [];
};
const kindOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};
/** `integer` satisfies `number`; otherwise the names must match. */
const matches = (want: string, got: string) => want === got || (want === 'number' && got === 'integer');
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

/**
 * Whether `schema` is inside the subset, as human-readable error lines (empty = readable). The engine checks this
 * before anything else: answering an unreadable schema in some other shape would make the caller believe it got
 * the shape it asked for. Used by the ai-analyze service (422 schema_unsupported).
 */
export function checkSchema(schema: unknown): string[] {
  const errors: string[] = [];
  let nodes = 0;
  const walk = (node: unknown, path: string, depth: number) => {
    if (errors.length >= 20) return;
    if (++nodes > MAX_NODES) { if (nodes === MAX_NODES + 1) errors.push(`$: 스키마가 너무 크다 (${MAX_NODES}개 마디 초과)`); return; }
    if (depth > MAX_DEPTH) { errors.push(`${path}: 스키마가 너무 깊다 (${MAX_DEPTH}단 초과)`); return; }
    if (!isObject(node)) { errors.push(`${path}: 스키마는 객체여야 한다`); return; }
    for (const key of Object.keys(node)) if (!KEYWORDS.has(key)) errors.push(`${path}: 부분집합에 없는 낱말 "${key}" (§3.3)`);
    const raw = node.type;
    if (raw === undefined) errors.push(`${path}: type 이 없다`);
    else if (typeof raw !== 'string' && !(Array.isArray(raw) && raw.length > 0 && raw.every((t) => typeof t === 'string'))) errors.push(`${path}: type 은 낱말 하나나 낱말 배열이어야 한다`);
    const types = typesOf(node);
    for (const type of types) if (!KINDS.has(type)) errors.push(`${path}: 모르는 type "${type}"`);
    if (node.enum !== undefined && !(Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)))) {
      errors.push(`${path}: enum 은 글자·숫자·참거짓·null 값의 비어 있지 않은 배열이어야 한다`);
    }
    if (node.maxItems !== undefined && !isCount(node.maxItems)) errors.push(`${path}: maxItems 는 0 이상의 정수여야 한다`);
    if (node.maxLength !== undefined && !isCount(node.maxLength)) errors.push(`${path}: maxLength 는 0 이상의 정수여야 한다`);
    for (const bound of ['minimum', 'maximum'] as const) {
      if (node[bound] !== undefined && !(typeof node[bound] === 'number' && Number.isFinite(node[bound]))) errors.push(`${path}: ${bound} 는 숫자여야 한다`);
    }
    if (typeof node.minimum === 'number' && typeof node.maximum === 'number' && node.minimum > node.maximum) errors.push(`${path}: minimum 이 maximum 보다 크다`);
    if (node.description !== undefined && typeof node.description !== 'string') errors.push(`${path}: description 은 글이어야 한다`);
    if (types.includes('object')) {
      const properties = node.properties ?? {};
      if (!isObject(properties)) errors.push(`${path}: properties 는 객체여야 한다`);
      else for (const [key, sub] of Object.entries(properties)) walk(sub, `${path}.${key}`, depth + 1);
      if (node.required !== undefined) {
        if (!Array.isArray(node.required) || !node.required.every((r) => typeof r === 'string')) errors.push(`${path}: required 는 글자 배열이어야 한다`);
        else for (const key of node.required) if (!isObject(properties) || !(key in properties)) errors.push(`${path}: required "${key}" 가 properties 에 없다`);
      }
      const extra = node.additionalProperties;
      if (extra !== undefined && typeof extra !== 'boolean') walk(extra, `${path}.*`, depth + 1);
    }
    if (types.includes('array')) {
      if (node.items === undefined) errors.push(`${path}: array 인데 items 가 없다`);
      else walk(node.items, `${path}[]`, depth + 1);
    }
  };
  walk(schema, '$', 0);
  return errors.slice(0, 20);
}

/**
 * Whether `value` satisfies a schema that passed checkSchema, as human-readable error lines (empty = valid).
 * Used by the ai-analyze service to check the model's answer before it is returned as `data`.
 */
export function validateAgainstSchema(schema: Schema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  const types = typesOf(schema);
  const got = kindOf(value);
  if (types.length && !types.some((type) => matches(type, got))) return [`${path}: ${types.join('|')} 를 기대했는데 ${got} 가 왔다`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) return [`${path}: ${JSON.stringify(value)} 는 enum 에 없다 (${schema.enum.join('|')})`];
  if (got === 'string' && typeof schema.maxLength === 'number' && (value as string).length > schema.maxLength) {
    errors.push(`${path}: ${(value as string).length}자 — maxLength ${schema.maxLength} 초과`);
  }
  if (got === 'number' || got === 'integer') {
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (got === 'array') {
    const items = value as unknown[];
    if (typeof schema.maxItems === 'number' && items.length > schema.maxItems) errors.push(`${path}: ${items.length}개 — maxItems ${schema.maxItems} 초과`);
    if (isObject(schema.items)) items.forEach((item, index) => errors.push(...validateAgainstSchema(schema.items as Schema, item, `${path}[${index}]`)));
  }
  if (got === 'object') {
    const object = value as Record<string, unknown>;
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required as string[] : []) {
      if (object[key] === undefined) errors.push(`${path}.${key}: 필수인데 없다`);
    }
    for (const [key, item] of Object.entries(object)) {
      if (item === undefined) continue;
      if (isObject(properties[key])) { errors.push(...validateAgainstSchema(properties[key] as Schema, item, `${path}.${key}`)); continue; }
      if (schema.additionalProperties === false) { errors.push(`${path}.${key}: 스키마에 없는 키다`); continue; }
      if (isObject(schema.additionalProperties)) errors.push(...validateAgainstSchema(schema.additionalProperties, item, `${path}.${key}`));
    }
  }
  return errors;
}

/**
 * The schema as a shape the model reads at a glance, derived from the schema so the two never drift apart.
 * Used by the ai-analyze service in the prompt next to the schema itself.
 */
export function schemaSketch(schema: Schema): string {
  const walk = (node: Schema): unknown => {
    const types = typesOf(node);
    if (types.includes('object')) {
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(isObject(node.properties) ? node.properties : {})) if (isObject(sub)) out[key] = walk(sub);
      if (isObject(node.additionalProperties)) out['<키>'] = walk(node.additionalProperties);
      return out;
    }
    if (types.includes('array')) return [isObject(node.items) ? walk(node.items) : 'any'];
    if (Array.isArray(node.enum)) return node.enum.map(String).join('|');
    const nullable = types.includes('null') ? '|null' : '';
    const base = types.filter((type) => type !== 'null').join('|') || 'any';
    const range = node.minimum !== undefined || node.maximum !== undefined ? ` ${node.minimum ?? ''}..${node.maximum ?? ''}` : '';
    return `${base}${range}${nullable}${typeof node.description === 'string' ? ` — ${node.description}` : ''}`;
  };
  return JSON.stringify(walk(schema), null, 2);
}

/**
 * The first complete JSON value in a model reply — code fences and prose around it allowed — or undefined.
 * Scans for balanced braces/brackets outside strings, so a stray `{` in prose before the answer is skipped.
 * Used by the ai-analyze service to read the model's JSON answer.
 */
export function extractJson(text: string): unknown {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index++;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  return undefined;
}
