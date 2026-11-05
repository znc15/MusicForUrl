// 酷狗音乐游客适配器。
//
// 能力边界（与 platforms.js 的能力矩阵一致）：
//   歌单读取 ✅  上游 m.kugou.com 的公开 JSON 接口，无需登录。
//   音源解析 ⚠️  走移动端 getSongInfo，上游对需要付费/VIP 的曲目返回 "需要付费"，
//                此时没有 URL，交给 player-policy 的降级链与提示处理。
//   账号接入 ✅  扫码登录（kugou-login.js）：只解决账号身份。移动端取链接口不读登录态，
//                因此登录不会改变音源解析结果；会员曲目仍按游客接口的降级链处理。
//
// 免费额度约束：读歌单会扇出成多个子请求（1 次元数据 + 每页 1 次），
// 默认上限 16 页 × 30 首 = 480 首、17 次子请求，离免费版的 50 次还有余量。
// 可在 wrangler 里用 GUEST_PLAYLIST_MAX_PAGES 调整。

import { checkLoginStatus, checkQRCode, createQRCode } from './kugou-login.js';
import { upstreamRequest } from './request.js';

const API_ORIGIN = 'https://m.kugou.com';
const SONG_ORIGIN = 'https://mobiles.kugou.com';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
const PAGE_SIZE = 30;
const DEFAULT_MAX_PAGES = 16;
const MAX_PAGES_LIMIT = 30;

class KugouError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'KugouError';
    this.status = status;
  }
}

function maxPages(env) {
  const value = Number(env?.GUEST_PLAYLIST_MAX_PAGES);
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_PAGES_LIMIT) : DEFAULT_MAX_PAGES;
}

function headers(extra = {}) {
  return {
    'user-agent': MOBILE_UA,
    accept: 'application/json, text/plain, */*',
    referer: `${API_ORIGIN}/`,
    ...extra,
  };
}

async function fetchJson(url, signal) {
  const response = await upstreamRequest(url, { headers: headers(), redirect: 'follow', signal });
  if (!response.ok) throw new KugouError(`酷狗接口返回 ${response.status}`, 502);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new KugouError('酷狗接口返回了非 JSON 内容', 502);
  }
}
// 歌单封面里带 {size} 占位符，换成实际尺寸并统一升级到 https
function coverUrl(raw) {
  const value = String(raw || '').replace('{size}', '240');
  if (!value) return '';
  return value.replace(/^http:\/\//, 'https://');
}

// 上游文件名是 "歌手 - 歌名"，拆成两段；没有分隔符时整串当歌名
function splitFilename(filename) {
  const text = String(filename || '').replace(/\s+/g, ' ').trim();
  const index = text.indexOf(' - ');
  if (index <= 0) return { artist: '', name: text };
  return { artist: text.slice(0, index).trim(), name: text.slice(index + 3).trim() };
}

/**
 * 歌曲 ID 是复合的：`基础hash[-320hash[-sqhash]]`。
 * M3U8 只带一个 ID，把三档 hash 一起编码进去才能在播放时按音质选择，
 * 否则音质选择器对酷狗是空操作。缺失的档位直接省略。
 */
function hashesOf(item) {
  return [...new Set([item?.hash, item?.['320hash'], item?.sqhash]
    .map((value) => String(value || '').trim().toUpperCase())
    .filter((value) => /^[A-F0-9]{32}$/.test(value)))];
}

function trackOf(item, hashes) {
  if (!hashes.length) return null;
  const { artist, name } = splitFilename(item.filename);
  const duration = Number(item.duration);
  return {
    id: hashes.join('-'),
    name,
    artist,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    cover: '',
  };
}

/**
 * 歌单元数据（名称、封面、总数）。
 *
 * 注意 m.kugou.com 的 plist 接口会忽略 page / pagesize，永远只返回前 10 首，
 * 所以它只用来取元数据，曲目列表走下面的 special/song。
 */
async function fetchMeta(playlistId, signal) {
  const body = await fetchJson(`${API_ORIGIN}/plist/list/${encodeURIComponent(playlistId)}?json=true`, signal);
  const list = body?.list?.list;
  if (!Array.isArray(list?.info)) {
    // 歌单不存在或已被删除时上游同样返回 200，只是没有 info
    throw new KugouError('酷狗歌单不存在或已被删除', 404);
  }
  return {
    meta: body?.info?.list || {},
    total: Number(list.total) || list.info.length,
    // 元数据接口只给前 10 首，作为分页接口不可用时的兜底
    fallback: list.info,
  };
}

async function fetchSongPage(playlistId, page, signal) {
  const query = new URLSearchParams({
    specialid: String(playlistId), page: String(page), pagesize: String(PAGE_SIZE),
    version: '9108', plat: '0',
  });
  const body = await fetchJson(`${SONG_ORIGIN}/api/v3/special/song?${query}`, signal);
  const info = body?.data?.info;
  return Array.isArray(info) ? info : [];
}

async function getPlaylistDetail(playlistId, _cookie, env) {
  const signal = AbortSignal.timeout(30000);
  const { meta, total, fallback } = await fetchMeta(playlistId, signal);
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const pages = Math.min(maxPages(env), Math.max(1, pageCount));

  let raw = [];
  try {
    for (let page = 1; page <= pages; page++) {
      const info = await fetchSongPage(playlistId, page, signal);
      if (!info.length) break;
      raw.push(...info);
    }
  } catch (error) {
    // 分页接口整体失败时退回元数据里的前 10 首，功能降级而不是直接不可用
    console.warn(`[Kugou] pagination failed for ${playlistId}: ${error.message}`);
    raw = fallback;
  }
  if (!raw.length) raw = fallback;
  if (raw.length && raw.length < total) {
    console.warn(`[Kugou] truncated playlist ${playlistId}: ${raw.length}/${total}`);
  }

  // 按基础 hash 去重：同一首歌在不同分页里可能带着不同的档位（有时只有基础 hash），
  // 只比较完整 ID 会让同一首歌在歌单里出现两次。同一首的档位取并集，保留音质选项。
  const byHash = new Map();
  for (const item of raw) {
    const hashes = hashesOf(item);
    if (!hashes.length) continue;
    const existing = byHash.get(hashes[0]);
    if (!existing) { byHash.set(hashes[0], { item, hashes }); continue; }
    for (const hash of hashes) {
      if (!existing.hashes.includes(hash)) existing.hashes.push(hash);
    }
  }

  const tracks = [];
  for (const { item, hashes } of byHash.values()) {
    const track = trackOf(item, hashes);
    if (track) tracks.push(track);
  }

  return {
    id: String(playlistId),
    name: String(meta.specialname || '').trim() || `酷狗歌单 ${playlistId}`,
    cover: coverUrl(meta.imgurl),
    songCount: total || tracks.length,
    tracks,
  };
}

const BITRATE = { low: 128000, medium: 192000, high: 320000, lossless: 320000 };

async function fetchSongInfo(hash) {
  const url = `${API_ORIGIN}/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`;
  const response = await upstreamRequest(url, { headers: headers(), redirect: 'follow' });
  if (!response.ok) return null;
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/** 按请求音质挑 hash：无损→sq、较高/高品质→320、标准→基础。 */
function hashCandidates(songId, quality) {
  const parts = String(songId || '').split('-').filter(Boolean);
  const preferred = quality === 'lossless' ? 2 : quality === 'high' || quality === 'medium' ? 1 : 0;
  const order = [parts[preferred], parts[preferred === 2 ? 1 : 0], parts[0]];
  return [...new Set(order.filter(Boolean))];
}

async function getSongResource(songId, _cookie, env) {
  const quality = String(env?.MUSIC_QUALITY || 'low').toLowerCase();
  const candidates = hashCandidates(songId, quality);
  if (!candidates.length) return null;

  let reason = '';
  for (const hash of candidates) {
    const info = await fetchSongInfo(hash);
    if (!info) continue;
    if (info.url) {
      const bitrate = Number(info.bitRate) || BITRATE[quality] || BITRATE.low;
      const format = String(info.extName || '').toLowerCase() === 'flac' ? 'flac' : 'mp3';
      return {
        url: info.url,
        bitrate,
        format,
        size: Number(info.fileSize) || 0,
        quality,
        // 酷狗 CDN 直链带签名，有效期很短，缓存层只保留 90 秒
        expiresAt: Date.now() + 90 * 1000,
      };
    }
    reason ||= String(info.error || info.err || '');
  }
  if (reason) console.warn(`[Kugou] ${songId}: ${reason}`);
  // 没有 URL 时返回 null，交给 player-policy 继续降级；全部失败会给出统一的版权提示
  return null;
}

export {
  KugouError, checkLoginStatus, checkQRCode, createQRCode, getPlaylistDetail, getSongResource,
};
