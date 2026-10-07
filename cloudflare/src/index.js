import qqmusic from '../../lib/qqmusic.js';
import * as netease from './netease.js';
import { packedAudioResponse } from './packed-audio.js';
import {
  createPlaybackToken, createSession, decryptCookie, getPlaybackUser, getSessionUser,
  logout, requireSecret, sha256Hex,
} from './security.js';
import {
  adapter, buildLitePlaylist, getPlaylist, parsePlaylistId, songUrl,
  validPlaylistId, validSongId,
} from './playlists.js';

const QR_TTL_MS = 3 * 60 * 1000;

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...extraHeaders },
  });
}

function fail(message, status = 400) {
  return json({ success: false, message }, status);
}

function viewUser(user) {
  return { userId: user.platform_user_id, nickname: user.nickname, avatar: user.avatar, vipType: user.vip_type };
}

function numberParam(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
}

async function bodyJson(request) {
  const length = Number(request.headers.get('content-length'));
  if (length > 65536) throw new Error('Request body too large');
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

async function rateLimited(env, request, scope, maxHits) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const key = await sha256Hex(`${scope}:${ip}`);
  const bucket = Math.floor(Date.now() / 60000);
  const result = await env.DB.prepare(`
    INSERT INTO rate_limits (scope, key_hash, bucket, hits) VALUES (?, ?, ?, 1)
    ON CONFLICT (scope, key_hash, bucket) DO UPDATE SET hits = hits + 1
    RETURNING hits
  `).bind(scope, key, bucket).first();
  if (Math.random() < 0.001) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE bucket < ?').bind(bucket - 1440).run();
  }
  return Number(result?.hits || 0) > maxHits;
}

async function requireUser(env, request, platform, url) {
  return getSessionUser(env, request, platform, url);
}

async function saveLogin(env, platform, profile, cookie, code) {
  const { token } = await createSession(env, platform, profile, cookie);
  return json({
    success: true,
    ...(code ? { code } : {}),
    data: {
      token,
      user: {
        userId: String(profile.userId),
        nickname: profile.nickname || '', avatar: profile.avatar || '',
        vipType: Number(profile.vipType) || 0,
      },
    },
  });
}

async function accountStatus(platform, cookie) {
  if (platform === 'qq') return qqmusic.checkLoginStatus(cookie);
  return netease.checkLoginStatus(cookie);
}

async function authRoute(request, env, platform, path, url) {
  const method = request.method;
  const upstream = adapter(platform);

  if (method === 'GET' && path === '/status') {
    const user = await getSessionUser(env, request, platform, url);
    return json({ success: true, data: user
      ? { logged: true, user: viewUser(user) }
      : { logged: false } });
  }

  if (method === 'POST' && path === '/logout') {
    await logout(env, request, platform, url, await bodyJson(request));
    return json({ success: true, message: '已退出登录' });
  }

  const isQrPoll = method === 'GET' && path === '/qrcode/check';
  if (await rateLimited(env, request, `${platform}:${isQrPoll ? 'qr-poll' : 'auth'}`, isQrPoll ? 45 : 12)) {
    return fail('登录请求过于频繁，请稍后再试', 429);
  }

  if (method === 'GET' && path === '/qrcode') {
    const result = await upstream.createQRCode();
    const key = platform === 'qq' ? result.qrsig : result.key;
    if (!key || !result.qrimg) return fail('获取二维码失败', 502);
    const keyHash = await sha256Hex(key);
    await env.DB.prepare('DELETE FROM qr_sessions WHERE expires_at_ms <= ?')
      .bind(Date.now()).run();
    await env.DB.prepare(`
      INSERT INTO qr_sessions (platform, key_hash, expires_at_ms) VALUES (?, ?, ?)
      ON CONFLICT (platform, key_hash) DO UPDATE SET expires_at_ms = excluded.expires_at_ms
    `).bind(platform, keyHash, Date.now() + QR_TTL_MS).run();
    return json({ success: true, data: { key, qrimg: result.qrimg } });
  }

  if (method === 'GET' && path === '/qrcode/check') {
    const key = String(url.searchParams.get('key') || '');
    if (!key || key.length > 512) return fail('二维码已过期，请刷新');
    const keyHash = await sha256Hex(key);
    const session = await env.DB.prepare(`
      SELECT 1 FROM qr_sessions WHERE platform = ? AND key_hash = ? AND expires_at_ms > ?
    `).bind(platform, keyHash, Date.now()).first();
    if (!session) return fail('二维码已过期，请刷新');

    const result = await upstream.checkQRCode(key);
    const successCode = platform === 'qq' ? 0 : 803;
    if (result.code === successCode) {
      await env.DB.prepare('DELETE FROM qr_sessions WHERE platform = ? AND key_hash = ?')
        .bind(platform, keyHash).run();
      const cookie = String(result.cookie || '').trim();
      if (!cookie) return fail('登录成功但未取得会话 Cookie');
      let status;
      if (platform === 'qq') {
        try {
          status = await accountStatus(platform, cookie);
        } catch (_) {
          status = { logged: false };
        }
        const userId = status.userId || result.uin || qqmusic.extractUin(cookie);
        if (!userId) return fail('登录状态异常');
        status = {
          ...status,
          userId,
          nickname: status.nickname || result.nickname || `QQ用户${userId}`,
          avatar: status.avatar || qqmusic.buildQQAvatarUrl(userId),
        };
      } else {
        status = await accountStatus(platform, cookie);
        if (!status.logged || !status.userId) return fail('登录状态异常');
      }
      return saveLogin(env, platform, {
        ...status,
        avatar: status.avatar || (platform === 'qq' ? qqmusic.buildQQAvatarUrl(status.userId) : ''),
      }, cookie, 803);
    }
    const code = platform === 'qq'
      ? ({ 66: 801, 67: 802, 65: 800 }[result.code] ?? result.code)
      : result.code;
    return json({ success: true, code, message: result.message || '' });
  }

  if (method === 'POST' && path === '/login/cookie') {
    const { cookie } = await bodyJson(request);
    if (!cookie || String(cookie).length > 16000) return fail('请输入有效 Cookie');
    const status = await accountStatus(platform, String(cookie));
    if (!status.logged || !status.userId) return fail('Cookie 无效或已过期');
    return saveLogin(env, platform, status, String(cookie));
  }

  if (platform === 'netease' && method === 'POST' && path === '/captcha/send') {
    const { phone } = await bodyJson(request);
    if (!/^\d{6,20}$/.test(String(phone || ''))) return fail('请输入有效手机号');
    const sent = await netease.sendCaptcha(String(phone));
    return json({ success: sent, message: sent ? '验证码已发送' : '发送失败' });
  }

  if (platform === 'netease' && method === 'POST' && ['/login/captcha', '/login/password'].includes(path)) {
    const body = await bodyJson(request);
    const credential = path === '/login/captcha' ? body.captcha : body.password;
    if (!/^\d{6,20}$/.test(String(body.phone || '')) || !credential) {
      return fail('请输入手机号和登录凭证');
    }
    const cookie = await netease.loginWithPhone(
      String(body.phone), String(credential), path === '/login/captcha' ? 'captcha' : 'password'
    );
    const status = await netease.checkLoginStatus(cookie);
    if (!status.logged || !status.userId) return fail('登录状态异常');
    return saveLogin(env, platform, status, cookie);
  }

  return fail('接口不存在', 404);
}

async function playlistRoute(request, env, platform, path, url) {
  const user = await requireUser(env, request, platform, url);
  if (!user) return fail('请先登录', 401);

  if (request.method === 'GET' && path === '/user') {
    const cookie = await decryptCookie(env, user);
    const result = await adapter(platform).getUserPlaylists(user.platform_user_id, cookie);
    const all = Array.isArray(result.playlists) ? result.playlists : [];
    const limit = numberParam(url.searchParams.get('limit'), 30, 100) || 30;
    const offset = numberParam(url.searchParams.get('offset'), 0, 100000);
    return json({ success: true, data: all.slice(offset, offset + limit), total: result.count ?? all.length });
  }

  if (request.method === 'GET' && path === '/parse') {
    if (await rateLimited(env, request, `${platform}:parse`, 30)) {
      return fail('解析请求过于频繁', 429);
    }
    const playlistId = parsePlaylistId(url.searchParams.get('url'), platform);
    if (!playlistId) return fail('无效的歌单链接或 ID');
    const playlist = await getPlaylist(env, user, playlistId);
    return json({ success: true, data: {
      id: playlist.id, name: playlist.name, cover: playlist.cover, songCount: playlist.songCount,
    } });
  }

  if (request.method === 'GET' && path === '/url') {
    const playlistId = String(url.searchParams.get('id') || '');
    if (!validPlaylistId(playlistId)) return fail('无效的歌单 ID');
    await getPlaylist(env, user, playlistId);
    const token = await createPlaybackToken(env, user, playlistId);
    const prefix = platform === 'qq' ? '/api/qq/playlist' : '/api/playlist';
    const liteUrl = `${url.origin}${prefix}/m3u8/${encodeURIComponent(token)}/${playlistId}/stream.m3u8`;
    return json({ success: true, data: {
      url: liteUrl,
      urls: [{
        type: 'lite', label: '轻量 M3U8（仅音频）', url: liteUrl,
        note: '无需本地转码。播放能力取决于播放器与账号权限。',
      }],
      default: 'lite',
    } });
  }

  return fail('接口不存在', 404);
}

async function playbackRoute(request, env, ctx, platform, path, url) {
  const playlistMatch = path.match(/^\/playlist\/m3u8\/([^/]+)\/(\d{1,20})\/stream\.m3u8$/);
  if (['GET', 'HEAD'].includes(request.method) && playlistMatch) {
    const [, token, playlistId] = playlistMatch;
    const user = await getPlaybackUser(env, token, platform, playlistId);
    if (!user) return new Response('Token expired', { status: 401 });
    const playlist = await getPlaylist(env, user, playlistId);
    const text = buildLitePlaylist(request, platform, token, playlistId, playlist.tracks);
    return new Response(request.method === 'HEAD' ? null : text, { headers: {
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    } });
  }

  const songMatch = path.match(/^\/song\/([^/]+)\/([^/]+?)(?:\.mp3)?$/);
  if (['GET', 'HEAD'].includes(request.method) && songMatch) {
    const [, token, songId] = songMatch;
    const playlistId = String(url.searchParams.get('playlist') || '');
    if (!validPlaylistId(playlistId) || !validSongId(songId, platform)) return fail('无效的歌曲或歌单 ID');
    const user = await getPlaybackUser(env, token, platform, playlistId);
    if (!user) return fail('播放链接已过期', 401);
    const playlist = await getPlaylist(env, user, playlistId);
    const song = playlist.tracks.find((track) => String(track.id) === songId);
    if (!song) return fail('歌曲不属于该歌单', 403);
    const destination = await songUrl(env, user, songId);
    if (!destination) return fail('歌曲不可播放，可能无版权或需要对应会员权限', 404);
    const response = url.searchParams.get('hls') === '1'
      ? await packedAudioResponse(request, destination, platform)
      : new Response(null, { status: 302, headers: {
        location: destination,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      } });
    if (request.method === 'GET' && response.status < 400) {
      ctx.waitUntil(env.DB.prepare(`
        INSERT INTO play_logs (user_id, playlist_id, song_id, song_name, artist, played_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(user.id, playlistId, songId, song.name, song.artist, Date.now()).run());
    }
    return response;
  }

  if (path.startsWith('/hls/') || path.startsWith('/mp4/')) {
    return fail('Cloudflare 版本不提供实时转码，请使用轻量 M3U8 链接', 410);
  }
  return null;
}

async function favoritesRoute(request, env, platform, path, url) {
  const user = await requireUser(env, request, platform, url);
  if (!user) return fail('请先登录', 401);
  const playlistId = path.startsWith('/check/') ? path.slice(7) : path.slice(1);
  if (path && !validPlaylistId(playlistId)) return fail('无效的歌单 ID');

  if (request.method === 'GET' && !path) {
    const limit = numberParam(url.searchParams.get('limit'), 20, 100) || 20;
    const offset = numberParam(url.searchParams.get('offset'), 0, 100000);
    const rows = await env.DB.prepare(`
      SELECT playlist_id, playlist_name, playlist_cover, nickname, created_at_ms
      FROM favorites WHERE user_id = ? ORDER BY created_at_ms DESC LIMIT ? OFFSET ?
    `).bind(user.id, limit, offset).all();
    const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM favorites WHERE user_id = ?')
      .bind(user.id).first();
    return json({ success: true, data: rows.results.map((row) => ({
      playlistId: row.playlist_id,
      name: row.playlist_name,
      cover: row.playlist_cover,
      nickname: row.nickname,
      createdAt: new Date(row.created_at_ms).toISOString(),
    })), total: count.total });
  }

  if (request.method === 'GET' && path.startsWith('/check/')) {
    const exists = await env.DB.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND playlist_id = ?')
      .bind(user.id, playlistId).first();
    return json({ success: true, data: { favorited: !!exists } });
  }

  if (request.method === 'POST' && !path) {
    const body = await bodyJson(request);
    const id = String(body.playlistId || '');
    if (!validPlaylistId(id)) return fail('无效的歌单 ID');
    await env.DB.prepare(`
      INSERT INTO favorites (user_id, playlist_id, playlist_name, playlist_cover, nickname, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, playlist_id) DO UPDATE SET
        playlist_name = excluded.playlist_name,
        playlist_cover = excluded.playlist_cover,
        nickname = excluded.nickname
    `).bind(user.id, id, String(body.playlistName || ''), String(body.playlistCover || ''),
      body.nickname ? String(body.nickname) : null, Date.now()).run();
    return json({ success: true, message: '收藏成功' });
  }

  if (request.method === 'DELETE' && path) {
    await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND playlist_id = ?')
      .bind(user.id, playlistId).run();
    return json({ success: true, message: '已取消收藏' });
  }

  return fail('接口不存在', 404);
}

async function historyRoute(request, env, platform, path, url) {
  const user = await requireUser(env, request, platform, url);
  if (!user) return fail('请先登录', 401);
  if (request.method !== 'GET') return fail('接口不存在', 404);

  if (path === '/recent') {
    const limit = numberParam(url.searchParams.get('limit'), 20, 100) || 20;
    const offset = numberParam(url.searchParams.get('offset'), 0, 100000);
    const rows = await env.DB.prepare(`
      SELECT l.playlist_id, MAX(l.played_at_ms) AS played_at_ms,
        COUNT(*) AS play_count, COALESCE(MAX(p.name), '') AS playlist_name,
        COALESCE(MAX(p.cover), '') AS playlist_cover
      FROM play_logs l LEFT JOIN playlists p
        ON p.user_id = l.user_id AND p.playlist_id = l.playlist_id
      WHERE l.user_id = ? AND l.playlist_id IS NOT NULL
      GROUP BY l.playlist_id ORDER BY played_at_ms DESC LIMIT ? OFFSET ?
    `).bind(user.id, limit, offset).all();
    const count = await env.DB.prepare(`
      SELECT COUNT(DISTINCT playlist_id) AS total FROM play_logs
      WHERE user_id = ? AND playlist_id IS NOT NULL
    `).bind(user.id).first();
    return json({ success: true, data: rows.results.map((row) => ({
      playlistId: row.playlist_id,
      name: row.playlist_name || `歌单 ${row.playlist_id}`,
      cover: row.playlist_cover,
      playedAt: new Date(row.played_at_ms).toISOString(),
      playCount: row.play_count,
    })), total: count.total });
  }

  if (platform === 'netease' && path === '/top') {
    const limit = numberParam(url.searchParams.get('limit'), 10, 50) || 10;
    const rows = await env.DB.prepare(`
      SELECT song_id, MAX(song_name) AS song_name, MAX(artist) AS artist,
        COUNT(*) AS play_count FROM play_logs WHERE user_id = ?
      GROUP BY song_id ORDER BY play_count DESC LIMIT ?
    `).bind(user.id, limit).all();
    return json({ success: true, data: rows.results.map((row) => ({
      songId: row.song_id, songName: row.song_name, artist: row.artist, playCount: row.play_count,
    })) });
  }
  return fail('接口不存在', 404);
}

async function api(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (pathname === '/api/health') return json({ status: 'ok', timestamp: Date.now() });
  if (!env.DB) return fail('未绑定 D1 数据库', 503);
  requireSecret(env);

  const platform = pathname.startsWith('/api/qq/') ? 'qq' : 'netease';
  const path = pathname.slice(platform === 'qq' ? '/api/qq'.length : '/api'.length);

  if (path.startsWith('/auth/')) {
    return authRoute(request, env, platform, path.slice('/auth'.length), url);
  }
  if (path.startsWith('/playlist/')) {
    const playback = await playbackRoute(request, env, ctx, platform, path, url);
    if (playback) return playback;
    return playlistRoute(request, env, platform, path.slice('/playlist'.length), url);
  }
  if (path.startsWith('/song/') || path.startsWith('/hls/') || path.startsWith('/mp4/')) {
    return await playbackRoute(request, env, ctx, platform, path, url) || fail('接口不存在', 404);
  }
  if (path === '/favorites' || path.startsWith('/favorites/')) {
    return favoritesRoute(request, env, platform, path.slice('/favorites'.length), url);
  }
  if (path.startsWith('/history/')) {
    return historyRoute(request, env, platform, path.slice('/history'.length), url);
  }
  return fail('接口不存在', 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, ctx);
    } catch (error) {
      console.error('[API]', error);
      return fail('请求处理失败，请稍后重试', 500);
    }
  },
};
