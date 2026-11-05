import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimRefs, refPriority } from '../src/services/refs.ts';

const r = (role: string, id = role) => ({ role, id });
const ids = (a: { id: string }[]) => a.map((x) => x.id);

test('no trimming when refs fit', () => {
  const refs = [r('product'), r('style')];
  const t = trimRefs(refs, 3);
  assert.deepEqual(ids(t.kept), ['product', 'style']);
  assert.equal(t.dropped.length, 0);
  assert.equal(t.droppedStyle, false);
  assert.notEqual(t.kept, refs, 'returns a copy');
});

test('exact fit keeps everything', () => {
  const t = trimRefs([r('product'), r('model'), r('style')], 3);
  assert.equal(t.kept.length, 3);
  assert.equal(t.droppedStyle, false);
});

test('style is dropped first, original order preserved', () => {
  const refs = [r('style', 's'), r('product', 'p1'), r('model', 'm'), r('top', 'p2')];
  const t = trimRefs(refs, 3);
  assert.deepEqual(ids(t.kept), ['p1', 'm', 'p2']);
  assert.deepEqual(ids(t.dropped), ['s']);
  assert.equal(t.droppedStyle, true);
});

test('model is dropped before products', () => {
  const refs = [r('model', 'm'), r('top', 't'), r('bottom', 'b'), r('style', 's')];
  const t = trimRefs(refs, 2);
  assert.deepEqual(ids(t.kept), ['t', 'b']);
  assert.deepEqual(ids(t.dropped), ['m', 's']);
  assert.equal(t.droppedStyle, true);
});

test('unknown roles rank between model and style', () => {
  assert.ok(refPriority('product') < refPriority('model'));
  assert.ok(refPriority('model') < refPriority('whatever'));
  assert.ok(refPriority('whatever') < refPriority('style'));
  const t = trimRefs([r('style', 's'), r('whatever', 'w'), r('product', 'p')], 2);
  assert.deepEqual(ids(t.kept), ['w', 'p']);
});

test('products tie-break by original position', () => {
  const t = trimRefs([r('top', 'a'), r('bottom', 'b'), r('shoes', 'c'), r('bag', 'd')], 3);
  assert.deepEqual(ids(t.kept), ['a', 'b', 'c']);
  assert.equal(t.droppedStyle, false);
});

test('max 0 or negative keeps nothing', () => {
  for (const max of [0, -1]) {
    const t = trimRefs([r('product'), r('style')], max);
    assert.equal(t.kept.length, 0);
    assert.equal(t.dropped.length, 2);
    assert.equal(t.droppedStyle, true);
  }
});

test('empty input', () => {
  const t = trimRefs([], 3);
  assert.deepEqual(t, { kept: [], dropped: [], droppedStyle: false });
});
