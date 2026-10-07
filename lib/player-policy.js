'use strict';

const LEVELS = {
  low: { label: '标准', format: 'MP3', bitrate: 128000 },
  medium: { label: '较高', format: 'MP3', bitrate: 192000 },
  high: { label: '高品质', format: 'MP3', bitrate: 320000 },
  lossless: { label: '无损', format: 'FLAC', bitrate: null },
};

class PlayerError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message); this.status = status; this.code = code;
  }
}

function qualityName(value, fallback = 'low') {
  const name = String(value || fallback).trim().toLowerCase();
  if (!Object.hasOwn(LEVELS, name)) throw new PlayerError('不支持的音质档位');
  return name;
}

function capabilities(backend, defaultQuality = 'low', cached = false) {
  const mp3Only = backend === 'cloudflare';
  let selected;
  try { selected = qualityName(defaultQuality); } catch (_) { selected = 'low'; }
  if (mp3Only && selected === 'lossless') selected = 'high';
  return {
    backend, mp3Only, defaultQuality: selected, privateCache: cached,
    qualities: Object.entries(LEVELS).map(([id, item]) => ({
      id, ...item, enabled: !(mp3Only && id === 'lossless'),
      reason: mp3Only && id === 'lossless' ? '当前部署仅支持 MP3；无损源需自有服务器与浏览器 FLAC 支持' : '',
    })),
  };
}

async function resolveQuality(getResource, requested, mp3Only = false) {
  const original = qualityName(requested);
  const order = ['lossless', 'high', 'medium', 'low'];
  const start = mp3Only && original === 'lossless' ? 'high' : original;
  const warnings = [];
  let trialResult = null;
  if (start !== original) warnings.push('当前播放链路仅支持 MP3，已切换为高品质 MP3。');
  for (const quality of order.slice(order.indexOf(start))) {
    const resource = await getResource(quality);
    if (resource?.code === 301 || resource?.loginExpired) {
      throw new PlayerError('音乐平台登录态已过期，请重新登录后播放', 401, 'platform_login_expired');
    }
    if (!resource?.url) continue;
    const format = String(resource.format || (/\.flac(?:$|\?)/i.test(resource.url) ? 'flac' : 'mp3')).toLowerCase();
    if (mp3Only && format !== 'mp3') continue;
    const bitrate = Number(resource.bitrate) || LEVELS[quality].bitrate;
    let actual = format === 'flac' ? 'lossless' : quality;
    if (format === 'mp3' && bitrate) actual = bitrate >= 300000 ? 'high' : bitrate >= 190000 ? 'medium' : 'low';
    const messages = warnings.slice();
    if (actual !== start) {
      if (order.indexOf(actual) > order.indexOf(start)) messages.push('请求音质不可用，已降级为' + LEVELS[actual].label + ' ' + format.toUpperCase() + '；高音质可能受账号、VIP、单独购买或地区版权限制。');
      else messages.push('平台返回的实际音质为' + LEVELS[actual].label + ' ' + format.toUpperCase() + '，以显示的实际码率为准。');
    }
    if (resource.trial) messages.push('当前音源为试听片段。完整播放可能需要 VIP、单独购买或不同地区授权。');
    else if (trialResult) messages.push('更高音质仅允许试听，已选用当前可完整播放的音质。');
    const result = { ...resource, format, bitrate, requestedQuality: original, resolvedRequestQuality: quality, quality: actual, warnings: messages };
    if (resource.trial) { trialResult ||= result; continue; }
    return result;
  }
  if (trialResult) return trialResult;
  throw new PlayerError('所有兼容音质均不可播放。请检查登录态、VIP、单独购买权限或地区版权；不会跳过平台授权。', 404, 'unavailable');
}

function allowedSource(value, platform, image = false) {
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.port && url.port !== '443')) return null;
    const host = url.hostname.toLowerCase();
    const allowed = image
      ? /(^|\.)(music\.126\.net|music\.163\.com|qq\.com|gtimg\.cn|qlogo\.cn)$/.test(host)
      : platform === 'qq' ? /(^|\.)(qq\.com|gtimg\.cn|mcobj\.com)$/.test(host)
      : /(^|\.)music\.126\.net$/.test(host);
    if (!allowed || !['https:', 'http:'].includes(url.protocol)) return null;
    if (image && /(^|\.)music\.126\.net$/.test(host)) url.searchParams.set('param', '320y320');
    url.protocol = 'https:'; return url.href;
  } catch (_) { return null; }
}

function normalizedPlaylist(playlist, platform) {
  return {
    id: String(playlist.id), name: String(playlist.name || ''), cover: String(playlist.cover || ''),
    tracks: (playlist.tracks || []).map(track => ({
      id: String(platform === 'qq' ? track.mid || track.id : track.id),
      name: String(track.name || ''), artist: String(track.artist || ''), cover: String(track.cover || playlist.cover || ''),
      duration: Number(track.duration) > 10000 ? Number(track.duration) / 1000 : Number(track.duration) || 180,
    })).filter(track => platform === 'qq' ? /^[a-zA-Z0-9]{1,30}$/.test(track.id) : /^\d{1,20}$/.test(track.id)),
  };
}

module.exports = { LEVELS, PlayerError, qualityName, capabilities, resolveQuality, allowedSource, normalizedPlaylist };
