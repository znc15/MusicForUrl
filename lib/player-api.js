'use strict';
const { PlayerError, qualityName, normalizedPlaylist } = require('./player-policy');

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

// Both runtimes supply identity, persistence and storage; the browser uses one API.
function createPlayerApi(services) {
  return async function playerApi(request) {
    const url = new URL(request.url);
    const path = url.pathname.slice('/api/player'.length);
    if (!['GET', 'HEAD'].includes(request.method)) return json({ success: false, message: '接口不存在' }, 405);
    try {
      if (path === '/capabilities') return json({ success: true, data: services.capabilities() });
      const platform = url.searchParams.get('platform') || 'netease';
      if (!['netease', 'qq'].includes(platform)) throw new PlayerError('平台无效');
      const playlistId = String(url.searchParams.get('id') || '');
      if (!/^\d{1,20}$/.test(playlistId)) throw new PlayerError('歌单 ID 无效');
      const grant = url.searchParams.get('grant') || '';
      const user = grant ? await services.verifyGrant(grant, platform, playlistId)
        : await services.session(request, platform);
      if (!user) throw new PlayerError('登录或播放链接已过期，请重新登录或生成链接', 401, 'login_required');
      const playlist = normalizedPlaylist(await services.playlist(user, playlistId), platform);
      if (path === '/playlist') {
        const token = grant || await services.mintGrant(user, playlistId);
        return json({ success: true, data: { ...playlist, platform, grant: token } });
      }
      const match = path.match(/^\/(resolve|media|cover)\/([A-Za-z0-9]{1,30})$/);
      if (!match) throw new PlayerError('接口不存在', 404);
      const [, action, songId] = match;
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
      }, error.status || 502);
    }
  };
}

module.exports = { createPlayerApi };
