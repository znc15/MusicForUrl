'use strict';
const { PlayerError, qualityName, normalizedPlaylist } = require('./player-policy');

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

// Both runtimes supply identity, persistence and storage; the browser uses one API.
//
// `services.platforms` 是可选的平台规则（列表、歌单 ID、歌曲 ID 校验）。不传时
// 使用下面这套默认值，行为与只有网易云/QQ 时逐字节一致，Node 侧无需改动。
const DEFAULT_PLATFORMS = {
  list: ['netease', 'qq'],
  playlistId: value => /^\d{1,20}$/.test(String(value || '')),
  songId: value => /^[A-Za-z0-9]{1,30}$/.test(String(value || '')),
};

function createPlayerApi(services) {
  return async function playerApi(request) {
    const url = new URL(request.url);
    const path = url.pathname.slice('/api/player'.length);
    if (!['GET', 'HEAD'].includes(request.method)) return json({ success: false, message: '接口不存在' }, 405);
    const platforms = services.platforms;
    const list = platforms?.list || DEFAULT_PLATFORMS.list;
    const playlistIdPattern = platforms?.playlistId || DEFAULT_PLATFORMS.playlistId;
    const songIdPattern = platforms?.songId || DEFAULT_PLATFORMS.songId;
    // 只有提供了自定义校验时才放宽路径匹配，默认分支保持原来的严格正则
    const songPath = platforms?.songId
      ? /^\/(resolve|media|cover)\/([^/]{1,120})$/
      : /^\/(resolve|media|cover)\/([A-Za-z0-9]{1,30})$/;
    try {
      if (path === '/capabilities') return json({ success: true, data: services.capabilities() });
      const platform = url.searchParams.get('platform') || 'netease';
      if (!list.includes(platform)) throw new PlayerError('平台无效');
      const playlistId = String(url.searchParams.get('id') || '');
      if (!playlistIdPattern(playlistId, platform)) throw new PlayerError('歌单 ID 无效');
      const grant = url.searchParams.get('grant') || '';
      const user = grant ? await services.verifyGrant(grant, platform, playlistId)
        : await services.session(request, platform);
      if (!user) throw new PlayerError('登录或播放链接已过期，请重新登录或生成链接', 401, 'login_required');
      const match = path.match(songPath);
      const action = path === '/playlist' ? 'playlist' : match?.[1];
      if (!action) throw new PlayerError('接口不存在', 404);
      const songId = match?.[2];
      if (songId && !songIdPattern(songId, platform)) throw new PlayerError('歌曲 ID 无效');
      await services.admit?.(request, user, action, !!grant);
      const playlist = normalizedPlaylist(await services.playlist(user, playlistId), platform);
      if (path === '/playlist') {
        const token = grant || await services.mintGrant(user, playlistId);
        return json({ success: true, data: { ...playlist, platform, grant: token } });
      }
      const song = playlist.tracks.find(track => track.id === songId);
      if (!song) throw new PlayerError('歌曲不属于该歌单', 403);
      if (action === 'cover') return services.cover(request, user, song.cover, song);
      const requested = qualityName(url.searchParams.get('quality'), services.capabilities().defaultQuality);
      const resource = await services.resolve(user, songId, requested, url.searchParams.get('fresh') === '1');
      if (action === 'resolve') {
        const token = grant || await services.mintGrant(user, playlistId);
        const params = new URLSearchParams({ platform, id: playlistId, grant: token, quality: resource.resolvedRequestQuality || requested });
        return json({ success: true, data: {
          mediaUrl: url.origin + '/api/player/media/' + songId + '?' + params,
          coverUrl: url.origin + '/api/player/cover/' + songId + '?' + params,
          song, requestedQuality: requested, quality: resource.quality, format: resource.format,
          bitrate: resource.bitrate, trial: !!resource.trial, warnings: resource.warnings || [],
          expiresAt: Math.min(Number(resource.expiresAt) || Date.now() + 60000, Date.now() + 90000),
        } });
      }
      return services.media(request, user, song, playlistId, resource);
    } catch (error) {
      if (!(error instanceof PlayerError)) console.error('[Player]', error.message);
      return json({ success: false, code: error.code || 'upstream_error',
        message: error instanceof PlayerError ? error.message : '音源服务暂时不可用，请稍后重试',
      }, error.status || 502, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {});
    }
  };
}

module.exports = { DEFAULT_PLATFORMS, createPlayerApi };
