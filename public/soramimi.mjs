import { mapping, syllables } from './soramimi-data.mjs';

const geminates = new Set('bcdfghjkmprstz');

function convertChunk(chunk) {
  const lower = chunk.toLowerCase();
  const parts = [];
  let at = 0;
  while (at < lower.length) {
    // Keep the extra consonant of a small tsu. The table supplies no Chinese
    // spelling for it. Markers such as ~ are preserved by the caller too.
    if (geminates.has(lower[at]) && (lower[at] === lower[at + 1] || lower.startsWith('tch', at))) {
      parts.push(chunk[at++]);
      continue;
    }
    const acronym = chunk.slice(at).match(/^[A-Z]{2,}(?=[a-z]|$)/);
    if (acronym) {
      parts.push(acronym[0]);
      at += acronym[0].length;
      continue;
    }
    const mora = syllables.find(key => lower.startsWith(key, at));
    if (!mora) {
      // Keep an unrecognized remainder intact instead of mapping fragments
      // inside unsupported syllables such as "thi" or "che".
      parts.push(chunk.slice(at));
      break;
    }
    const raw = chunk.slice(at, at + mora.length);
    parts.push(mapping[mora] && mapping[mora] !== mora ? mapping[mora] : raw);
    at += mora.length;
  }
  return parts.join('');
}

export function toSoramimi(romaji, surface = '') {
  // English/German lyric tokens keep their original spelling, even if a word
  // happens to be segmentable into Japanese morae (e.g. "My", "made").
  if (/[A-Za-z]/.test(surface) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(surface)) return romaji;
  return romaji.replace(/[\p{L}\p{M}]+/gu, convertChunk);
}
