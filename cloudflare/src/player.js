import playerApi from '../../lib/player-api.js';
import policy from '../../lib/player-policy.js';
import cache from '../../lib/player-cache.js';
import qqmusic from '../../lib/qqmusic.js';
import * as netease from './netease.js';
import { createPlaybackToken, decryptCookie, getPlaybackUser, getSessionUser, sha256Hex } from './security.js';
import { getPlaylist } from './playlists.js';
import { recordPlayback } from './playback-history.js';

const resolving = new Map();
const cacheEnabled = env => env.AUDIO_CACHE && String(env.AUDIO_CACHE_ENABLED) === 'true';

function r2Storage(bucket) {
  return {
    async get(key, range) {
      const object = await bucket.get(key, range ? { range: new Headers({ range }) } : undefined);
      if (!object) return null;
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('accept-ranges', 'bytes');
      let status = 200;
      if (object.range) {
        const offset = object.range.offset || 0;
        const length = object.range.length || object.size - offset;
        headers.set('content-length', String(length));
        headers.set('content-range', 'bytes ' + offset + '-' + (offset + length - 1) + '/' + object.size);
        status = 206;
      } else headers.set('content-length', String(object.size));
      return { response: new Response(object.body, { status, headers }), expiresAt: Number(object.customMetadata?.expiresAt) || 0 };
    },
    put(key, bytes, meta) { return bucket.put(key, bytes, {
      httpMetadata: { contentType: meta.contentType }, customMetadata: { expiresAt: String(meta.expiresAt) },
    }); },
    delete(key) { return bucket.delete(key); },
  };
}

async function resolvePlayerSource(env, user, songId, quality, fresh = false) {
  const key = await sha256Hex([user.platform, user.id, user.token_hash, songId, quality].join(':'));
  if (!fresh) {
    const row = await env.DB.prepare('SELECT source_json FROM song_sources WHERE cache_key = ? AND expires_at_ms > ?')
      .bind(key, Date.now()).first();
    if (row) { try { return JSON.parse(row.source_json); } catch (_) {} }
    if (resolving.has(key)) return resolving.get(key);
  }
  const promise = (async () => {
    const cookie = await decryptCookie(env, user);
    const source = await policy.resolveQuality(
      candidate => user.platform === 'qq' ? qqmusic.getSongResource(songId, cookie, candidate)
        : netease.getSongResource(songId, cookie, { ...env, MUSIC_QUALITY: candidate }),
      quality, true,
    );
    source.url = policy.allowedSource(source.url, user.platform);
    if (!source.url) throw new policy.PlayerError('音源地址不受支持', 502);
    const expires = Math.min(source.expiresAt || Date.now() + 60000, Date.now() + 90000);
    source.expiresAt = expires;
    await env.DB.prepare('INSERT INTO song_sources (cache_key, source_json, expires_at_ms) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET source_json = excluded.source_json, expires_at_ms = excluded.expires_at_ms')
      .bind(key, JSON.stringify(source), expires).run();
    return source;
  })();
  resolving.set(key, promise);
  try { return await promise; } finally { if (resolving.get(key) === promise) resolving.delete(key); }
}

async function proxyPlayerSource(request, env, ctx, user, songId, resource, image = false, fill = true) {
  const source = image ? policy.allowedSource(resource.url, user.platform, true) : resource.url;
  if (!source) return env.ASSETS.fetch(new Request(new URL('/placeholder.svg', request.url)));
  const identity = image ? source : [user.platform, user.id, user.token_hash, songId,
    resource.quality, resource.format, resource.bitrate, !!resource.trial, new URL(source).pathname].join(':');
  const key = (image ? 'cover/v2/' : 'audio/v2/') + await sha256Hex(identity);
  return cache.proxySource(request, { source, platform: user.platform, key, ctx, image, fill,
    storage: cacheEnabled(env) ? r2Storage(env.AUDIO_CACHE) : null, ttl: image ? 86400 : 3600 });
}

function handlePlayer(request, env, ctx) {
  const services = {
    capabilities: () => policy.capabilities('cloudflare', env.MUSIC_QUALITY, !!cacheEnabled(env)),
    session: (req, platform) => getSessionUser(env, req, platform),
    verifyGrant: (grant, platform, id) => getPlaybackUser(env, grant, platform, id),
    mintGrant: (user, id) => createPlaybackToken(env, user, id),
    playlist: (user, id) => getPlaylist(env, user, id),
    resolve: (user, songId, quality, fresh) => resolvePlayerSource(env, user, songId, quality, fresh),
    cover: (req, user, url, song) => proxyPlayerSource(req, env, ctx, user, song.id, { url }, true),
    async media(req, user, song, id, source) {
      const response = await proxyPlayerSource(req, env, ctx, user, song.id, source);
      return req.method === 'HEAD' ? response : cache.trackTransfer(response,
        () => ctx.waitUntil(recordPlayback(env, user.id, id, song).catch(error => console.error('[Player history]', error.message))));
    },
  };
  return playerApi.createPlayerApi(services)(request);
}

export { handlePlayer, resolvePlayerSource, proxyPlayerSource };
