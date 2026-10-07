(function initPlayer(global) {
  'use strict';
  let context, player, capabilities, list, trackIndex = 0, generation = 0, abort, quality = 'low';
  const resolved = new Map();
  let ready = Promise.resolve();
  const el = id => document.getElementById(id);
  const storageKey = 'mfu:player-quality';
  function status(text, badge) { context.status(text, badge); }
  async function request(path, signal) {
    const platform = new URL('/api/player' + path, location.origin).searchParams.get('platform') || list?.platform || context.platform();
    const response = await fetch('/api/player' + path, { headers: context.headers(platform),
      signal, credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !body.success) { const error = new Error(body.message || '媒体服务暂时不可用'); error.code = body.code; throw error; }
    return body.data;
  }
  function params(extra = {}) {
    return new URLSearchParams({ platform: list.platform, id: list.id, grant: list.grant, quality, ...extra });
  }
  function safeImage(value) {
    try { const url = new URL(value, location.origin); return ['https:', 'http:'].includes(url.protocol) ? url.href : '/placeholder.svg'; }
    catch (_) { return '/placeholder.svg'; }
  }
  function setCover(value, title) {
    const image = el('previewCover');
    if (!image) return;
    image.alt = title ? title + ' 封面' : '音乐封面';
    image.onerror = () => { image.onerror = null; image.src = '/placeholder.svg'; };
    image.src = safeImage(value || '/placeholder.svg');
    image.hidden = false;
    global.MfuMotion.reveal(image);
  }
  function renderQueue() {
    const area = el('previewQueue');
    if (area.mfuPlaylist !== list) {
      area.replaceChildren(); area.mfuPlaylist = list;
      list.tracks.forEach((track, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'queue-track' + (index === trackIndex ? ' active' : '');
      button.setAttribute('aria-pressed', String(index === trackIndex));
      const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0');
      const title = document.createElement('strong'); title.textContent = track.name || track.id;
      const artist = document.createElement('small'); artist.textContent = track.artist;
      button.append(number, title, artist);
      button.addEventListener('click', () => playTrack(index, { autoplay: true }));
      area.append(button);
      });
    }
    const old = area.querySelector('.queue-track.active');
    if (old) { old.classList.remove('active'); old.setAttribute('aria-pressed', 'false'); }
    const selected = area.children[trackIndex];
    if (selected) { selected.classList.add('active'); selected.setAttribute('aria-pressed', 'true'); }
    el('previewPrev').disabled = trackIndex === 0;
    el('previewNext').disabled = trackIndex >= list.tracks.length - 1;
    el('previewTrackCount').textContent = (trackIndex + 1) + ' / ' + list.tracks.length;
  }
  async function resource(index, fresh = false) {
    const key = index + ':' + quality;
    const value = resolved.get(key);
    if (!fresh && value?.expiresAt > Date.now() + 5000) return value;
    const result = await request('/resolve/' + list.tracks[index].id + '?' + params(fresh ? { fresh: '1' } : {}), abort.signal);
    resolved.set(key, result); return result;
  }
  async function prefetchNext(owner) {
    const index = trackIndex + 1;
    if (index >= list.tracks.length || owner !== generation) return;
    try {
      const next = await resource(index);
      if (owner !== generation) return;
      const image = new Image(); image.src = safeImage(next.coverUrl);
    } catch (_) {}
  }
  async function playTrack(index, options = {}) {
    if (!list || index < 0 || index >= list.tracks.length) return;
    const owner = ++generation;
    abort?.abort(); abort = new AbortController();
    const wasPlaying = !player.paused;
    player.pause(); player.removeAttribute('src'); player.load();
    trackIndex = index;
    const track = list.tracks[index];
    setCover('/api/player/cover/' + track.id + '?' + params(), track.name);
    el('previewTitle').textContent = track.name || track.id;
    el('previewArtist').textContent = track.artist || list.name;
    el('previewQualityNotice').textContent = '';
    el('previewScreen').classList.add('audio-mode');
    el('previewAudioArt').hidden = false; el('previewEmpty').hidden = true; player.hidden = false;
    renderQueue(); status('正在解析音源…', '加载中');
    try {
      const result = await resource(index, !!options.fresh);
      if (owner !== generation) return;
      if (result.format === 'flac' && !player.canPlayType('audio/flac')) {
        quality = 'high'; el('previewQuality').value = quality;
        await playTrack(index, { ...options, offset: options.offset });
        el('previewQualityNotice').textContent = '浏览器不支持 FLAC，已改用高品质 MP3。';
        return;
      }
      const level = capabilities.qualities.find(item => item.id === result.quality)?.label || '';
      el('previewFormat').textContent = level + ' · ' + result.format.toUpperCase() + (result.bitrate ? ' · ' + Math.round(result.bitrate / 1000) + ' kbps' : '');
      el('previewQualityNotice').textContent = result.warnings.join(' ');
      if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: track.artist, album: list.name,
          artwork: [{ src: result.coverUrl }] });
      }
      player.preload = 'auto';
      player.onloadedmetadata = () => {
        if (owner !== generation) return;
        if (Number.isFinite(options.offset) && options.offset > 0) {
          player.currentTime = Math.min(options.offset, Math.max(0, player.duration - 0.1));
        }
        if (options.autoplay || wasPlaying) player.play().catch(() => status('已就绪，点击播放开始', '已就绪'));
        else status('已就绪', '已就绪');
      };
      player.onplaying = () => { if (owner === generation) { status('正在播放', '播放中'); el('previewScreen').dataset.playing = 'true'; } };
      player.onpause = () => { if (owner === generation) { status('已暂停', '已暂停'); delete el('previewScreen').dataset.playing; } };
      player.onwaiting = () => { if (owner === generation) status('正在缓冲…', '缓冲中'); };
      player.onended = () => { if (owner === generation) {
        delete el('previewScreen').dataset.playing;
        if (trackIndex + 1 < list.tracks.length) playTrack(trackIndex + 1, { autoplay: true });
        else status('歌单播放结束', '已结束');
      } };
      player.onerror = () => {
        if (owner !== generation) return;
        if (!options.fresh) playTrack(index, { autoplay: wasPlaying || options.autoplay, offset: player.currentTime, fresh: true });
        else status('无法播放：检查登录态、曲目授权或浏览器编码支持。可切换 MP3 档位后重试。', '播放失败');
      };
      player.src = result.mediaUrl; player.load();
      prefetchNext(owner);
    } catch (error) {
      if (owner !== generation || error.name === 'AbortError') return;
      status(error.message, '无法播放');
      el('previewQualityNotice').textContent = error.message;
    }
  }
  async function open(selection) {
    const pendingGeneration = generation;
    await ready;
    if (pendingGeneration !== generation) return;
    dispose();
    player = el('previewVideo');
    abort = new AbortController();
    const owner = generation;
    try {
      const query = new URLSearchParams({ platform: selection.platform || context.platform(), id: selection.id });
      if (selection.grant) query.set('grant', selection.grant);
      list = await request('/playlist?' + query, abort.signal);
      if (owner !== generation || !player?.isConnected) return;
      if (!list.tracks.length) throw new Error('歌单没有可播放的曲目');
      el('previewMusicControls').hidden = false;
      el('previewQueuePanel').hidden = false;
      el('previewClear').disabled = false;
      el('previewUrl').value = selection.url || '';
      await playTrack(0, { autoplay: !!selection.autoplay });
    } catch (error) { if (owner === generation && error.name !== 'AbortError') status(error.message, '无法加载'); }
  }
  function dispose() {
    generation++; abort?.abort(); abort = null;
    resolved.clear(); list = null;
    if (player) {
      player.pause(); player.onloadedmetadata = player.onplaying = player.onpause = player.onwaiting = player.onended = player.onerror = null;
      player.removeAttribute('src'); player.load(); player = null;
    }
    if (el('previewMusicControls')) el('previewMusicControls').hidden = true;
    if (el('previewQueuePanel')) el('previewQueuePanel').hidden = true;
    if (el('previewScreen')) { delete el('previewScreen').dataset.playing; }
  }
  async function setup(value) {
    const target = el('previewQuality');
    context = value;
    try {
      const result = await request('/capabilities');
      if (!target?.isConnected || el('previewQuality') !== target) return;
      capabilities = result;
      const select = el('previewQuality'); select.replaceChildren();
      for (const option of capabilities.qualities) {
        const node = document.createElement('option'); node.value = option.id;
        node.textContent = option.label + ' · ' + option.format + (!option.enabled ? '（当前部署不可用）' : '');
        node.disabled = !option.enabled; select.append(node);
      }
      try { quality = localStorage.getItem(storageKey) || capabilities.defaultQuality; } catch (_) { quality = capabilities.defaultQuality; }
      if (!capabilities.qualities.some(item => item.id === quality && item.enabled)) quality = capabilities.defaultQuality;
      select.value = quality;
      el('previewQualityHelp').textContent = capabilities.mp3Only ? 'MP3 播放模式 · 无损 FLAC 不可用' : '无损需曲目权限与浏览器 FLAC 支持';
      select.onchange = () => {
        quality = select.value;
        try { localStorage.setItem(storageKey, quality); } catch (_) {}
        if (list && player) playTrack(trackIndex, { offset: player.currentTime, autoplay: !player.paused });
      };
      el('previewPrev').onclick = () => playTrack(trackIndex - 1, { autoplay: true });
      el('previewNext').onclick = () => playTrack(trackIndex + 1, { autoplay: true });
    } catch (_) { if (el('previewQualityHelp')) el('previewQualityHelp').textContent = '音质服务暂时不可用'; }
  }
  function selectionFromUrl(value) {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin) return null;
    const match = url.pathname.match(/^\/api\/(qq\/)?playlist\/m3u8\/([^/]+)\/(\d{1,20})\/stream\.m3u8$/);
    return match ? { id: match[3], platform: match[1] ? 'qq' : 'netease', grant: decodeURIComponent(match[2]), url: url.href } : null;
  }
  global.MfuPlayer = { mount(value) { dispose(); ready = setup(value); return ready; }, open, dispose, selectionFromUrl };
})(window);
