import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function workspace(storage = new Map()) {
  const sandbox = vm.createContext({
    window: {}, URL,
    localStorage: { getItem(key) { return storage.get(key) ?? null; } },
  });
  vm.runInContext(readFileSync(new URL('../../public/js/workspace.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.MfuWorkspace;
}

test('account annotations stay isolated across platforms and accounts and tolerate damaged browser storage', () => {
  const storage = new Map([
    ['mfu:account:netease:1001', JSON.stringify({ name: '工作账号', remark: '歌单 A' })],
    ['mfu:account:qq:1001', JSON.stringify({ name: '生活账号', remark: '歌单 B' })],
    ['mfu:account:netease:1002', '{invalid json'],
  ]);
  const app = workspace(storage);
  assert.deepEqual({ ...app.accountPreferences({ platform: 'netease', user: { userId: '1001' } }) },
    { name: '工作账号', remark: '歌单 A' });
  assert.deepEqual({ ...app.accountPreferences({ platform: 'qq', user: { userId: '1001' } }) },
    { name: '生活账号', remark: '歌单 B' });
  assert.deepEqual({ ...app.accountPreferences({ platform: 'netease', user: { userId: '1002' } }) },
    { name: '', remark: '' });
  assert.deepEqual({ ...app.accountPreferences({ platform: 'netease', user: { userId: '1003' } }) },
    { name: '', remark: '' });
});

test('media URL validation rejects executable URLs, remote HTTP and embedded credentials', () => {
  const app = workspace();
  for (const value of ['javascript:alert(1)', 'data:video/mp4;base64,AA', 'file:///K:/clip.mp4',
    'http://media.example.test/clip.mp4', 'https://account:secret@media.example.test/clip.mp4']) {
    assert.throws(() => app.validateMediaUrl(value));
  }
  assert.equal(app.validateMediaUrl('https://music.example.test/stream.m3u8?token=test'),
    'https://music.example.test/stream.m3u8?token=test');
  assert.equal(app.validateMediaUrl('http://127.0.0.1:8787/clip.mp4'), 'http://127.0.0.1:8787/clip.mp4');
});
