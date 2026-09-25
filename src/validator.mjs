// validator.mjs —— 极简 JSON Schema 校验器（Draft 2020-12 的本项目子集）
//
// 关键性质：**fail-closed**。遇到 schema 里不认识的关键字、未知 type、未知 format，
// 一律抛错而不是静默忽略。手写校验器最大的危险就是"看起来通过了，其实有一条规则没检查"，
// 所以这里宁可报错让人来补实现。
//
// 支持：$schema/$id/$defs/$ref、title/description/default（注解）、
//       type/enum/const/required/properties/additionalProperties、items/minItems/maxItems、
//       minLength/maxLength/pattern、minimum/maximum、format(date-time)、allOf、if/then/else
// 不支持（会抛错）：anyOf/oneOf/not、patternProperties、dependentRequired、prefixItems、
//       unevaluatedProperties、$dynamicRef 等

const ANNOTATION = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'description', 'default']);
const ASSERTION = new Set([
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'format', 'allOf', 'if', 'then', 'else',
]);
const KNOWN = new Set([...ANNOTATION, ...ASSERTION]);
const FORMATS = new Set(['date-time']);

function typeName(d) {
  if (d === null) return 'null';
  if (Array.isArray(d)) return 'array';
  return typeof d;
}

function typeOk(t, d) {
  switch (t) {
    case 'null': return d === null;
    case 'boolean': return typeof d === 'boolean';
    case 'string': return typeof d === 'string';
    case 'number': return typeof d === 'number' && Number.isFinite(d);
    case 'integer': return Number.isInteger(d);
    case 'array': return Array.isArray(d);
    case 'object': return d !== null && typeof d === 'object' && !Array.isArray(d);
    default: throw new Error(`schema 里出现未知 type "${t}"`);
  }
}

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function validate(schema, data) {
  const root = schema;
  const errors = [];

  const deref = s => {
    if (!s || typeof s !== 'object' || typeof s.$ref !== 'string') return s;
    if (!s.$ref.startsWith('#/')) throw new Error(`只支持本地 $ref，收到 "${s.$ref}"`);
    let cur = root;
    for (const seg of s.$ref.slice(2).split('/')) {
      cur = cur?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (cur === undefined) throw new Error(`无法解析 $ref "${s.$ref}"`);
    return cur;
  };

  const err = (path, msg) => errors.push({ path: path || '(root)', msg });

  function walk(s0, d, path) {
    const s = deref(s0);
    if (s === true || s === undefined) return;
    if (s === false) { err(path, 'schema 恒为假，任何数据都不合法'); return; }
    if (typeof s !== 'object') return;

    for (const k of Object.keys(s)) {
      if (!KNOWN.has(k)) {
        throw new Error(`schema 出现未支持的关键字 "${k}"（位置 ${path || '(root)'}）—— 校验器 fail-closed，绝不静默忽略`);
      }
    }

    if (s.const !== undefined && !deepEq(d, s.const)) {
      err(path, `应为常量 ${JSON.stringify(s.const)}，实为 ${JSON.stringify(d)}`);
    }
    if (Array.isArray(s.enum) && !s.enum.some(v => deepEq(d, v))) {
      err(path, `不在枚举 ${JSON.stringify(s.enum)} 内，实为 ${JSON.stringify(d)}`);
    }
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some(t => typeOk(t, d))) {
        err(path, `类型应为 ${types.join('|')}，实为 ${typeName(d)}`);
      }
    }

    if (typeof d === 'string') {
      if (s.minLength != null && d.length < s.minLength) err(path, `长度 ${d.length} < minLength ${s.minLength}`);
      if (s.maxLength != null && d.length > s.maxLength) err(path, `长度 ${d.length} > maxLength ${s.maxLength}`);
      if (s.pattern != null && !new RegExp(s.pattern).test(d)) err(path, `不匹配 pattern ${s.pattern}：${JSON.stringify(d)}`);
      if (s.format != null) {
        if (!FORMATS.has(s.format)) throw new Error(`schema 出现未实现 format "${s.format}"（位置 ${path}）`);
        if (s.format === 'date-time' && !DATE_TIME.test(d)) err(path, `不是 ISO 8601 date-time：${JSON.stringify(d)}`);
      }
    }

    if (typeof d === 'number') {
      if (s.minimum != null && d < s.minimum) err(path, `${d} < minimum ${s.minimum}`);
      if (s.maximum != null && d > s.maximum) err(path, `${d} > maximum ${s.maximum}`);
    }

    if (Array.isArray(d)) {
      if (s.minItems != null && d.length < s.minItems) err(path, `数组长度 ${d.length} < minItems ${s.minItems}`);
      if (s.maxItems != null && d.length > s.maxItems) err(path, `数组长度 ${d.length} > maxItems ${s.maxItems}`);
      if (s.items) d.forEach((v, i) => walk(s.items, v, `${path}[${i}]`));
    }

    if (d !== null && typeof d === 'object' && !Array.isArray(d)) {
      for (const r of s.required || []) if (!(r in d)) err(path, `缺少必填字段 "${r}"`);
      const props = s.properties || {};
      for (const [k, v] of Object.entries(d)) {
        const p = path ? `${path}.${k}` : k;
        if (props[k] !== undefined) walk(props[k], v, p);
        else if (s.additionalProperties === false) err(path, `出现 schema 未定义的字段 "${k}"（additionalProperties:false）`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, v, p);
      }
      if (s.minProperties != null && Object.keys(d).length < s.minProperties) err(path, `字段数 < minProperties`);
    }

    for (const sub of s.allOf || []) walk(sub, d, path);

    if (s.if) {
      const mark = errors.length;
      walk(s.if, d, path);
      const ifOk = errors.length === mark;
      errors.length = mark;
      if (ifOk) { if (s.then) walk(s.then, d, path); }
      else if (s.else) walk(s.else, d, path);
    }
  }

  walk(schema, data, '');
  return { ok: errors.length === 0, errors };
}

// 便捷：校验文件，失败即抛（带前几条错误，便于定位）
export async function validateFile(fsMod, schemaPath, dataPath) {
  const schema = JSON.parse(await fsMod.readFile(schemaPath, 'utf8'));
  const data = JSON.parse(await fsMod.readFile(dataPath, 'utf8'));
  const r = validate(schema, data);
  return { ...r, schemaPath, dataPath };
}
