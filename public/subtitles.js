const SRT_TIME = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})(.*)$/;
const ASS_SECTION = /^\s*\[(.+)]\s*$/;

export function msFromSrtTime(h, m, s, ms) {
  return (+h * 3600 + +m * 60 + +s) * 1000 + +ms;
}

export function parseSrt(input) {
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return { format: 'srt', cues: [] };

  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let cursor = 0;
    let index = String(cues.length + 1);
    if (/^\d+$/.test(lines[0]?.trim() || '')) {
      index = lines[0].trim();
      cursor = 1;
    }
    const timing = lines[cursor]?.match(SRT_TIME);
    if (!timing) continue;
    const [, sh, sm, ss, sms, eh, em, es, ems, suffix] = timing;
    const text = lines.slice(cursor + 1).join('\n');
    cues.push({
      id: cues.length,
      index,
      startRaw: `${sh}:${sm}:${ss},${sms}`,
      endRaw: `${eh}:${em}:${es},${ems}${suffix || ''}`,
      startMs: msFromSrtTime(sh, sm, ss, sms),
      endMs: msFromSrtTime(eh, em, es, ems),
      original: text,
      translated: text
    });
  }
  return { format: 'srt', cues };
}

export function renderSrt(doc) {
  return doc.cues.map((cue, i) => [
    cue.index || String(i + 1),
    `${cue.startRaw} --> ${cue.endRaw}`,
    cue.translated ?? cue.original ?? ''
  ].join('\n')).join('\n\n') + (doc.cues.length ? '\n' : '');
}

function splitAssDialogue(line, fieldCount) {
  const prefixMatch = line.match(/^(\s*Dialogue\s*:\s*)(.*)$/i);
  if (!prefixMatch) return null;
  const rest = prefixMatch[2];
  const parts = [];
  let start = 0;
  for (let i = 0; i < fieldCount - 1; i++) {
    const comma = rest.indexOf(',', start);
    if (comma === -1) return null;
    parts.push(rest.slice(start, comma));
    start = comma + 1;
  }
  parts.push(rest.slice(start));
  return { prefix: prefixMatch[1], parts };
}

export function assTimeToMs(value) {
  const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/);
  if (!match) return 0;
  const [, h, m, s, cs] = match;
  return (+h * 3600 + +m * 60 + +s) * 1000 + +cs.padEnd(2, '0') * 10;
}

export function parseAss(input) {
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  let section = '';
  let formatFields = ['Layer','Start','End','Style','Name','MarginL','MarginR','MarginV','Effect','Text'];
  const cues = [];

  lines.forEach((line, lineIndex) => {
    const sec = line.match(ASS_SECTION);
    if (sec) {
      section = sec[1].toLowerCase();
      return;
    }
    if (section === 'events' && /^\s*Format\s*:/i.test(line)) {
      formatFields = line.replace(/^\s*Format\s*:\s*/i, '').split(',').map(v => v.trim());
      return;
    }
    if (section !== 'events' || !/^\s*Dialogue\s*:/i.test(line)) return;
    const split = splitAssDialogue(line, formatFields.length);
    if (!split) return;
    const textIndex = formatFields.findIndex(v => v.toLowerCase() === 'text');
    const startIndex = formatFields.findIndex(v => v.toLowerCase() === 'start');
    const endIndex = formatFields.findIndex(v => v.toLowerCase() === 'end');
    if (textIndex < 0) return;
    const text = split.parts[textIndex] ?? '';
    cues.push({
      id: cues.length,
      lineIndex,
      prefix: split.prefix,
      parts: split.parts,
      textIndex,
      startMs: startIndex >= 0 ? assTimeToMs(split.parts[startIndex]) : 0,
      endMs: endIndex >= 0 ? assTimeToMs(split.parts[endIndex]) : 0,
      original: text,
      translated: text
    });
  });

  return { format: 'ass', sourceLines: lines, cues };
}

export function renderAss(doc) {
  const lines = [...doc.sourceLines];
  for (const cue of doc.cues) {
    const parts = [...cue.parts];
    parts[cue.textIndex] = cue.translated ?? cue.original ?? '';
    lines[cue.lineIndex] = cue.prefix + parts.join(',');
  }
  return lines.join('\n');
}

export function detectFormat(filename, text = '') {
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'ass') return 'ass';
  if (ext === 'srt') return 'srt';
  if (/^\s*\[script info\]/im.test(text) || /^\s*Dialogue\s*:/im.test(text)) return 'ass';
  return 'srt';
}

export function parseSubtitle(filename, text) {
  return detectFormat(filename, text) === 'ass' ? parseAss(text) : parseSrt(text);
}

export function renderSubtitle(doc) {
  return doc.format === 'ass' ? renderAss(doc) : renderSrt(doc);
}

export function protectAssText(text) {
  const tokens = [];
  let protectedText = String(text ?? '');
  protectedText = protectedText.replace(/\{[^}]*\}|\\[Nnh]|<\/?[a-zA-Z][^>]*>/g, (match) => {
    const token = `⟦S${tokens.length}⟧`;
    tokens.push([token, match]);
    return token;
  });
  return { protectedText, tokens };
}

export function restoreAssText(text, tokens = []) {
  let out = String(text ?? '');
  for (const [token, original] of tokens) out = out.split(token).join(original);
  return out;
}

export function getMissingTokens(text, tokens = []) {
  return tokens.filter(([token]) => !String(text ?? '').includes(token)).map(([token]) => token);
}

export function cueDuration(cue) {
  return Math.max(0, (cue.endMs || 0) - (cue.startMs || 0));
}

export function charsPerSecond(cue, text = cue.translated ?? cue.original ?? '') {
  const seconds = cueDuration(cue) / 1000;
  const visible = String(text).replace(/\{[^}]*\}|\\[Nnh]|<[^>]+>/g, '').length;
  return seconds > 0 ? visible / seconds : 0;
}
