const crypto = require('crypto');
const {
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  captcha_sent,
  login_cellphone,
  user_playlist,
  user_subcount,
  playlist_detail,
  song_url
} = require('NeteaseCloudMusicApi');

function normalizeCookie(cookie) {
  if (!cookie) return '';
  if (Array.isArray(cookie)) return cookie.join('; ');
  return String(cookie);
}

function getArtists(track) {
  const artists = track?.ar || track?.artists || [];
  return artists.map(a => a?.name).filter(Boolean).join('/');
}

function getDurationSeconds(track) {
  const ms = track?.dt ?? track?.duration ?? 0;
  const sec = Math.round(Number(ms) / 1000);
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

function getTrackCoverUrl(track) {
  const url =
    track?.al?.picUrl ??
    track?.album?.picUrl ??
    track?.picUrl ??
    track?.cover ??
    '';
  return url ? String(url) : '';
}

async function createQRCode() {
  const keyRes = await login_qr_key({ timestamp: Date.now() });
  if (keyRes?.body?.code !== 200 || !keyRes?.body?.data?.unikey) {
    throw new Error(keyRes?.body?.message || '获取二维码 key 失败');
  }

  const key = keyRes.body.data.unikey;
  const createRes = await login_qr_create({ key, qrimg: true, timestamp: Date.now() });
  if (createRes?.body?.code !== 200 || !createRes?.body?.data?.qrimg) {
    throw new Error(createRes?.body?.message || '生成二维码失败');
  }

  return { key, qrimg: createRes.body.data.qrimg };
}

async function checkQRCode(key) {
  const res = await login_qr_check({ key, timestamp: Date.now() });
  const body = res?.body || {};
  return {
    code: body.code,
    message: body.message,
    cookie: normalizeCookie(body.cookie || res?.cookie)
  };
}

async function checkLoginStatus(cookie) {
  const res = await login_status({ cookie: normalizeCookie(cookie), timestamp: Date.now() });
  const data = res?.body?.data || {};
  const profile = data.profile;
  const account = data.account;

  if (!profile || !account) {
    return { logged: false };
  }

  return {
    logged: true,
    userId: profile.userId ?? account.id,
    nickname: profile.nickname,
    avatar: profile.avatarUrl,
    vipType: profile.vipType ?? 0
  };
}

async function sendCaptcha(phone) {
  const res = await captcha_sent({ phone, timestamp: Date.now() });
  return res?.body?.code === 200;
}

async function loginWithCaptcha(phone, captcha) {
  const res = await login_cellphone({ phone, captcha, timestamp: Date.now() });
  const body = res?.body || {};
  if (body.code !== 200) {
    throw new Error(body.message || '验证码登录失败');
  }
  const cookie = normalizeCookie(res?.cookie || body.cookie);
  if (!cookie) throw new Error('登录成功但未获取到 cookie');
  return { cookie };
}

async function loginWithPassword(phone, password) {
  const md5 = crypto.createHash('md5').update(String(password)).digest('hex');
  const res = await login_cellphone({ phone, md5_password: md5, timestamp: Date.now() });
  const body = res?.body || {};
  if (body.code !== 200) {
    throw new Error(body.message || '密码登录失败');
  }
  const cookie = normalizeCookie(res?.cookie || body.cookie);
  if (!cookie) throw new Error('登录成功但未获取到 cookie');
  return { cookie };
}

async function getUserPlaylists(uid, cookie = '', offset = 0, limit = 30) {
  const res = await user_playlist({
    uid,
    limit,
    offset,
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  });

  if (res?.body?.code !== 200) {
    throw new Error(res?.body?.message || '获取用户歌单失败');
  }

  const playlists = res.body.playlist?.map(p => ({
    id: p.id,
    name: p.name,
    cover: p.coverImgUrl,
    trackCount: p.trackCount,
    creator: p.creator?.nickname,
    userId: p.userId,
    playCount: p.playCount
  })) || [];

  let total = 0;
  
  if (res.body.playlistCount !== undefined) {
    total = res.body.playlistCount;
  } else if (res.body.more) {
    total = offset + playlists.length + limit;
  } else {
    total = offset + playlists.length;
  }

  return {
    playlists,
    hasMore: res.body.more,
    count: total
  };
}

async function getPlaylistDetail(playlistId, cookie = '') {
  const res = await playlist_detail({
    id: playlistId,
    s: 8,
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  });

  if (res?.body?.code !== 200 || !res?.body?.playlist) {
    throw new Error(res?.body?.message || '获取歌单失败');
  }

  const p = res.body.playlist;
  const tracks = (p.tracks || []).map(t => ({
    id: t.id,
    name: t.name,
    artist: getArtists(t),
    duration: getDurationSeconds(t),
    cover: getTrackCoverUrl(t)
  }));

  return {
    id: p.id,
    name: p.name,
    cover: p.coverImgUrl,
    songCount: p.trackCount || tracks.length,
    tracks
  };
}

const QUALITY_LEVELS = {
  low: 128000,
  medium: 192000,
  high: 320000,
  lossless: 999000
};

async function getSongUrl(songId, cookie = '', bitrate) {
  let br = bitrate;
  if (!br) {
    const envQuality = (process.env.MUSIC_QUALITY || '').toLowerCase().trim();
    br = QUALITY_LEVELS[envQuality] || parseInt(process.env.MUSIC_BITRATE) || 128000;
  }

  const res = await song_url({
    id: songId,
    br,
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  });

  if (res?.body?.code !== 200) return null;
  const url = res?.body?.data?.[0]?.url;
  return url ? String(url) : null;
}

module.exports = {
  createQRCode,
  checkQRCode,
  checkLoginStatus,
  sendCaptcha,
  loginWithCaptcha,
  loginWithPassword,
  getUserPlaylists,
  getPlaylistDetail,
  getSongUrl,
  QUALITY_LEVELS
};
