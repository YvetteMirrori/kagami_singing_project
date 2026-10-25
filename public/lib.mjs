export const MAX_CHARS = 16000;
export const MAX_LINES = 200;

export function stripReadings(text) {
  return text.replace(/([\p{Script=Han}々〆ヶヵA-Za-zＡ-Ｚａ-ｚ]+)[（(][\p{Script=Hiragana}\p{Script=Katakana}ー\s]+[）)]/gu, '$1');
}
export function normalizeCharacters(text) {
  return text.normalize('NFKC')
    .replace(/[、]/gu, ',').replace(/[。]/gu, '.')
    .replace(/[「」『』“”]/gu, '"').replace(/[‘’]/gu, "'");
}
// Punctuation is restored from the source locally; only lyric text must match.
export function canonical(text) { return normalizeCharacters(stripReadings(text)).replace(/[\s\p{P}]/gu, ''); }

function isSpacedRomaji(text, original) {
  // References copied from music services often contain punctuation, quoted
  // words, long-vowel spellings ("oo", "kee") and embedded English. Strip
  // those decorations before checking whether the line is syllable-spaced.
  let reference = text.normalize('NFKC').toLowerCase();
  const foreign = original.normalize('NFKC').match(/[A-Za-z][A-Za-z0-9]*(?:[ \t]+[A-Za-z][A-Za-z0-9]*)*/g) || [];
  for (const phrase of foreign) {
    // Only allow foreign words already present in the original. Acronyms may
    // be joined to a Japanese particle in copied references, e.g. "IQga".
    const pattern = phrase.toLowerCase().split(/\s+/).join('\\s+');
    reference = reference.replace(new RegExp(`\\b${pattern}(?=$|[^a-z0-9]|(?:ga|wa|wo|ni|to|de)(?:\\s|$))`, 'g'), ' ');
  }
  const pieces = reference
    .replace(/[「」『』"“”'’?!.,:;，。！？、~\-]/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
  const syllable = /^(?:n|(?:[kgsztdnhbpmrywfvj]?[hy]?|sh|ch|tch|ts|ssh|(?:tt|kk|pp|ss|gg|bb|dd|zz|jj|ff)y?)([aeiou])\1*)$/;
  return pieces.length >= 3 && pieces.every(piece => syllable.test(piece));
}
export function parseLyrics(text, mode = 'auto') {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请先输入歌词。');
  if (text.length > MAX_CHARS) throw new Error(`歌词最多 ${MAX_CHARS.toLocaleString()} 个字符，请分段分析。`);
  if (!['auto', 'raw', 'paired'].includes(mode)) throw new Error('输入格式无效。');
  const rows = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const original = rows[i];
    let reference = '';
    if (mode === 'paired') {
      if (!rows[i + 1] || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(rows[i + 1])) throw new Error(`第 ${i + 1} 行后缺少参考罗马音，请检查输入格式。`);
      reference = rows[++i];
    } else if (mode === 'auto' && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(original) && rows[i + 1] && isSpacedRomaji(rows[i + 1], original)) {
      reference = rows[++i];
    }
    lines.push({ id: lines.length + 1, original, reference });
  }
  if (lines.length > MAX_LINES) throw new Error(`一次最多分析 ${MAX_LINES} 句，请分段输入。`);
  return lines;
}
const str = { type: 'string' };
export const analysisSchema = {
  type: 'object', additionalProperties: false, required: ['lines'],
  properties: { lines: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'original', 'translation', 'tokens'],
    properties: { id: { type: 'integer' }, original: str, translation: str,
      tokens: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['surface', 'annotated', 'romaji', 'meaning'],
        properties: { surface: str, annotated: str, romaji: str, meaning: str }
      } }
    }
  } } }
};
export function validateAnalysis(value, expected) {
  if (!value || !Array.isArray(value.lines) || !value.lines.length || value.lines.length > MAX_LINES) throw new Error('分析结果缺少有效的句子。');
  if (expected && value.lines.length !== expected.length) throw new Error('模型遗漏或增加了句子。');
  let count = 0;
  for (const [index, line] of value.lines.entries()) {
    if (!line || !Number.isInteger(line.id) || line.id !== (expected?.[index]?.id ?? index + 1)) throw new Error('句子编号或顺序不正确。');
    if (typeof line.original !== 'string' || !line.original.trim() || line.original.length > MAX_CHARS || typeof line.translation !== 'string' || !line.translation.trim() || line.translation.length > 4000) throw new Error(`第 ${line.id} 句缺少原文或整句翻译。`);
    if (expected && line.original !== expected[index].original) throw new Error(`第 ${line.id} 句的原文被修改。`);
    if (!Array.isArray(line.tokens) || !line.tokens.length || line.tokens.length > 500) throw new Error(`第 ${line.id} 句没有有效分词。`);
    count += line.tokens.length;
    if (count > 10000) throw new Error('分析结果过大，请分段导入。');
    for (const token of line.tokens) {
      if (!token || ['surface', 'annotated', 'romaji', 'meaning'].some(k => typeof token[k] !== 'string' || !token[k].trim() || token[k].length > 1000)) throw new Error(`第 ${line.id} 句的词格资料不完整。`);
      if (canonical(token.surface) !== canonical(token.annotated)) throw new Error(`第 ${line.id} 句的标音改变了原词。`);
    }
    if (canonical(line.tokens.map(t => t.surface).join('')) !== canonical(line.original)) throw new Error(`第 ${line.id} 句的分词与原文不一致（存在漏字、多字或语序变化）。`);
  }
  return value;
}
export function toFourLines(data) {
  return data.lines.map((line, i) => `${i + 1}. ${line.tokens.map(t => t.romaji).join(' | ')}\n${line.tokens.map(t => t.annotated).join(' | ')}\n${line.tokens.map(t => t.meaning).join(' | ')}\n${line.translation}`).join('\n\n');
}
