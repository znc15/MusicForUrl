(function initWorkspace(global) {
  'use strict';

  const TITLES = { home: '链接生成', user: '我的音乐', preview: '视频预览', accounts: '账号管理', about: '关于' };
  let context;
  let hlsScriptPromise;
  let hls;
  let video;
  let localObjectUrl;
  let mediaGeneration = 0;
  let previewSelection = null;
  let pendingPreview = null;

  function routeFromPath(pathname) {
    const path = (pathname || '/').replace(/\/+$/, '') || '/';
    if (path === '/user' || path === '/user.html') return 'user';
    if (path === '/accounts' || path === '/preview' || path === '/about') return path.slice(1);
    return 'home';
  }

  function syncNavigation(view = routeFromPath(location.pathname)) {
    document.querySelectorAll('.sidebar-link').forEach(link => {
      const active = link.dataset.view === view;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const locationLabel = document.getElementById('workspaceLocation');
    if (locationLabel) locationLabel.textContent = TITLES[view];
    global.MfuMotion.syncIndicator(document.querySelector('.sidebar-nav'));
  }

  function preferenceKey(account) {
    return account.user?.userId ? 'mfu:account:' + account.platform + ':' + account.user.userId : null;
  }

  function accountPreferences(account) {
    const key = preferenceKey(account);
    if (!key) return { name: '', remark: '' };
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      return { name: String(value?.name || '').slice(0, 40), remark: String(value?.remark || '').slice(0, 200) };
    } catch (_) { return { name: '', remark: '' }; }
  }

  function renderAccounts() {
    const manager = document.getElementById('accountManager');
    if (!manager || !context) return;
    const accounts = context.accounts();
    const escape = value => context.escape(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const drafts = [...manager.querySelectorAll('form[data-dirty="true"]')].map(form => ({
      platform: form.dataset.platform, userId: form.dataset.userId,
      name: form.elements.name.value, remark: form.elements.remark.value,
    }));
    document.getElementById('accountSummary').textContent =
      accounts.filter(account => account.user).length + ' 个已登录 / 2 个平台';
    manager.innerHTML = accounts.map(account => {
      const platform = account.platform;
      const provider = platform === 'qq' ? 'QQ 音乐' : '网易云音乐';
      const user = account.user;
      const saved = accountPreferences(account);
      const active = context.activePlatform() === platform;
      const connected = !!user;
      const status = connected ? (active ? '当前使用' : '已登录') : (account.hasToken ? '待确认' : '未登录');
      const header = '<div class="account-card-heading"><h2>' + provider + '</h2><span class="subtle-badge' +
        (connected ? ' connected' : '') + '">' + status + '</span></div>';
      if (!connected) {
        return '<section class="account-card glass">' + header +
          '<div class="account-unlinked"><span class="account-avatar-placeholder"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg></span><h3>' +
          (account.hasToken ? '登录信息待确认' : '连接你的音乐账号') + '</h3><button class="btn btn-primary" type="button" data-account-action="' +
          (account.hasToken ? 'refresh' : 'login') + '" data-platform="' + platform + '">' +
          (account.hasToken ? '刷新状态' : '登录' + provider) + '</button>' +
          (account.hasToken ? '<button type="button" class="text-button" data-account-action="login" data-platform="' + platform + '">重新登录</button>' : '') +
          '</div></section>';
      }
      return '<section class="account-card glass">' + header +
        '<div class="account-profile"><img src="' + context.image(user.avatar) +
        '" alt="" referrerpolicy="no-referrer" class="managed-avatar"><div><h3>' +
        escape(saved.name || user.nickname || provider + '账号') + '</h3><p>' +
        escape(user.nickname || '') + '</p></div></div>' +
        '<dl class="account-details"><div><dt>账号 ID</dt><dd>' + escape(String(user.userId || '—')) +
        '</dd></div><div><dt>会员状态</dt><dd>' + (user.vipType > 0 ? '会员账号' : '普通账号') +
        '</dd></div></dl><form class="account-edit-form" data-platform="' + platform + '" data-user-id="' + escape(String(user.userId || '')) + '">' +
        '<div class="form-group"><label for="accountName-' + platform + '">本机名称</label><input id="accountName-' +
        platform + '" name="name" maxlength="40" value="' + escape(saved.name) + '" placeholder="' +
        escape(user.nickname || '账号名称') + '" autocomplete="off"></div>' +
        '<div class="form-group"><label for="accountRemark-' + platform + '">备注</label><textarea id="accountRemark-' +
        platform + '" name="remark" maxlength="200" rows="2" placeholder="添加备注">' + escape(saved.remark) +
        '</textarea></div><button type="submit" class="btn btn-primary full-width"' +
        (preferenceKey(account) ? '' : ' disabled') + '>保存资料</button></form>' +
        '<div class="account-card-actions"><button type="button" class="text-button" data-account-action="use" data-platform="' +
        platform + '"' + (active ? ' disabled' : '') + '>' + (active ? '当前使用' : '切换使用') +
        '</button><button type="button" class="text-button" data-account-action="login" data-platform="' +
        platform + '">切换账号</button><button type="button" class="text-button" data-account-action="logout" data-platform="' +
        platform + '">退出登录</button></div></section>';
    }).join('');
    for (const draft of drafts) {
      const account = accounts.find(item => item.platform === draft.platform);
      if (String(account?.user?.userId || '') !== draft.userId) continue;
      const form = manager.querySelector('form[data-platform="' + draft.platform + '"]');
      if (!form) continue;
      form.elements.name.value = draft.name;
      form.elements.remark.value = draft.remark;
      form.dataset.dirty = 'true';
    }
    global.MfuMotion.hydrate();
  }

  function mountAccounts() {
    renderAccounts();
    const manager = document.getElementById('accountManager');
    manager.addEventListener('input', event => {
      const form = event.target.closest('.account-edit-form');
      if (form) form.dataset.dirty = 'true';
    });
    manager.addEventListener('click', event => {
      const button = event.target.closest('[data-account-action]');
      if (!button) return;
      const platform = button.dataset.platform;
      const action = button.dataset.accountAction;
      if (action === 'login') context.login(platform);
      if (action === 'logout') context.logout(platform);
      if (action === 'refresh') context.refreshAccount(platform);
      if (action === 'use') { context.switchAccount(platform); renderAccounts(); }
    });
    manager.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.target;
      const account = context.accounts().find(item => item.platform === form.dataset.platform);
      const key = account && preferenceKey(account);
      if (!key) return;
      const fields = new FormData(form);
      try {
        localStorage.setItem(key, JSON.stringify({
          name: String(fields.get('name') || '').trim().slice(0, 40),
          remark: String(fields.get('remark') || '').trim().slice(0, 200),
        }));
        delete form.dataset.dirty;
        context.preferencesSaved();
        context.toast('账号资料已保存到此浏览器');
        document.querySelector('.account-edit-form[data-platform="' + account.platform + '"] button[type="submit"]')?.focus();
      } catch (_) { context.toast('无法保存，请检查浏览器存储权限', 'error'); }
    });
  }

  function validateMediaUrl(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch (_) { throw new Error('请输入完整的媒体链接'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('请使用 HTTPS 媒体链接');
    if (url.username || url.password) throw new Error('链接不能包含账号或密码');
    return url.href;
  }

  function loadHlsLibrary() {
    if (global.Hls) return Promise.resolve(global.Hls);
    if (hlsScriptPromise) return hlsScriptPromise;
    hlsScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/js/vendor/hls.min.js';
      script.onload = () => {
        if (global.Hls) resolve(global.Hls);
        else { hlsScriptPromise = null; script.remove(); reject(new Error('预览组件加载失败，请重试')); }
      };
      script.onerror = () => { hlsScriptPromise = null; script.remove(); reject(new Error('预览组件加载失败，请重试')); };
      document.head.append(script);
    });
    return hlsScriptPromise;
  }

  function setPreviewStatus(message, badge = '', error = false) {
    const status = document.getElementById('previewStatus');
    if (status) { status.textContent = message; status.classList.toggle('media-error', error); }
    const state = document.getElementById('previewStateBadge');
    if (state && badge) state.textContent = badge;
  }

  function disposeMedia(disposePlayer = true) {
    if (disposePlayer) global.MfuPlayer?.dispose();
    mediaGeneration++;
    hls?.destroy();
    hls = null;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video = null;
    }
    if (localObjectUrl) { URL.revokeObjectURL(localObjectUrl); localObjectUrl = null; }
  }

  function resetPreview() {
    disposeMedia();
    previewSelection = null;
    const player = document.getElementById('previewVideo');
    if (player) player.hidden = true;
    document.getElementById('previewEmpty')?.removeAttribute('hidden');
    document.getElementById('previewAudioArt')?.setAttribute('hidden', '');
    document.getElementById('previewScreen')?.classList.remove('audio-mode');
    document.getElementById('previewUrl').value = '';
    document.getElementById('previewFile').value = '';
    document.getElementById('previewTitle').textContent = '尚未选择媒体';
    document.getElementById('previewClear').disabled = true;
    setPreviewStatus('选择本地文件，或打开可播放的媒体直链。', '未加载');
  }

  async function openMedia(selection) {
    const owned = selection.id ? selection : (!selection.file ? global.MfuPlayer?.selectionFromUrl(selection.url) : null);
    if (owned) { disposeMedia(false); previewSelection = selection; return global.MfuPlayer.open(owned); }
    disposeMedia();
    video = document.getElementById('previewVideo');
    if (!video) return;
    const player = video;
    const generation = mediaGeneration;
    const current = () => generation === mediaGeneration && player.isConnected;
    previewSelection = selection;
    const source = selection.file ? (localObjectUrl = URL.createObjectURL(selection.file)) : selection.url;
    const cover = document.getElementById('previewCover');
    if (cover) cover.src = selection.cover || '/placeholder.svg';
    const artist = document.getElementById('previewArtist');
    if (artist) artist.textContent = '音频预览';
    player.hidden = false;
    document.getElementById('previewEmpty').hidden = true;
    document.getElementById('previewClear').disabled = false;
    document.getElementById('previewTitle').textContent = selection.title || new URL(source).hostname;
    document.getElementById('previewUrl').value = selection.file ? '' : source;
    setPreviewStatus('正在读取媒体…', '加载中');
    const audioMode = audio => {
      document.getElementById('previewScreen')?.classList.toggle('audio-mode', audio);
      const art = document.getElementById('previewAudioArt');
      if (art) art.hidden = !audio;
    };
    audioMode(!!selection.audio);
    player.onloadedmetadata = () => {
      if (!current()) return;
      const audio = !!selection.audio || player.videoWidth === 0;
      audioMode(audio);
      setPreviewStatus(audio ? '纯音频 · 使用下方播放控制开始收听' : '已就绪 · 使用下方播放控制开始预览', '已就绪');
    };
    player.onplaying = () => { if (current()) setPreviewStatus('正在播放', '播放中'); };
    player.onpause = () => { if (current() && !player.ended) setPreviewStatus('已暂停', '已暂停'); };
    player.onended = () => { if (current()) setPreviewStatus('播放结束', '已结束'); };
    player.onwaiting = () => { if (current()) setPreviewStatus('正在缓冲…', '缓冲中'); };
    player.onerror = () => {
      if (current()) setPreviewStatus('无法播放该媒体。请检查直链、链接有效期、跨域权限或编码格式。', '加载失败', true);
    };
    try {
      const isHls = !selection.file && /\.m3u8(?:$|[?#])/i.test(source);
      if (!isHls) {
        player.removeAttribute('crossorigin');
        player.src = source;
        player.load();
        return;
      }
      const Hls = await loadHlsLibrary();
      if (!current()) return;
      if (!Hls.isSupported()) {
        if (player.canPlayType('application/vnd.apple.mpegurl')) {
          player.removeAttribute('crossorigin');
          player.src = source;
          player.load();
          return;
        }
        throw new Error('当前浏览器不支持 HLS，请尝试 MP4 或其他浏览器');
      }
      player.setAttribute('crossorigin', 'anonymous');
      hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 30, debug: false });
      const instance = hls;
      let recovered = false;
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!current() || !data.fatal) return;
        console.warn('Media preview:', data.details, data.response?.code || '');
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          instance.recoverMediaError();
          return;
        }
        instance.destroy();
        if (hls === instance) hls = null;
        setPreviewStatus(data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? '无法读取媒体。请检查链接是否过期，以及源站是否允许跨域访问。'
          : '此媒体的编码或分片无法在当前浏览器中播放。', '加载失败', true);
      });
      instance.loadSource(source);
      instance.attachMedia(player);
    } catch (error) {
      if (current()) setPreviewStatus(error.message || '无法打开媒体', '加载失败', true);
    }
  }

  function generatedSelection() {
    const generated = context.generated();
    return generated.url ? { url: generated.url, title: generated.title || '歌单预览', audio: true,
      id: generated.id, cover: generated.cover, platform: generated.platform } : null;
  }

  function previewGenerated() {
    const selection = generatedSelection();
    if (!selection) { context.toast('请先生成歌单链接', 'error'); return; }
    if (document.getElementById('previewVideo')) openMedia(selection);
    else { pendingPreview = selection; context.navigate('/preview'); }
  }

  function mountPreview() {
    global.MfuPlayer.mount({ platform: context.activePlatform, headers: context.headers,
      status: setPreviewStatus });
    const previousUrl = previewSelection?.file ? '' : previewSelection?.url || '';
    document.getElementById('previewUrl').value = previousUrl;
    document.getElementById('previewGenerated').disabled = !context.generated().url;
    document.getElementById('previewGenerated').addEventListener('click', previewGenerated);
    document.getElementById('previewClear').addEventListener('click', resetPreview);
    document.getElementById('previewForm').addEventListener('submit', event => {
      event.preventDefault();
      const input = document.getElementById('previewUrl');
      try {
        const url = validateMediaUrl(input.value);
        const parsed = new URL(url);
        openMedia({ url, title: parsed.hostname, audio: /\.(mp3|m4a|aac|wav|ogg)(?:$|[?#])/i.test(url) });
        input.removeAttribute('aria-invalid');
      } catch (error) { input.setAttribute('aria-invalid', 'true'); setPreviewStatus(error.message, '链接无效', true); }
    });
    document.getElementById('previewFile').addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!/^(video|audio)\//.test(file.type) && !/\.(mp4|webm|mov|mp3|m4a|ogg|wav|aac)$/i.test(file.name)) {
        setPreviewStatus('请选择浏览器可播放的视频或音频文件', '格式不支持', true);
        event.target.value = '';
        return;
      }
      openMedia({ file, title: file.name, audio: file.type.startsWith('audio/') || /\.(mp3|m4a|ogg|wav|aac)$/i.test(file.name) });
    });
    if (pendingPreview) { const selection = pendingPreview; pendingPreview = null; openMedia(selection); }
  }

  async function mountAbout() {
    const release = document.getElementById('aboutRelease');
    const backend = document.getElementById('aboutBackend');
    fetch('/api/player/capabilities').then(response => response.json()).then(result => {
      if (backend?.isConnected && result.backend) backend.textContent = result.backend === 'cloudflare' ? 'Cloudflare · D1' : 'Node.js · SQLite';
    }).catch(() => { if (backend?.isConnected) backend.textContent = '未获取到部署信息'; });
    try {
      const response = await fetch('/app-meta.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error('No build metadata');
      const meta = await response.json();
      if (!release.isConnected) return;
      release.textContent = 'v' + meta.version;
      document.getElementById('aboutVersion').textContent = 'v' + meta.version;
    } catch (_) { if (release.isConnected) release.textContent = 'MusicForUrl'; }
  }

  global.MfuWorkspace = {
    TITLES, routeFromPath, syncNavigation, accountPreferences, validateMediaUrl,
    bind(value) { context = value; },
    mount(view) {
      syncNavigation(view);
      if (view === 'accounts') mountAccounts();
      if (view === 'preview') mountPreview();
      if (view === 'about') mountAbout();
    },
    leave() { disposeMedia(); if (previewSelection?.file) previewSelection = null; },
    refreshAccounts: renderAccounts, previewGenerated,
    invalidatePlatform(platform) {
      if (previewSelection?.platform === platform) {
        if (document.getElementById('previewVideo')) resetPreview();
        else { disposeMedia(); previewSelection = null; }
      }
      if (pendingPreview?.platform === platform) pendingPreview = null;
    },
  };
})(window);
