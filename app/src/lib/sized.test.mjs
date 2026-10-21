import test from 'node:test';
import assert from 'node:assert/strict';
import { whenSized } from './sized.js';

// Stands in for ResizeObserver: fire() runs the callback the way a layout change would.
function fakeObserver() {
  const log = { made: 0, observed: null, disconnected: false, fire: null };
  class Observer {
    constructor(cb) {
      log.made++;
      log.fire = () => cb([], this);
    }
    observe(el) {
      log.observed = el;
    }
    disconnect() {
      log.disconnected = true;
    }
  }
  return { Observer, log };
}

const settled = async (p) => {
  let done = false;
  p.then(() => (done = true));
  await new Promise(setImmediate);
  return done;
};

test('whenSized: an element with a size resolves at once', async () => {
  const { Observer, log } = fakeObserver();
  assert.equal(await settled(whenSized({ clientWidth: 1280, clientHeight: 653 }, Observer)), true);
  assert.equal(log.made, 0, 'no observer needed');
});

test('whenSized: a 0×0 element waits for both a width and a height', async () => {
  const { Observer, log } = fakeObserver();
  const el = { clientWidth: 0, clientHeight: 0 };
  const p = whenSized(el, Observer);
  assert.equal(log.observed, el);
  assert.equal(await settled(p), false);
  el.clientWidth = 960; // e.g. width from the host page, height still 0
  log.fire();
  assert.equal(await settled(p), false);
  assert.equal(log.disconnected, false);
  el.clientHeight = 540;
  log.fire();
  assert.equal(await settled(p), true);
  assert.equal(log.disconnected, true);
});

test('whenSized: without ResizeObserver it does not wait', async () => {
  assert.equal(await settled(whenSized({ clientWidth: 0, clientHeight: 0 }, null)), true);
});
