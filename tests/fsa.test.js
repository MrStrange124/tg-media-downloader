'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fsa = require('../src/lib/fsa.js');

test('splitPath separates directories from the leaf name', () => {
  assert.deepEqual(fsa.splitPath('Telegram/DDC63 members/a.jpg'),
                   { dirs: ['Telegram', 'DDC63 members'], name: 'a.jpg' });
});

test('splitPath handles a bare filename', () => {
  assert.deepEqual(fsa.splitPath('a.jpg'), { dirs: [], name: 'a.jpg' });
});

test('splitPath drops empty and dot segments', () => {
  // "" and "." cannot be created as directories, and ".." would escape the
  // folder the user granted — none may survive into a getDirectoryHandle call.
  assert.deepEqual(fsa.splitPath('a//./b/../c.jpg'),
                   { dirs: ['a', 'b'], name: 'c.jpg' });
});

test('splitPath never yields an empty leaf name', () => {
  assert.equal(fsa.splitPath('').name, 'untitled');
  assert.equal(fsa.splitPath('a/b/').name, 'b');
  assert.equal(fsa.splitPath(null).name, 'untitled');
});

test('nextCandidate returns the original name at n=0', () => {
  assert.equal(fsa.nextCandidate('a.jpg', 0), 'a.jpg');
});

test('nextCandidate inserts the counter before the extension', () => {
  assert.equal(fsa.nextCandidate('a.jpg', 1), 'a (1).jpg');
  assert.equal(fsa.nextCandidate('a.b.jpg', 2), 'a.b (2).jpg');
});

test('nextCandidate handles a name with no extension', () => {
  assert.equal(fsa.nextCandidate('README', 3), 'README (3)');
});

test('nextCandidate leaves a dotfile stem intact', () => {
  // lastIndexOf('.') is 0 here, so there is no extension to split off.
  assert.equal(fsa.nextCandidate('.gitignore', 1), '.gitignore (1)');
});

test('canPick() is false where no picker exists', () => {
  assert.equal(fsa.canPick(), false);
});
