import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyYouTube } from './youtube.mjs';

const cache = new Map([
  ['v6Lk_OP4ZKc', { state: 'public', embeddable: true }],
  ['QvYXpIm_Uxo', { state: 'unavailable', embeddable: false }],
  ['AAAAAAAAAAA', { state: 'public', embeddable: false }],
  ['Zp5XMfdjwB0', { state: 'public', embeddable: true }],
]);
const idUse = new Map([['Zp5XMfdjwB0', [508, 536]]]);
const sheet = (raw) => [{ src: 'sheet', raw }];

test('a clean public id is ok', () => {
  const r = classifyYouTube(1, sheet('https://youtu.be/v6Lk_OP4ZKc'), { cache, idUse });
  assert.equal(r.status, 'ok');
  assert.equal(r.id, 'v6Lk_OP4ZKc');
});

test('blank everywhere is missing; a malformed sheet id is bad', () => {
  assert.equal(classifyYouTube(6210, sheet(''), { cache }).status, 'missing');
  const r = classifyYouTube(2579, sheet('https://youtu.be/BassE45R51bs'), { cache });
  assert.equal(r.status, 'bad');
  assert.match(r.detail, /malformed/);
  assert.equal(classifyYouTube(3838, sheet('https://youtu.be/X0EL7MmYRF'), { cache }).status, 'bad');
});

test('the API snapshot marks removed videos bad and unembeddable ones suspect', () => {
  assert.equal(classifyYouTube(1545, sheet('QvYXpIm_Uxo'), { cache }).status, 'bad');
  assert.equal(classifyYouTube(60, sheet('AAAAAAAAAAA'), { cache }).status, 'suspect');
  assert.match(classifyYouTube(2, sheet('BBBBBBBBBBB'), { cache }).detail, /not in the API snapshot/);
});

test('one video for two songs, and sources that disagree, are suspect', () => {
  assert.match(classifyYouTube(508, sheet('Zp5XMfdjwB0'), { cache, idUse }).detail, /same video as #536/);
  const r = classifyYouTube(1, [...sheet('v6Lk_OP4ZKc'), { src: 'metadata', raw: 'https://youtu.be/CCCCCCCCCCC' }], { cache });
  assert.equal(r.status, 'suspect');
  assert.match(r.detail, /metadata has CCCCCCCCCCC/);
});
