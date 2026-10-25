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
    if (!/[\s\p{P}]/u.test(character)) {
      for (const normalized of normalizeCharacters(character)) {
        if (!/[\s\p{P}]/u.test(normalized)) units.push({ normalized, start: offset, end });
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
    throw new Error(`第 ${lineId} 句的分词含有无法对齐的正文字符（存在漏字、多字或语序变化）。`);
  }
  projection.cursor += expected.length;
  if (!units.length) return '';
  const start = projection.wordEnd ?? units[0].start;
  projection.wordEnd = units.at(-1).end;
  return projection.source.slice(start, projection.wordEnd);
}

function restoreAnnotated(annotation, projection, lineId) {
  const readings = /([\p{Script=Han}々〆ヶヵA-Za-zＡ-Ｚａ-ｚ]+)[（(]([\p{Script=Hiragana}\p{Script=Katakana}ー\s]+)[）)]/gu;
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
  if (!Array.isArray(row?.w)) return validateAnalysis({ lines: [row] }, [expected]).lines[0];
  const tokens = [];
  let end = 0;
  const addPunctuation = gap => {
    const marks = gap.replace(/\s/gu, '');
    if (marks) tokens.push({ surface: marks, annotated: marks, romaji: marks, meaning: marks });
  };
  for (const word of row.w) {
    if (typeof word?.a !== 'string' || !word.a.trim()) throw new Error(`第 ${expected.id} 句的词格资料不完整。`);
    // Standalone model punctuation is replaced by the exact source punctuation.
    if (!canonical(word.a)) continue;
    const start = projection.units[projection.cursor]?.start;
    projection.wordEnd = undefined;
    const annotated = restoreAnnotated(word.a, projection, expected.id);
    addPunctuation(projection.source.slice(end, start));
    const romaji = typeof word.r === 'string' ? word.r.replace(/^\p{P}+|\p{P}+$/gu, marks => marks.replace(/[^'’\-]/gu, '')) : word.r;
    tokens.push({ surface: stripReadings(annotated), annotated, romaji, meaning: word.m });
    end = projection.wordEnd;
  }
  if (projection.cursor !== projection.units.length) throw new Error(`第 ${expected.id} 句的分词遗漏了正文字符。`);
  addPunctuation(projection.source.slice(end));
  const line = { id: row.id, original: expected.original, translation: row.t, tokens };
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
