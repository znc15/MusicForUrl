import qqmusic from '../../lib/qqmusic.js';
import * as netease from './netease.js';
import { packedAudioResponse } from './packed-audio.js';
import { PLAY_LOG_RETENTION_MS, prunePlaybackLogs, recordPlayback } from './playback-history.js';
import { handlePlayer, resolvePlayerSource, proxyPlayerSource } from './player.js';
import {
  createPlaybackToken, createSession, decryptCookie, getPlaybackUser, getSessionUser,
  logout, requireSecret, sha256Hex,
} from './security.js';
import {
  adapter, buildLitePlaylist, getPlaylist, parsePlaylistId, songUrl, streamPrefix,
  validPlaylistId, validSongId,
} from './playlists.js';
import { PLATFORMS, capabilityMatrix, guestUser, platformFromPath } from './platforms.js';
import { bumpParsedSongs, readSiteStats, refreshSiteStats } from './stats.js';
import { recordPlayEvent, recordRequestEvent } from './telemetry.js';
import { degradeMode } from './degrade.js';
import { admitControl, rateLimited, retryAfter } from './request-policy.js';

const QR_TTL_MS = 3 * 60 * 1000;
const MAX_REQUEST_BODY_BYTES = 65536;
const NO_LIBRARY_MESSAGE = '该平台暂不支持个人歌单、收藏与播放记录。';

class RequestBodyTooLargeError extends Error {}

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...extraHeaders },
  });
}

function fail(message, status = 400, headers = {}) {
  return json({ success: false, message }, status, headers);
}

function viewUser(user) {
  return {
    userId: user.platform_user_id, nickname: user.nickname, avatar: user.avatar,
    vipType: user.vip_type, platform: user.platform,
  };
}

function numberParam(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
}

async function bodyJson(request) {
  const length = Number(request.headers.get('content-length'));
  if (length > MAX_REQUEST_BODY_BYTES) {
    await request.body?.cancel();
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_REQUEST_BODY_BYTES);
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (bytesRead + chunk.value.byteLength > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      bytes.set(chunk.value, bytesRead);
      bytesRead += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, bytesRead)));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

async function requireUser(env, request, platform, url) {
  return getSessionUser(env, request, platform, url);
}

function playlistUrlPayload(origin, platform, token, playlistId) {
  const liteUrl = `${origin}${streamPrefix(platform)}/m3u8/${encodeURIComponent(token)}/${playlistId}/stream.m3u8`;
  return {
    url: liteUrl,
    urls: [{
      type: 'lite', label: '轻量 M3U8（仅音频）', url: liteUrl,
      note: '无需本地转码。播放能力取决于播放器与账号权限。',
    }],
    default: 'lite',
  };
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

async function accountStatus(platform, cookie, expectedUin) {
  if (platform === 'qq') return qqmusic.checkLoginStatus(cookie, expectedUin);
  if (platform === 'kugou' || platform === 'kuwo') return adapter(platform).checkLoginStatus(cookie);
  return netease.checkLoginStatus(cookie);
}

async function authRoute(request, env, platform, path, url) {
  const method = request.method;
  // 游客平台没有账号体系：状态查询照常返回「未登录 + 不支持」，其余接口明确拒绝
  if (!PLATFORMS[platform].account) {
    if (method === 'GET' && path === '/status') {
      return json({ success: true, data: { logged: false, supported: false, message: NO_LIBRARY_MESSAGE } });
    }
    return fail(NO_LIBRARY_MESSAGE, 501);
  }
  const upstream = adapter(platform);

  // 仅网易云提供经上游认证的手填 Cookie 登录。其他平台从各自真实登录流程建会话。
  if (method === 'POST' && path === '/login/cookie' && platform !== 'netease') {
    return fail('请使用该平台提供的扫码、密码或短信登录方式', 405);
  }

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
    return fail('登录请求过于频繁，请稍后再试', 429, { 'retry-after': String(retryAfter()) });
  }

  if (method === 'GET' && path === '/qrcode') {
    if (!upstream.createQRCode) return fail('该平台不支持扫码登录', 501);
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
    if (!upstream.checkQRCode) return fail('该平台不支持扫码登录', 501);
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
        // 身份来自服务器持有的二维码确认结果；公开用户资料只用于补充展示。
        const userId = String(result.uin || '');
        if (!/^\d{1,20}$/.test(userId) || qqmusic.extractUin(cookie) !== userId || !qqmusic.extractMusicKey(cookie)) {
          return fail('QQ 音乐授权未完成，请重新扫码', 401);
        }
        status = await accountStatus(platform, cookie, userId);
        if (status.userId && String(status.userId) !== userId) return fail('登录身份不一致，请重新扫码', 401);
        status = {
          ...status,
          userId,
          nickname: status.nickname || result.nickname || `QQ用户${userId}`,
          avatar: status.avatar || qqmusic.buildQQAvatarUrl(userId),
        };
      } else {
        status = await accountStatus(platform, cookie);
        if (!status.logged || !status.userId) return fail('登录状态异常');
        if (platform === 'kugou') {
          status = {
            ...status,
            nickname: status.nickname || result.nickname || `酷狗用户${status.userId}`,
            avatar: status.avatar || result.avatar || '',
          };
        }
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

  if (platform === 'kuwo' && method === 'GET' && path === '/captcha') {
    return json({ success: true, data: await upstream.captcha() });
  }

  if (platform === 'kuwo' && method === 'POST' && path === '/login/password') {
    const body = await bodyJson(request);
    const uname = String(body.uname || '').trim();
    const password = String(body.password || '');
    const verifyCode = String(body.verifyCode || '').trim();
    const verifyCodeToken = String(body.verifyCodeToken || '').trim();
    const cookie = String(body.cookie || '');
    if (!uname || uname.length > 100 || !password || password.length > 200) {
      return fail('请输入酷我账号和密码');
    }
    if (!verifyCode || verifyCode.length > 8) return fail('请输入图形验证码');
    if (!verifyCodeToken || verifyCodeToken.length > 128) return fail('图形验证码已失效，请刷新');
    if (cookie.length > 2000) return fail('登录会话无效，请刷新验证码');
    const result = await upstream.loginByPassword({ uname, password, verifyCode, verifyCodeToken, cookie });
    return saveLogin(env, platform, result.profile, result.cookie);
  }

  if (platform === 'kuwo' && method === 'POST' && path === '/sms/send') {
    const body = await bodyJson(request);
    const mobile = String(body.mobile || '').trim();
    const verifyCode = String(body.verifyCode || '').trim();
    const verifyCodeToken = String(body.verifyCodeToken || '').trim();
    const cookie = String(body.cookie || '');
    if (!/^1\d{10}$/.test(mobile)) return fail('请输入 11 位中国大陆手机号');
    if (!verifyCode || verifyCode.length > 8) return fail('请输入图形验证码');
    if (!verifyCodeToken || verifyCodeToken.length > 128) return fail('图形验证码已失效，请刷新');
    if (cookie.length > 2000) return fail('登录会话无效，请刷新验证码');
    const result = await upstream.sendSms({ mobile, verifyCode, verifyCodeToken, cookie });
    return json({ success: true, data: result });
  }

  if (platform === 'kuwo' && method === 'POST' && path === '/login/sms') {
    const body = await bodyJson(request);
    const mobile = String(body.mobile || '').trim();
    const verifyCode = String(body.verifyCode || '').trim();
    const smsCode = String(body.smsCode || '').trim();
    const tm = String(body.tm || '').trim();
    const cookie = String(body.cookie || '');
    if (!/^1\d{10}$/.test(mobile)) return fail('请输入 11 位中国大陆手机号');
    if (!verifyCode || verifyCode.length > 8) return fail('请输入图形验证码');
    if (!/^\d{4,8}$/.test(smsCode)) return fail('请输入短信验证码');
    if (tm.length > 200) return fail('短信验证失效，请重新发送');
    if (cookie.length > 2000) return fail('登录会话无效，请刷新验证码');
    const result = await upstream.loginBySms({ mobile, verifyCode, smsCode, tm, cookie });
    return saveLogin(env, platform, result.profile, result.cookie);
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

async function playlistRoute(request, env, ctx, platform, path, url) {
  const meta = PLATFORMS[platform];
  // 游客平台不需要登录：解析与播放只依赖公开接口。
  // 酷狗虽然支持扫码登录，但登录只补充账号身份，未登录仍然可以解析与播放。
  const sessionUser = meta.account ? await requireUser(env, request, platform, url) : null;
  const user = sessionUser || (meta.guestPlayback ? guestUser(platform) : null);
  if (!user) return fail('请先登录', 401);

  if ((request.method === 'GET' && ['/parse', '/url'].includes(path)) ||
    (request.method === 'POST' && path === '/generate')) {
    await admitControl(env, request, platform);
  }

  if (request.method === 'GET' && path === '/user') {
    if (!meta.library) return fail(NO_LIBRARY_MESSAGE, 403);
    const cookie = await decryptCookie(env, user);
    const result = await adapter(platform).getUserPlaylists(user.platform_user_id, cookie);
    const all = Array.isArray(result.playlists) ? result.playlists : [];
    const limit = numberParam(url.searchParams.get('limit'), 30, 100) || 30;
    const offset = numberParam(url.searchParams.get('offset'), 0, 100000);
    return json({ success: true, data: all.slice(offset, offset + limit), total: result.count ?? all.length });
  }

  if (request.method === 'GET' && path === '/parse') {
    const playlistId = parsePlaylistId(url.searchParams.get('url'), platform);
    if (!playlistId) return fail('无效的歌单链接或 ID');
    const playlist = await getPlaylist(env, user, playlistId, ctx);
    // 旧版前端先 /parse 再 /url：解析数只在这里累加，链接数留给 /url
    ctx.waitUntil(bumpParsedSongs(env, playlist.tracks.length, 0));
    return json({ success: true, data: {
      id: playlist.id, name: playlist.name, cover: playlist.cover, songCount: playlist.songCount,
    } });
  }

  if (request.method === 'GET' && path === '/url') {
    const playlistId = String(url.searchParams.get('id') || '');
    if (!validPlaylistId(playlistId, platform)) return fail('无效的歌单 ID');
    await getPlaylist(env, user, playlistId, ctx);
    const token = await createPlaybackToken(env, user, playlistId);
    // 旧版前端的签发入口：解析已在 /parse 计过，这里只加链接数
    ctx.waitUntil(bumpParsedSongs(env, 0, 1));
    return json({ success: true, data: playlistUrlPayload(url.origin, platform, token, playlistId) });
  }

  // 一次请求完成解析 → 取歌单 → 签发令牌 → 返回链接，替代前端连续调用 /parse 与 /url
  if (request.method === 'POST' && path === '/generate') {
    const body = await bodyJson(request);
    const playlistId = parsePlaylistId(body.url, platform);
    if (!playlistId) return fail('无效的歌单链接或 ID');
    const playlist = await getPlaylist(env, user, playlistId, ctx);
    const token = await createPlaybackToken(env, user, playlistId);
    // 新前端的入口：一次请求同时累加解析歌曲数与生成的链接数
    ctx.waitUntil(bumpParsedSongs(env, playlist.tracks.length, 1));
    return json({ success: true, data: {
      playlist: {
        id: playlist.id, name: playlist.name, cover: playlist.cover, songCount: playlist.songCount,
      },
      ...playlistUrlPayload(url.origin, platform, token, playlistId),
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
    const playlist = await getPlaylist(env, user, playlistId, ctx);
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
    const playlist = await getPlaylist(env, user, playlistId, ctx);
    const song = playlist.tracks.find((track) => String(track.id) === songId);
    if (!song) return fail('歌曲不属于该歌单', 403);
    const resource = await resolvePlayerSource(env, user, songId, url.searchParams.get('quality') || env.MUSIC_QUALITY || 'low', false, ctx);
    const destination = resource.url;
    if (!destination) return fail('歌曲不可播放，可能无版权或需要对应会员权限', 404);
    // 游客平台没有 users 行，play_stats 的外键无法成立；分析数据仍然进 AE
    const record = (cacheState = '') => ctx.waitUntil(
      (user.guest ? Promise.resolve() : recordPlayback(env, user.id, playlistId, song))
        .then(() => recordPlayEvent(env, {
          platform, userId: user.id, playlistId, song, quality: resource.quality,
          format: resource.format, bitrate: resource.bitrate, trial: resource.trial,
          surface: 'hls', cacheState, colo: request.cf?.colo,
        }))
        .catch(error => console.error('[Playback history]', error)));
    if (url.searchParams.get('hls') === '1') {
      let cacheState = '';
      const fetchAudio = (input, options) => proxyPlayerSource(new Request(input, options),
        env, ctx, user, songId, resource, false, request.method !== 'HEAD')
        .then((response) => { cacheState = response.headers.get('x-mfu-cache') || ''; return response; });
      return packedAudioResponse(request, destination, platform, fetchAudio,
        request.method === 'GET' ? () => record(cacheState) : undefined);
    }
    const response = new Response(null, { status: 302, headers: {
      location: destination,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    } });
    if (request.method === 'GET') record('BYPASS');
    return response;
  }

  if (path.startsWith('/hls/') || path.startsWith('/mp4/')) {
    return fail('Cloudflare 版本不提供实时转码，请使用轻量 M3U8 链接', 410);
  }
  return null;
}

async function favoritesRoute(request, env, platform, path, url) {
  if (!PLATFORMS[platform].library) return fail(NO_LIBRARY_MESSAGE, 403);
  const user = await requireUser(env, request, platform, url);
  if (!user) return fail('请先登录', 401);
  const playlistId = path.startsWith('/check/') ? path.slice(7) : path.slice(1);
  if (path && !validPlaylistId(playlistId, platform)) return fail('无效的歌单 ID');

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
  if (!PLATFORMS[platform].library) return fail(NO_LIBRARY_MESSAGE, 403);
  const user = await requireUser(env, request, platform, url);
  if (!user) return fail('请先登录', 401);
  if (request.method !== 'GET') return fail('接口不存在', 404);
  const cutoff = Date.now() - PLAY_LOG_RETENTION_MS;

  if (path === '/recent') {
    const limit = numberParam(url.searchParams.get('limit'), 20, 100) || 20;
    const offset = numberParam(url.searchParams.get('offset'), 0, 100000);
    const rows = await env.DB.prepare(`
      SELECT s.playlist_id, MAX(s.last_played_at_ms) AS played_at_ms,
        SUM(s.play_count) AS play_count, COALESCE(MAX(p.name), '') AS playlist_name,
        COALESCE(MAX(p.cover), '') AS playlist_cover
      FROM play_stats s LEFT JOIN playlists p
        ON p.user_id = s.user_id AND p.playlist_id = s.playlist_id
      WHERE s.user_id = ? AND s.last_played_at_ms >= ?
      GROUP BY s.playlist_id ORDER BY played_at_ms DESC LIMIT ? OFFSET ?
    `).bind(user.id, cutoff, limit, offset).all();
    const count = await env.DB.prepare(`
      SELECT COUNT(DISTINCT playlist_id) AS total FROM play_stats
      WHERE user_id = ? AND last_played_at_ms >= ?
    `).bind(user.id, cutoff).first();
    return json({ success: true, data: rows.results.map((row) => ({
      playlistId: row.playlist_id,
      name: row.playlist_name || `歌单 ${row.playlist_id}`,
      cover: row.playlist_cover,
      playedAt: new Date(row.played_at_ms).toISOString(),
      playCount: row.play_count,
    })), total: count.total });
  }

  if (path === '/top') {
    const limit = numberParam(url.searchParams.get('limit'), 10, 50) || 10;
    const rows = await env.DB.prepare(`
      SELECT song_id, MAX(song_name) AS song_name, MAX(artist) AS artist,
        SUM(play_count) AS play_count FROM play_stats WHERE user_id = ? AND last_played_at_ms >= ?
      GROUP BY song_id ORDER BY play_count DESC LIMIT ?
    `).bind(user.id, cutoff, limit).all();
    return json({ success: true, data: rows.results.map((row) => ({
      songId: row.song_id, songName: row.song_name, artist: row.artist, playCount: row.play_count,
    })) });
  }
  return fail('接口不存在', 404);
}

async function api(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (pathname === '/api/health') {
    return json({
      status: 'ok',
      timestamp: Date.now(),
      degradeMode: degradeMode(env),
      version: String(env.DEPLOY_VERSION || ''),
      features: { analytics: !!(env.ANALYTICS || env.ANALYTICS_REQUESTS), audioCache: !!env.AUDIO_CACHE },
      platforms: capabilityMatrix(),
    });
  }
  if (!env.DB) return fail('未绑定 D1 数据库', 503);
  requireSecret(env);
  if (pathname.startsWith('/api/player/')) return handlePlayer(request, env, ctx);
  // 站点统计对所有访客开放，不含任何账号维度
  if (pathname === '/api/stats') return json({ success: true, data: await readSiteStats(env) });

  const routed = platformFromPath(pathname);
  if (!routed) return fail('接口不存在', 404);
  const platform = routed.id;
  const path = routed.path;

  if (path.startsWith('/auth/')) {
    return authRoute(request, env, platform, path.slice('/auth'.length), url);
  }
  if (path.startsWith('/playlist/')) {
    const playback = await playbackRoute(request, env, ctx, platform, path, url);
    if (playback) return playback;
    return playlistRoute(request, env, ctx, platform, path.slice('/playlist'.length), url);
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
  scheduled(_event, env, ctx) {
    // 清理全部走索引；play_stats 的保留策略由 prunePlaybackLogs 负责
    const now = Date.now();
    const purges = [
      prunePlaybackLogs(env),
      env.DB.prepare('DELETE FROM playlists WHERE expires_at_ms < ?').bind(now).run(),
      env.DB.prepare('DELETE FROM song_sources WHERE expires_at_ms < ?').bind(now).run(),
      env.DB.prepare('DELETE FROM rate_limits WHERE bucket < ?')
        .bind(Math.floor(now / 60000) - 1440).run(),
      env.DB.prepare('DELETE FROM qr_sessions WHERE expires_at_ms <= ?').bind(now).run(),
    ];
    ctx.waitUntil(Promise.all(purges).then(async (results) => {
      const removed = results.slice(1).reduce((total, result) => total + (result?.meta?.changes || 0), 0);
      console.log(`[Cron] pruned ${removed} expired rows`);
      // 清理失败时保留 rejection，不发布基于部分清理结果的统计。
      // 派生指标必须等全部清理成功后重算；统计失败仍只记录日志。
      await refreshSiteStats(env).catch((error) => console.error('[Cron] stats', error));
    }));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const startedAt = Date.now();
    try {
      const response = await api(request, env, ctx);
      recordRequestEvent(env, request, url, response.status, Date.now() - startedAt);
      return response;
    } catch (error) {
      recordRequestEvent(env, request, url, error.status || 500, Date.now() - startedAt);
      if (error instanceof RequestBodyTooLargeError) return fail('请求体不能超过 64 KiB', 413);
      if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
        return fail(error.message, error.status, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {});
      }
      console.error('[API]', error);
      return fail('请求处理失败，请稍后重试', 500);
    }
  },
};
