import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSrt, renderSrt, parseAss, renderAss,
  protectAssText, restoreAssText, getMissingTokens, charsPerSecond
} from '../public/subtitles.js';

test('SRT round-trip preserves times and edits text', () => {
  const src = `1\n00:00:01,000 --> 00:00:03,500\nHello!\n\n2\n00:00:04,000 --> 00:00:05,000\nWorld\n`;
  const doc = parseSrt(src);
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.cues[0].startMs, 1000);
  doc.cues[0].translated = 'Привет!';
  const out = renderSrt(doc);
  assert.match(out, /00:00:01,000 --> 00:00:03,500/);
  assert.match(out, /Привет!/);
});

test('ASS parser keeps commas inside Text and round-trips metadata', () => {
  const src = `[Script Info]\nTitle: Demo\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,A,0,0,0,,{\\an8}Hello, world\\NAgain\n`;
  const doc = parseAss(src);
  assert.equal(doc.cues.length, 1);
  assert.equal(doc.cues[0].original, '{\\an8}Hello, world\\NAgain');
  doc.cues[0].translated = '{\\an8}Привет, мир\\NСнова';
  const out = renderAss(doc);
  assert.match(out, /Dialogue: 0,0:00:01.00,0:00:03.00,Default,A,0,0,0,,\{\\an8\}Привет, мир\\NСнова/);
});

test('ASS formatting tokens can be protected and restored', () => {
  const src = '{\\an8}{\\i1}Hello\\Nworld{\\i0}';
  const p = protectAssText(src);
  assert.equal(p.tokens.length, 4);
  assert.deepEqual(getMissingTokens(p.protectedText, p.tokens), []);
  const translated = p.protectedText.replace('Hello', 'Привет').replace('world', 'мир');
  assert.equal(restoreAssText(translated, p.tokens), '{\\an8}{\\i1}Привет\\Nмир{\\i0}');
});

test('subtitle protection also preserves simple HTML tags', () => {
  const src = '<i>Hello</i>';
  const p = protectAssText(src);
  assert.equal(p.tokens.length, 2);
  assert.equal(restoreAssText(p.protectedText.replace('Hello', 'Привет'), p.tokens), '<i>Привет</i>');
});

test('charsPerSecond ignores ASS tags', () => {
  const cue = { startMs: 0, endMs: 2000, translated: '{\\i1}1234567890{\\i0}' };
  assert.equal(charsPerSecond(cue), 5);
});
