import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
const helperCode = buildSync({
  stdin: { contents: `export { playbackDurationPresentation } from './src/lib/stats-presentation';
    export { formatCount, formatDateTime } from './src/lib/utils';`,
  loader: 'ts', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;
const helperModule = { exports: {} };
vm.runInNewContext(helperCode, { module: helperModule, exports: helperModule.exports });
const { playbackDurationPresentation: present } = helperModule.exports;

const fields = (plays, known, duration) => ({
  plays, knownDurationPlays: known, unknownDurationPlays: plays - known, playDurationMs: duration,
});
const plain = value => JSON.parse(JSON.stringify(value));

test('all-unknown playback durations show an unknown result rather than zero minutes', () => {
  assert.deepEqual(plain(present(fields(16, 0, 0))), { value: '—', detail: '暂无可估算时长' });
  assert.deepEqual(plain(present({ ...fields(16, 0, 0), playDurationMs: null, unknown: ['playDurationMs'] })),
    { value: '—', detail: '暂无可估算时长' });
});

test('partial duration coverage displays the known sum and an exact included request count', () => {
  assert.deepEqual(plain(present(fields(16, 4, 480000))), { value: '8 分钟', detail: '已计入 4 / 16 次' });
  assert.equal(present(fields(10001, 10000, 480000)).detail, '已计入 10,000 / 10,001 次');
});

test('complete duration coverage and genuine zero playback retain numeric results', () => {
  assert.deepEqual(plain(present(fields(16, 16, 1920000))), { value: '32 分钟', detail: '' });
  assert.deepEqual(plain(present(fields(0, 0, 0))), { value: '0 分钟', detail: '' });
});

test('duration estimates retain whole-minute precision instead of rounding decimal hours', () => {
  assert.deepEqual(plain(present(fields(16, 16, 4201000))), { value: '1 小时 10 分钟', detail: '' });
  assert.equal(present(fields(1, 1, 3600000)).value, '1 小时');
  assert.equal(present(fields(1, 1, 3599999)).value, '59 分钟');
  assert.equal(present(fields(1, 1, 60000)).value, '1 分钟');
});

test('missing fields and explicit unknown markers never create zero-duration estimates', () => {
  assert.deepEqual(plain(present()), { value: '—', detail: '' });
  for (const input of [
    {}, { plays: 16, playDurationMs: 0 }, { ...fields(16, 4, 480000), playDurationMs: null },
    { ...fields(16, 4, 480000), unknown: ['playDurationMs'] },
    { ...fields(16, 4, 480000), unknown: ['knownDurationPlays'] },
    { ...fields(16, 4, 480000), unknown: ['plays'] },
    { ...fields(16, 4, 480000), playDurationMs: NaN },
    { ...fields(16, 4, 480000), knownDurationPlays: null },
  ]) assert.equal(present(input).value, '—');
});

test('small positive durations stay positive and inconsistent coverage stays unknown', () => {
  assert.deepEqual(plain(present(fields(1, 1, 10000))), { value: '不足 1 分钟', detail: '' });
  assert.equal(present({ ...fields(16, 4, 480000), unknownDurationPlays: 16 }).value, '—');
  assert.equal(present(fields(16, 17, 480000)).value, '—');
  assert.equal(present(fields(16, 4, 0)).value, '—');
});

const viewCode = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/views/about.tsx', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react/jsx-runtime', '@/*', '@tanstack/react-query', 'lucide-react'],
  define: { __APP_VERSION__: '"fixture"' },
}).outputFiles[0].text;

function aboutMarkup(data, { isError = false, isLoading = false } = {}) {
  const box = ({ children }) => React.createElement('div', null, children);
  const mocks = {
    '@/lib/api': { api: {} },
    '@/lib/utils': helperModule.exports,
    '@/lib/stats-presentation': helperModule.exports,
    '@/lib/platforms': { PLATFORMS: [] },
    '@/components/ui/card': { Badge: box, Card: box, CardContent: box, CardHeader: box, CardTitle: box },
    '@/components/ui/button': { Button: ({ children }) => React.createElement('button', null, children) },
    '@/components/ui/input': { Skeleton: () => React.createElement('span', { 'data-skeleton': true }) },
    '@/components/page-header': { PageHeader: ({ title }) => React.createElement('h1', null, title) },
    '@/hooks/use-capabilities': { useCapabilities: () => ({ data: { backend: 'cloudflare', mp3Only: true, privateCache: false } }) },
    '@tanstack/react-query': { useQuery: ({ queryKey }) => queryKey[0] === 'health'
      ? { data: { status: 'ok', degradeMode: 'normal' } }
      : queryKey[1] === 'top' ? { data: { data: [] } } : { data, isError, isLoading } },
    'lucide-react': { CheckCircle2: () => null, ExternalLink: () => null, MinusCircle: () => null },
  };
  const module = { exports: {} };
  vm.runInNewContext(viewCode, { module, exports: module.exports, require: name => mocks[name] ?? require(name) });
  return renderToStaticMarkup(React.createElement(module.exports.AboutView));
}

function durationBlock(markup) {
  const block = markup.match(/<p[^>]*>估算播放时长<\/p>(.*?)<\/div>/s);
  assert.ok(block, 'the actual AboutView contains the duration metric');
  return block[1];
}

test('AboutView renders unknown, partial and zero duration values from the shared presentation helper', () => {
  const unknown = durationBlock(aboutMarkup(fields(16, 0, 0)));
  assert.match(unknown, />—<\/p>/);
  assert.match(unknown, /暂无可估算时长/);
  assert.doesNotMatch(unknown, /0 分钟/);
  const unavailable = durationBlock(aboutMarkup({ ...fields(16, 0, 0), playDurationMs: null, unknown: ['playDurationMs'] }));
  assert.match(unavailable, />—<\/p>/);
  assert.match(unavailable, /暂无可估算时长/);

  const partial = durationBlock(aboutMarkup(fields(16, 4, 480000)));
  assert.match(partial, />8 分钟<\/p>/);
  assert.match(partial, /已计入 4 \/ 16 次/);
  assert.match(durationBlock(aboutMarkup(fields(0, 0, 0))), />0 分钟<\/p>/);
  const hours = durationBlock(aboutMarkup(fields(16, 16, 4201000)));
  assert.match(hours, />1 小时 10 分钟<\/p>/);
  assert.doesNotMatch(hours, /1\.2 小时/);
});

test('AboutView preserves stale and loading feedback without filling unknown durations with zero', () => {
  const stale = aboutMarkup({ ...fields(16, 0, 0), stale: true });
  assert.match(stale, /统计刷新失败，正在显示上次结果/);
  assert.match(durationBlock(stale), /暂无可估算时长/);
  const loading = durationBlock(aboutMarkup(undefined, { isLoading: true }));
  assert.match(loading, /data-skeleton/);
  assert.doesNotMatch(loading, /0 分钟|暂无可估算时长/);
  const failed = aboutMarkup(undefined, { isError: true });
  assert.match(failed, /统计暂时不可用/);
  assert.match(durationBlock(failed), />—<\/p>/);
});
