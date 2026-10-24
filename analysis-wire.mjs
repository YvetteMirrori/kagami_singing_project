import { canonical, normalizeCharacters, stripReadings, validateAnalysis } from './public/lib.mjs';

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

function sourceProjection(original) {
  const source = stripReadings(original);
  const units = [];
  for (let offset = 0; offset < source.length;) {
    const character = String.fromCodePoint(source.codePointAt(offset));
    const end = offset + character.length;
    if (!/\s/u.test(character)) {
      for (const normalized of normalizeCharacters(character)) {
        if (!/\s/u.test(normalized)) units.push({ normalized, start: offset, end });
      }
    }
    offset = end;
  }
  return { source, units, cursor: 0 };
}

function restoreSurface(segment, projection, lineId) {
  const expected = Array.from(canonical(segment));
  const units = projection.units.slice(projection.cursor, projection.cursor + expected.length);
  if (units.length !== expected.length || units.map(unit => unit.normalized).join('') !== expected.join('')) {
    throw new Error(`第 ${lineId} 句的分词含有无法对齐的字符（可能是漏字或标点）。`);
  }
  projection.cursor += expected.length;
  return units.length ? projection.source.slice(units[0].start, units.at(-1).end) : '';
}

function restoreAnnotated(annotation, projection, lineId) {
  const readings = /([\p{Script=Han}々〆ヶヵ]+)[（(]([\p{Script=Hiragana}\p{Script=Katakana}ー\s]+)[）)]/gu;
  let offset = 0;
  let restored = '';
  for (const match of annotation.matchAll(readings)) {
    restored += restoreSurface(annotation.slice(offset, match.index), projection, lineId);
    restored += restoreSurface(match[1], projection, lineId);
    restored += `（${match[2]}）`;
    offset = match.index + match[0].length;
  }
  return restored + restoreSurface(annotation.slice(offset), projection, lineId);
}

export function expandLine(row, expected) {
  const projection = sourceProjection(expected.original);
  const line = Array.isArray(row?.w) ? {
    id: row.id, original: expected.original, translation: row.t,
    tokens: row.w.map(word => {
      const annotated = typeof word?.a === 'string' ? restoreAnnotated(word.a, projection, expected.id) : '';
      return { surface: stripReadings(annotated), annotated, romaji: word?.r, meaning: word?.m };
    })
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
