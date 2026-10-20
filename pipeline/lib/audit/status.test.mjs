import test from 'node:test';
import assert from 'node:assert/strict';
import { worse, fileStatus, pickBest, isProblem } from './status.mjs';

test('worse ranks bad over everything and n/a under everything', () => {
  assert.equal(worse('ok', 'bad'), 'bad');
  assert.equal(worse('bad', 'suspect'), 'bad');
  assert.equal(worse('n/a', 'ok'), 'ok');
  assert.equal(worse('placeholder', 'missing'), 'missing');
  assert.equal(worse('suspect', 'placeholder'), 'placeholder');
});

test('fileStatus tells placeholders from empty files', () => {
  assert.equal(fileStatus(null), 'missing');
  assert.equal(fileStatus({ size: 0, placeholder: true }), 'placeholder');
  assert.equal(fileStatus({ size: 0, placeholder: false }), 'empty');
  assert.equal(fileStatus({ size: 10, placeholder: false }), 'ok');
  assert.ok(isProblem('empty') && isProblem('bad') && isProblem('missing') && !isProblem('placeholder'));
});

test('pickBest prefers real bytes, then the preferred extension, then size', () => {
  const ph = { ext: 'mp4', size: 0, placeholder: true };
  const mov = { ext: 'mov', size: 5, placeholder: false };
  const mp4 = { ext: 'mp4', size: 3, placeholder: false };
  assert.equal(pickBest([ph, mov], ['mp4', 'mov']), mov);
  assert.equal(pickBest([mov, mp4], ['mp4', 'mov']), mp4);
  assert.equal(pickBest([], ['mp4']), null);
});
