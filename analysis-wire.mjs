import { stripReadings, validateAnalysis } from './public/lib.mjs';

const str = { type: 'string' };
export const compactSchema = {
  type: 'object', additionalProperties: false, required: ['lines'],
  properties: { lines: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 't', 'w'],
    properties: { id: { type: 'integer' }, t: str, w: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['a', 'r', 'm'],
      properties: { a: str, r: str, m: str }
    } } }
  } } }
};

export function expandLine(row, expected) {
  const line = Array.isArray(row?.w) ? {
    id: row.id, original: expected.original, translation: row.t,
    tokens: row.w.map(word => ({
      surface: typeof word?.a === 'string' ? stripReadings(word.a) : '',
      annotated: word?.a, romaji: word?.r, meaning: word?.m
    }))
  } : row;
  return validateAnalysis({ lines: [line] }, [expected]).lines[0];
}

export function planAnalysis(lines) {
  const first = new Map();
  const representatives = [];
  const sourceIds = lines.map(line => {
    // Different reading references must never share an analysis.
    const key = JSON.stringify([line.original, line.reference]);
    if (!first.has(key)) { first.set(key, line.id); representatives.push(line); }
    return first.get(key);
  });
  return { representatives, sourceIds };
}
