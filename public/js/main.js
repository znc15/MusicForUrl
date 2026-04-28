let token = localStorage.getItem('token') || '';
let currentUser = null;

let currentPlaylist = null;
let userPlaylists = [];
let playlistPage = 1;
let playlistTotal = 0;
let isLoadingPlaylists = false;
const PAGE_SIZE = 5;

let userFavorites = [];
let favoritePage = 1;
let favoriteTotal = 0;
let isLoadingFavorites = false;

let userHistory = [];
let historyPage = 1;
let historyTotal = 0;
let isLoadingHistory = false;

let qrKey = '';
let qrCheckInterval = null;

let currentPlatform = 'netease';
let qqToken = localStorage.getItem('qqToken') || '';
let qqCurrentUser = null;
let qqQrKey = '';
let qqQrCheckInterval = null;
let qqUserPlaylists = [];
let qqPlaylistPage = 1;
let qqPlaylistTotal = 0;
let isLoadingQQPlaylists = false;
let qqUserFavorites = [];
let qqFavoritePage = 1;
let qqFavoriteTotal = 0;
let isLoadingQQFavorites = false;
let qqUserHistory = [];
let qqHistoryPage = 1;
let qqHistoryTotal = 0;
let isLoadingQQHistory = false;
let loginPlatform = 'netease';
const PERSONAL_PLATFORM_TAB_KEY = 'personalPlatformTab';
let personalPlatform = localStorage.getItem(PERSONAL_PLATFORM_TAB_KEY) || '';
let neteaseCenterTab = 'playlists';
let qqCenterTab = 'playlists';

const SPA_VIEW_CONTAINER_ID = 'appView';
const SPA_VIEW_CACHE = new Map();
let lastAutoPlayId = null;
let lastGeneratedUrl = '';
let lastGeneratedUrls = [];
let selectedGeneratedUrlType = 'hls';
const MFU_ERROR = (typeof window !== 'undefined' && window.MfuError) ? window.MfuError : null;

function hasSpaContainer() {
  return !!document.getElementById(SPA_VIEW_CONTAINER_ID);
}

function resolveViewFromPath(pathname) {
  const p = (pathname || '/').replace(/\/+$/, '') || '/';
  if (p === '/user' || p === '/user.html') return 'user';
  return 'home';
}

function viewTitle(view) {
  if (view === 'user') return '个人中心 - MusicForUrl';
  return 'MusicForUrl';
}

function isUserViewActive() {
  return resolveViewFromPath(window.location.pathname) === 'user';
}

function rememberPersonalPlatform(platform) {
  const value = platform === 'qq' ? 'qq' : 'netease';
  personalPlatform = value;
  localStorage.setItem(PERSONAL_PLATFORM_TAB_KEY, value);
}

function resolveDefaultPersonalPlatform() {
  const hasNetease = !!token;
  const hasQQ = !!qqToken;

  if (hasNetease && !hasQQ) return 'netease';
  if (!hasNetease && hasQQ) return 'qq';
  if (hasNetease && hasQQ) {
    const saved = localStorage.getItem(PERSONAL_PLATFORM_TAB_KEY);
    if (saved === 'netease' || saved === 'qq') return saved;
    return 'netease';
  }
  return 'netease';
}

function refreshPersonalCenterIfActive() {
  if (!isUserViewActive()) return;
  renderPersonalCenter();
}

function navigate(path, { replace = false } = {}) {
  if (!path) return;

  if (!hasSpaContainer()) {
    window.location.href = path;
    return;
  }

  const url = new URL(path, window.location.origin);
  const next = url.pathname + url.search + url.hash;

  if (replace) {
    history.replaceState({}, '', next);
  } else {
    history.pushState({}, '', next);
  }
  renderCurrentRoute();
}

async function fetchViewHtml(view) {
  if (SPA_VIEW_CACHE.has(view)) return SPA_VIEW_CACHE.get(view);

  const requestPath = `/views/${view}.html`;
  let res;
  try {
    res = await fetch(requestPath, { cache: 'no-cache' });
  } catch (error) {
    throw normalizeRuntimeError('SPA_VIEW_FETCH', error, requestPath);
  }

  if (!res.ok) {
    if (MFU_ERROR && typeof MFU_ERROR.normalizeHttpError === 'function') {
      throw MFU_ERROR.normalizeHttpError({
        scope: 'SPA_VIEW_FETCH',
        status: res.status,
        payload: null,
        requestPath
      });
    }
    throw new Error('页面加载失败，请刷新重试');
  }

  let html;
  try {
    html = await res.text();
  } catch (error) {
    const parseError = Object.assign(new Error(error && error.message ? error.message : 'view html parse error'), {
      __mfuType: 'PARSE',
      __mfuStatus: res.status
    });
    throw normalizeRuntimeError('SPA_VIEW_FETCH', parseError, requestPath);
  }
  SPA_VIEW_CACHE.set(view, html);
  return html;
}

function animateViewEnter(container) {
  if (!container) return;
  container.classList.remove('view-enter');
  void container.offsetWidth;
  container.classList.add('view-enter');
}

async function renderView(view) {
  const container = document.getElementById(SPA_VIEW_CONTAINER_ID);
  if (!container) return;

  container.innerHTML = `<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>`;
  document.title = viewTitle(view);

  try {
    const html = await fetchViewHtml(view);
    container.innerHTML = html;
    animateViewEnter(container);
    onViewMounted(view);
  } catch (e) {
    logError({
      channel: 'spa',
      scope: 'SPA_VIEW_FETCH',
      requestPath: `/views/${view}.html`,
      errorCode: e && e.errorCode,
      meta: e && e._errorMeta ? e._errorMeta : e
    });
    container.innerHTML = `<div class="empty">${escapeHtml(toErrorDisplay(e, '页面加载失败，请刷新重试'))}</div>`;
    animateViewEnter(container);
  }
}

function renderCurrentRoute() {
  if (!hasSpaContainer()) return;
  const view = resolveViewFromPath(window.location.pathname);
  renderView(view);
}

function interceptInternalLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;

    const href = a.getAttribute('href');
    if (!href) return;
    if (a.target === '_blank' || a.hasAttribute('download')) return;
    if (/^(https?:|mailto:|tel:)/i.test(href)) return;
    if (href.startsWith('#')) return;

    if (!href.startsWith('/')) return;
    if (href.startsWith('/api/') || href.startsWith('/includes/') || href.startsWith('/views/')) return;

    if (hasSpaContainer()) {
      e.preventDefault();
      navigate(href);
    }
  });
}

function maybeRestoreHomeState() {
  const result = document.getElementById('resultSection');
  if (!result) return;

  if (currentPlaylist && lastGeneratedUrl) {
    const cover = document.getElementById('playlistCover');
    const name = document.getElementById('playlistName');
    const meta = document.getElementById('playlistMeta');
    const urlOptions = document.getElementById('playlistUrlOptions');

    if (cover) cover.src = imageSrc(currentPlaylist.cover);
    if (name) name.textContent = currentPlaylist.name || '';
    if (meta) meta.textContent = `共 ${currentPlaylist.songCount} 首`;
    if (urlOptions) renderGeneratedUrlOptions();
    result.classList.add('show');
    updateFavoriteBtn();
  }
}

function getSelectedGeneratedUrl() {
  if (Array.isArray(lastGeneratedUrls) && lastGeneratedUrls.length) {
    const picked =
      lastGeneratedUrls.find(u => u && u.type === selectedGeneratedUrlType) ||
      lastGeneratedUrls[0];
    if (picked && picked.url) return String(picked.url);
  }
  return String(lastGeneratedUrl || '');
}

function renderGeneratedUrlOptions() {
  const container = document.getElementById('playlistUrlOptions');
  if (!container) return;

  if (!Array.isArray(lastGeneratedUrls) || lastGeneratedUrls.length === 0) {
    container.innerHTML = '';
    return;
  }

  const html = lastGeneratedUrls.map((opt) => {
    const type = String(opt && opt.type ? opt.type : '');
    const label = escapeHtml(opt && opt.label ? opt.label : type);
    const note = escapeHtml(opt && opt.note ? opt.note : '');
    const url = escapeHtml(opt && opt.url ? opt.url : '');
    const selected = type && type === selectedGeneratedUrlType;
    const selectedBadge = selected ? '<div class="url-option-selected">已选</div>' : '';
    const noteHtml = note ? `<div class="url-option-note">${note}</div>` : '';

    return `
      <div class="url-option ${selected ? 'selected' : ''}" onclick="selectUrlOption('${type}')">
        <div class="url-option-header">
          <div class="url-option-title">${label}</div>
          ${selectedBadge}
        </div>
        ${noteHtml}
        <div class="url-option-url">${url}</div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

function selectUrlOption(type) {
  selectedGeneratedUrlType = String(type || '');
  lastGeneratedUrl = getSelectedGeneratedUrl();
  renderGeneratedUrlOptions();
}

async function maybeAutoplayFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const playId = urlParams.get('play');
  if (!playId) return;
  if (playId === lastAutoPlayId) return;
  lastAutoPlayId = playId;

  const platform = urlParams.get('platform');
  if (platform && platform !== currentPlatform) switchPlatform(platform);

  const input = document.getElementById('playlistInput');
  if (!input) return;
  input.value = playId;
  await generatePlaylist();
}

function onViewMounted(view) {
  if (view === 'home') {
    restorePlatformTab();
    maybeRestoreHomeState();
    maybeAutoplayFromUrl();
    return;
  }

  if (view === 'user') {
    if (!token && !qqToken) {
      showToast('请先登录', 'error');
      showLogin();
      navigate('/', { replace: true });
      return;
    }

    rememberPersonalPlatform(resolveDefaultPersonalPlatform());
    renderPersonalCenter();
  }
}

function renderPersonalAuthPanel(platform) {
  const isQQ = platform === 'qq';
  const platformName = isQQ ? 'QQ音乐' : '网易云音乐';
  const action = isQQ ? "showLogin('qq')" : "showLogin('netease')";
  return `
    <div class="platform-auth-empty">
      <p>当前未登录${platformName}</p>
      <button class="btn btn-primary" onclick="${action}">登录${platformName}</button>
    </div>
  `;
}

function renderPlatformStatusCard(platform) {
  const isQQ = platform === 'qq';
  const user = isQQ ? qqCurrentUser : currentUser;
  const hasToken = isQQ ? !!qqToken : !!token;
  const logoutAction = isQQ ? 'logoutQQ()' : 'logout()';
  const badge = isQQ
    ? '<span class="platform-badge qq">QQ音乐</span>'
    : '<span class="platform-badge netease">网易云</span>';

  if (!hasToken) return '';

  if (!user) {
    return `
      <div class="platform-account">
        ${badge}
        <span class="account-name">已登录，正在加载账号信息...</span>
        <button class="btn btn-ghost" style="padding:0.3rem 0.6rem;font-size:0.8rem;" onclick="${logoutAction}">退出</button>
      </div>
    `;
  }

  const av = imageSrc(user.avatar);
  const name = escapeHtml(user.nickname);
  const vipBadge = (!isQQ && user.vipType > 0)
    ? `<span class="vip-badge">${user.vipType === 11 ? '黑胶' : 'VIP'}</span>`
    : '';

  return `
    <div class="platform-account">
      ${badge}
      <img class="user-avatar" src="${av}" alt="" referrerpolicy="no-referrer" loading="lazy">
      <span class="account-name">${name}</span>
      ${vipBadge}
      <button class="btn btn-ghost" style="padding:0.3rem 0.6rem;font-size:0.8rem;" onclick="${logoutAction}">退出</button>
    </div>
  `;
}

function switchPersonalPlatform(platform) {
  rememberPersonalPlatform(platform);
  renderPersonalCenter();
}

function renderPersonalCenter() {
  if (!isUserViewActive()) return;

  const neteaseTabBtn = document.getElementById('personalPlatformNetease');
  const qqTabBtn = document.getElementById('personalPlatformQQ');
  const neteasePanel = document.getElementById('neteasePanel');
  const qqPanel = document.getElementById('qqPanel');
  const neteaseAuthState = document.getElementById('neteaseAuthState');
  const qqAuthState = document.getElementById('qqAuthState');
  const neteaseContent = document.getElementById('neteaseContent');
  const qqContent = document.getElementById('qqContent');

  if (!neteasePanel || !qqPanel || !neteaseAuthState || !qqAuthState || !neteaseContent || !qqContent) {
    return;
  }

  if (personalPlatform !== 'netease' && personalPlatform !== 'qq') {
    personalPlatform = resolveDefaultPersonalPlatform();
  }

  if (neteaseTabBtn) neteaseTabBtn.classList.toggle('active', personalPlatform === 'netease');
  if (qqTabBtn) qqTabBtn.classList.toggle('active', personalPlatform === 'qq');
  neteasePanel.classList.toggle('active', personalPlatform === 'netease');
  qqPanel.classList.toggle('active', personalPlatform === 'qq');

  if (token) {
    neteaseAuthState.innerHTML = renderPlatformStatusCard('netease');
    neteaseContent.style.display = '';
    if (personalPlatform === 'netease') switchPersonalTab(neteaseCenterTab);
  } else {
    neteaseAuthState.innerHTML = renderPersonalAuthPanel('netease');
    neteaseContent.style.display = 'none';
  }

  if (qqToken) {
    qqAuthState.innerHTML = renderPlatformStatusCard('qq');
    qqContent.style.display = '';
    if (personalPlatform === 'qq') {
      if (qqCenterTab !== 'playlists' && qqCenterTab !== 'favorites' && qqCenterTab !== 'history') {
        qqCenterTab = 'playlists';
      }
      switchQQPersonalTab(qqCenterTab);
    }
  } else {
    qqAuthState.innerHTML = renderPersonalAuthPanel('qq');
    qqContent.style.display = 'none';
  }
}

function initSpa() {
  if (!hasSpaContainer()) return;
  window.navigate = navigate;
  interceptInternalLinks();
  window.addEventListener('popstate', renderCurrentRoute);
  renderCurrentRoute();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  installGlobalUiErrorHandlers();
  loadIncludes();
  initSpa();
});

async function loadIncludes() {
  const headerPlaceholder = document.getElementById('header-placeholder');
  const footerPlaceholder = document.getElementById('footer-placeholder');

  if (headerPlaceholder) {
    try {
      const res = await fetch('/includes/header.html');
      if (res.ok) {
        headerPlaceholder.outerHTML = await res.text();
        initTheme();
        if (token) checkLoginStatus();
        if (qqToken) checkQQLoginStatus();
      } else {
        logError({
          channel: 'include',
          requestPath: '/includes/header.html',
          errorCode: MFU_ERROR && typeof MFU_ERROR.buildErrorCode === 'function'
            ? MFU_ERROR.buildErrorCode('HTTP', 'INCLUDE_HEADER', res.status)
            : `E-HTTP-INCLUDE_HEADER-${res.status}`,
          meta: { status: res.status }
        });
      }
    } catch (e) {
      const normalized = normalizeRuntimeError('INCLUDE_HEADER', e, '/includes/header.html');
      logError({
        channel: 'include',
        requestPath: '/includes/header.html',
        errorCode: normalized.errorCode,
        meta: normalized._errorMeta
      });
    }
  }

  if (footerPlaceholder) {
    try {
      const res = await fetch('/includes/footer.html');
      if (res.ok) {
        footerPlaceholder.outerHTML = await res.text();
      } else {
        logError({
          channel: 'include',
          requestPath: '/includes/footer.html',
          errorCode: MFU_ERROR && typeof MFU_ERROR.buildErrorCode === 'function'
            ? MFU_ERROR.buildErrorCode('HTTP', 'INCLUDE_FOOTER', res.status)
            : `E-HTTP-INCLUDE_FOOTER-${res.status}`,
          meta: { status: res.status }
        });
      }
    } catch (e) {
      const normalized = normalizeRuntimeError('INCLUDE_FOOTER', e, '/includes/footer.html');
      logError({
        channel: 'include',
        requestPath: '/includes/footer.html',
        errorCode: normalized.errorCode,
        meta: normalized._errorMeta
      });
    }
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const toggle = document.getElementById('themeToggle');
  
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    if (toggle) toggle.checked = true;
  } else {
    document.documentElement.removeAttribute('data-theme');
    if (toggle) toggle.checked = false;
  }
}

function toggleTheme() {
  const toggle = document.getElementById('themeToggle');
  if (toggle && toggle.checked) {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
  }
}

function showAbout() {
  const modal = document.getElementById('aboutModal');
  if (modal) modal.classList.add('show');
}

function hideAbout() {
  const modal = document.getElementById('aboutModal');
  if (modal) modal.classList.remove('show');
}

function switchPersonalTab(tab) {
  neteaseCenterTab = tab;

  if (!token) return;

  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  
  const tabBtn = document.getElementById(tab === 'playlists' ? 'tabPlaylists' : tab === 'favorites' ? 'tabFavorites' : 'tabHistory');
  const tabContent = document.getElementById(tab === 'playlists' ? 'playlistsContent' : tab === 'favorites' ? 'favoritesContent' : 'historyContent');

  if (tabBtn) tabBtn.classList.add('active');
  if (tabContent) tabContent.classList.add('active');
  
  if (tab === 'playlists') {
    if (userPlaylists.length === 0) {
      loadUserPlaylists(1);
    } else {
      renderPlaylists();
      renderPagination('playlistsPagination', playlistTotal, playlistPage, PAGE_SIZE, 'loadUserPlaylists');
    }
  } else if (tab === 'favorites') {
    if (userFavorites.length === 0) {
      loadFavorites(1);
    } else {
      renderFavorites();
      renderPagination('favoritesPagination', favoriteTotal, favoritePage, PAGE_SIZE, 'loadFavorites');
    }
  } else {
    if (userHistory.length === 0) {
      loadHistory(1);
    } else {
      renderHistory();
      renderPagination('historyPagination', historyTotal, historyPage, PAGE_SIZE, 'loadHistory');
    }
  }
}

function switchQQPersonalTab(tab) {
  qqCenterTab = tab;

  if (!qqToken) return;

  const tabMap = {
    playlists: {
      buttonId: 'tabQQPlaylists',
      contentId: 'qqPlaylistsContent',
      load: () => {
        if (qqUserPlaylists.length === 0) {
          loadQQUserPlaylists(1);
        } else {
          renderQQPlaylists();
          renderPagination('qqPlaylistsPagination', qqPlaylistTotal, qqPlaylistPage, PAGE_SIZE, 'loadQQUserPlaylists');
        }
      }
    },
    favorites: {
      buttonId: 'tabQQFavorites',
      contentId: 'qqFavoritesContent',
      load: () => {
        if (qqUserFavorites.length === 0) {
          loadQQFavorites(1);
        } else {
          renderQQFavorites();
          renderPagination('qqFavoritesPagination', qqFavoriteTotal, qqFavoritePage, PAGE_SIZE, 'loadQQFavorites');
        }
      }
    },
    history: {
      buttonId: 'tabQQHistory',
      contentId: 'qqHistoryContent',
      load: () => {
        if (qqUserHistory.length === 0) {
          loadQQHistory(1);
        } else {
          renderQQHistory();
          renderPagination('qqHistoryPagination', qqHistoryTotal, qqHistoryPage, PAGE_SIZE, 'loadQQHistory');
        }
      }
    }
  };

  const keys = Object.keys(tabMap);
  keys.forEach((key) => {
    const conf = tabMap[key];
    const btn = document.getElementById(conf.buttonId);
    const content = document.getElementById(conf.contentId);
    if (btn) btn.classList.toggle('active', key === tab);
    if (content) content.classList.toggle('active', key === tab);
  });

  if (tabMap[tab]) {
    tabMap[tab].load();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeUrl(url) {
  if (!url) return '';
  const str = String(url);
  const isHttp = /^https?:\/\//i.test(str);

  if (!isHttp) return '';
  return escapeHtml(str);
}

function imageSrc(url) {
  const str = (url == null) ? '' : String(url).trim();
  if (!str) return '/placeholder.svg';

  let u;
  try {
    u = new URL(str);
  } catch (_) {
    return '/placeholder.svg';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '/placeholder.svg';
  if (u.protocol === 'http:') u.protocol = 'https:';

  return escapeHtml(u.toString());
}

function showToast(message, type = 'success') {
  if (typeof shouldDisplayToast === 'function' && !shouldDisplayToast(message)) return;
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast ' + type + ' show';
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function normalizeScope(scope) {
  const value = String(scope || '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  return value || 'UNKNOWN';
}

function normalizeRuntimeError(scope, error, requestPath) {
  if (error && typeof error === 'object' && error.success === false && error.errorCode) {
    return error;
  }

  const normalizedScope = normalizeScope(scope);
  if (MFU_ERROR && typeof MFU_ERROR.normalizeCaughtError === 'function') {
    return MFU_ERROR.normalizeCaughtError({
      scope: normalizedScope,
      error,
      requestPath: requestPath || ''
    });
  }

  return {
    success: false,
    message: (error && error.message) ? String(error.message) : '请求失败，请稍后重试',
    errorCode: `E-FE-${normalizedScope}-UNKNOWN`,
    _errorMeta: {
      kind: 'FE',
      scope: normalizedScope,
      status: null,
      requestPath: requestPath || '',
      rawMessage: (error && error.message) ? String(error.message) : ''
    }
  };
}

function toErrorDisplay(errorLike, fallbackMessage) {
  if (MFU_ERROR && typeof MFU_ERROR.toDisplayMessage === 'function') {
    return MFU_ERROR.toDisplayMessage(errorLike, fallbackMessage);
  }
  return String((errorLike && errorLike.message) || fallbackMessage || '请求失败，请稍后重试');
}

function logError(meta) {
  if (MFU_ERROR && typeof MFU_ERROR.logDebug === 'function') {
    MFU_ERROR.logDebug(meta);
    return;
  }
  console.error('[MFU_ERROR]', meta);
}

function showActionError(errorLike, fallbackMessage) {
  showToast(toErrorDisplay(errorLike, fallbackMessage), 'error');
}

function renderInlineError(container, errorLike, fallbackMessage) {
  if (!container) return;
  container.innerHTML = `<div class="empty">${escapeHtml(toErrorDisplay(errorLike, fallbackMessage))}</div>`;
}

async function requestJson(basePath, path, options = {}, scope = 'UNKNOWN', tokenHeader = '', tokenValue = '') {
  const normalizedScope = normalizeScope(scope);
  const headers = { 'Content-Type': 'application/json' };
  if (tokenHeader && tokenValue) headers[tokenHeader] = tokenValue;

  const requestPath = `${basePath}${path}`;
  const method = String((options && options.method) || 'GET').toUpperCase();
  let res;

  try {
    res = await fetch(requestPath, {
      ...options,
      headers: { ...headers, ...(options && options.headers ? options.headers : {}) }
    });
  } catch (error) {
    const normalized = normalizeRuntimeError(normalizedScope, error, requestPath);
    logError({
      channel: 'request',
      method,
      requestPath,
      errorCode: normalized.errorCode,
      meta: normalized._errorMeta
    });
    return normalized;
  }

  let payload;
  try {
    payload = await res.json();
  } catch (error) {
    const parseError = Object.assign(new Error(error && error.message ? error.message : 'response parse error'), {
      __mfuType: 'PARSE',
      __mfuStatus: res.status
    });
    const normalized = normalizeRuntimeError(normalizedScope, parseError, requestPath);
    logError({
      channel: 'request',
      method,
      requestPath,
      errorCode: normalized.errorCode,
      meta: normalized._errorMeta
    });
    return normalized;
  }

  if (!res.ok || (payload && typeof payload === 'object' && payload.success === false)) {
    const normalized = (MFU_ERROR && typeof MFU_ERROR.normalizeHttpError === 'function')
      ? MFU_ERROR.normalizeHttpError({
        scope: normalizedScope,
        status: res.status,
        payload,
        requestPath
      })
      : {
        success: false,
        message: (payload && payload.message) ? payload.message : '请求失败，请稍后重试',
        errorCode: `E-HTTP-${normalizedScope}-${res.status || 'UNKNOWN'}`,
        _errorMeta: {
          kind: 'HTTP',
          scope: normalizedScope,
          status: res.status || null,
          requestPath,
          rawMessage: (payload && payload.message) ? payload.message : ''
        }
      };

    logError({
      channel: 'request',
      method,
      requestPath,
      errorCode: normalized.errorCode,
      meta: normalized._errorMeta
    });
    return normalized;
  }

  if (payload && typeof payload === 'object') return payload;

  const parseError = Object.assign(new Error('响应结构异常'), {
    __mfuType: 'PARSE',
    __mfuStatus: res.status
  });
  const normalized = normalizeRuntimeError(normalizedScope, parseError, requestPath);
  logError({
    channel: 'request',
    method,
    requestPath,
    errorCode: normalized.errorCode,
    meta: normalized._errorMeta
  });
  return normalized;
}

async function api(path, options = {}, scope = 'UNKNOWN') {
  return requestJson('/api', path, options, scope, 'X-Token', token);
}

async function qqApi(path, options = {}, scope = 'UNKNOWN') {
  return requestJson('/api/qq', path, options, scope, 'X-QQ-Token', qqToken);
}

function installGlobalUiErrorHandlers() {
  if (!MFU_ERROR || typeof MFU_ERROR.installGlobalErrorHandlers !== 'function') return;
  MFU_ERROR.installGlobalErrorHandlers({
    cooldownMs: 5000,
    onError: (errorLike) => {
      showActionError(errorLike, '页面出现未处理异常，请刷新重试');
    }
  });
}

function switchPlatform(platform) {
  if (currentPlatform === platform) return;
  currentPlatform = platform;

  const nBtn = document.getElementById('platformNetease');
  const qBtn = document.getElementById('platformQQ');
  if (nBtn) nBtn.classList.toggle('active', platform === 'netease');
  if (qBtn) qBtn.classList.toggle('active', platform === 'qq');

  const input = document.getElementById('playlistInput');
  if (input) {
    input.value = '';
    input.placeholder = platform === 'qq'
      ? '粘贴QQ音乐歌单链接或ID'
      : '粘贴网易云歌单链接或ID';
  }

  const result = document.getElementById('resultSection');
  if (result) result.classList.remove('show');
  currentPlaylist = null;
  lastGeneratedUrl = '';
  lastGeneratedUrls = [];
}

function restorePlatformTab() {
  const nBtn = document.getElementById('platformNetease');
  const qBtn = document.getElementById('platformQQ');
  if (nBtn) nBtn.classList.toggle('active', currentPlatform === 'netease');
  if (qBtn) qBtn.classList.toggle('active', currentPlatform === 'qq');

  const input = document.getElementById('playlistInput');
  if (input) {
    input.placeholder = currentPlatform === 'qq'
      ? '粘贴QQ音乐歌单链接或ID'
      : '粘贴网易云歌单链接或ID';
  }
}

async function checkLoginStatus() {
  const res = await api('/auth/status', {}, 'AUTH_STATUS');
  if (res.success && res.data.logged) {
    currentUser = res.data.user;
    updateUserUI();
    refreshPersonalCenterIfActive();
  } else if (res.success && !res.data.logged) {
    logout(false);
  } else if (res && res._errorMeta && res._errorMeta.status === 401) {
    logout(false);
  }
}

function updateUserUI() {
  const area = document.getElementById('userArea');
  if (!area) return;

  const hasNetease = !!currentUser;
  const hasQQ = !!qqCurrentUser;

  if (!hasNetease && !hasQQ) {
    area.innerHTML = `<button class="btn btn-primary" onclick="showLogin()">登录</button>`;
    if (isUserViewActive()) navigate('/', { replace: true });
    return;
  }

  area.innerHTML = `<button class="btn btn-primary" onclick="navigate('/user')">个人中心</button>`;
}

function logout(notify = true) {
  if (token) {
    api('/auth/logout', { method: 'POST' }, 'AUTH_LOGOUT');
  }
  token = '';
  currentUser = null;
  userPlaylists = [];
  localStorage.removeItem('token');
  updateUserUI();
  refreshPersonalCenterIfActive();
  if (notify) showToast('已退出网易云登录');
}

function showLogin(platform) {
  const modal = document.getElementById('loginModal');
  if (modal) {
    modal.classList.add('show');
    switchLoginPlatform(platform || currentPlatform || 'netease');
  }
}

function hideLogin() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.remove('show');
  if (qrCheckInterval) {
    clearInterval(qrCheckInterval);
    qrCheckInterval = null;
  }
  if (qqQrCheckInterval) {
    clearInterval(qqQrCheckInterval);
    qqQrCheckInterval = null;
  }
}

function switchLoginPlatform(platform) {
  loginPlatform = platform;

  const nBtn = document.getElementById('loginPlatformNetease');
  const qBtn = document.getElementById('loginPlatformQQ');
  if (nBtn) nBtn.classList.toggle('active', platform === 'netease');
  if (qBtn) qBtn.classList.toggle('active', platform === 'qq');

  const nPanel = document.getElementById('neteaseLoginPanel');
  const qPanel = document.getElementById('qqLoginPanel');
  if (nPanel) nPanel.style.display = platform === 'netease' ? '' : 'none';
  if (qPanel) qPanel.style.display = platform === 'qq' ? '' : 'none';

  const title = document.getElementById('loginModalTitle');
  if (title) title.textContent = platform === 'qq' ? '登录QQ音乐' : '登录网易云';

  if (platform === 'netease') {
    switchLoginTab('qrcode');
    if (qqQrCheckInterval) { clearInterval(qqQrCheckInterval); qqQrCheckInterval = null; }
  } else {
    loadQQQRCode();
    if (qrCheckInterval) { clearInterval(qrCheckInterval); qrCheckInterval = null; }
  }
}

function switchLoginTab(tab) {
  const panel = document.getElementById('neteaseLoginPanel');
  if (!panel) return;

  panel.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
  panel.querySelectorAll('.login-content').forEach(c => c.classList.remove('active'));

  const tabs = ['qrcode', 'captcha', 'password', 'cookie'];
  const index = tabs.indexOf(tab);

  const tabBtns = panel.querySelectorAll('.login-tab');
  if (tabBtns[index]) tabBtns[index].classList.add('active');

  const content = document.getElementById(tab + 'Content');
  if (content) content.classList.add('active');

  if (tab === 'qrcode') {
    loadQRCode();
  } else if (qrCheckInterval) {
    clearInterval(qrCheckInterval);
    qrCheckInterval = null;
  }
}

async function loadQRCode() {
  const img = document.getElementById('qrCodeImg');
  const status = document.getElementById('qrStatus');
  if (!img || !status) return;
  
  img.src = '/placeholder.svg';
  status.textContent = '加载中...';
  
  const res = await api('/auth/qrcode', {}, 'AUTH_QRCODE');
  if (!res.success) {
    status.textContent = toErrorDisplay(res, '获取二维码失败，请重试');
    return;
  }
  
  qrKey = res.data.key;
  img.src = res.data.qrimg;
  status.textContent = '请使用APP扫码';
  
  if (qrCheckInterval) clearInterval(qrCheckInterval);
  qrCheckInterval = setInterval(checkQRCode, 2000);
}

async function checkQRCode() {
  if (!qrKey) return;
  const res = await api('/auth/qrcode/check?key=' + qrKey, {}, 'AUTH_QRCODE_CHECK');
  const status = document.getElementById('qrStatus');

  if (!res.success) {
    if (status) status.textContent = toErrorDisplay(res, '二维码状态检查失败，正在重试…');
    clearInterval(qrCheckInterval);
    setTimeout(loadQRCode, 1000);
    return;
  }
  
  if (res.code === 800) {
    if (status) status.textContent = '二维码过期，请刷新';
    clearInterval(qrCheckInterval);
    setTimeout(loadQRCode, 1000);
  } else if (res.code === 801) {
    if (status) status.textContent = '请使用APP扫码';
  } else if (res.code === 802) {
    if (status) status.textContent = '扫码成功，请确认';
  } else if (res.code === 803) {
    clearInterval(qrCheckInterval);
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    rememberPersonalPlatform('netease');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('登录成功');
  }
}

async function sendCaptcha() {
  const phoneInput = document.getElementById('captchaPhone');
  const btn = document.getElementById('sendCaptchaBtn');
  if (!phoneInput || !btn) return;

  const phone = phoneInput.value;
  if (!phone) return showToast('输入手机号', 'error');
  
  btn.disabled = true;
  
  const res = await api('/auth/captcha/send', {
    method: 'POST',
    body: JSON.stringify({ phone })
  }, 'AUTH_CAPTCHA_SEND');
  
  if (res.success) {
    showToast('验证码已发送');
    let countdown = 60;
    const interval = setInterval(() => {
      btn.textContent = countdown + 's';
      countdown--;
      if (countdown < 0) {
        clearInterval(interval);
        btn.textContent = '发送';
        btn.disabled = false;
      }
    }, 1000);
  } else {
    showActionError(res, '发送验证码失败');
    btn.disabled = false;
  }
}

async function loginWithCaptcha() {
  const phone = document.getElementById('captchaPhone').value;
  const captcha = document.getElementById('captchaCode').value;
  if (!phone || !captcha) return showToast('请填写完整', 'error');
  
  const res = await api('/auth/login/captcha', {
    method: 'POST',
    body: JSON.stringify({ phone, captcha })
  }, 'AUTH_LOGIN_CAPTCHA');
  
  if (res.success) {
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    rememberPersonalPlatform('netease');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('登录成功');
  } else {
    showActionError(res, '验证码登录失败');
  }
}

async function loginWithPassword() {
  const phone = document.getElementById('passwordPhone').value;
  const password = document.getElementById('passwordInput').value;
  if (!phone || !password) return showToast('请填写完整', 'error');
  
  const res = await api('/auth/login/password', {
    method: 'POST',
    body: JSON.stringify({ phone, password })
  }, 'AUTH_LOGIN_PASSWORD');
  
  if (res.success) {
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    rememberPersonalPlatform('netease');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('登录成功');
  } else {
    showActionError(res, '密码登录失败');
  }
}

async function loginWithCookie() {
  const cookie = document.getElementById('cookieInput').value;
  if (!cookie) return showToast('请输入Cookie', 'error');
  
  const res = await api('/auth/login/cookie', {
    method: 'POST',
    body: JSON.stringify({ cookie })
  }, 'AUTH_LOGIN_COOKIE');
  
  if (res.success) {
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    rememberPersonalPlatform('netease');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('登录成功');
  } else {
    showActionError(res, 'Cookie登录失败');
  }
}

async function loadQQQRCode() {
  const img = document.getElementById('qqQrCodeImg');
  const status = document.getElementById('qqQrStatus');
  if (!img || !status) return;

  img.src = '/placeholder.svg';
  status.textContent = '加载中...';

  const res = await qqApi('/auth/qrcode', {}, 'QQ_AUTH_QRCODE');
  if (!res.success) {
    status.textContent = toErrorDisplay(res, '获取QQ二维码失败，请重试');
    return;
  }

  qqQrKey = res.data.key;
  img.src = res.data.qrimg;
  status.textContent = '请使用QQ扫码';

  if (qqQrCheckInterval) clearInterval(qqQrCheckInterval);
  qqQrCheckInterval = setInterval(checkQQQRCode, 2000);
}

async function checkQQQRCode() {
  if (!qqQrKey) return;
  const res = await qqApi('/auth/qrcode/check?key=' + qqQrKey, {}, 'QQ_AUTH_QRCODE_CHECK');
  const status = document.getElementById('qqQrStatus');

  if (res.success === false) {
    const message = toErrorDisplay(res, res.code === 804
      ? '登录成功但会话初始化失败，请重试扫码'
      : '二维码已失效');
    if (status) status.textContent = message.includes('刷新') ? message : `${message}，正在刷新…`;
    clearInterval(qqQrCheckInterval);
    setTimeout(loadQQQRCode, 1000);
  } else if (res.code === 800) {
    if (status) status.textContent = '二维码过期，请刷新';
    clearInterval(qqQrCheckInterval);
    setTimeout(loadQQQRCode, 1000);
  } else if (res.code === 801) {
    if (status) status.textContent = '请使用QQ扫码';
  } else if (res.code === 802) {
    if (status) status.textContent = '扫码成功，请确认';
  } else if (res.code === 804) {
    const message = toErrorDisplay(res, '登录成功但会话初始化失败，请重试扫码');
    if (status) status.textContent = `${message}，正在刷新…`;
    clearInterval(qqQrCheckInterval);
    setTimeout(loadQQQRCode, 1000);
  } else if (res.code === 803) {
    clearInterval(qqQrCheckInterval);
    qqToken = res.data.token;
    qqCurrentUser = res.data.user;
    localStorage.setItem('qqToken', qqToken);
    rememberPersonalPlatform('qq');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('QQ音乐登录成功');
    navigate('/user');
  } else {
    console.warn('QQ扫码未知状态:', res);
  }
}

async function checkQQLoginStatus() {
  const res = await qqApi('/auth/status', {}, 'QQ_AUTH_STATUS');
  if (res.success && res.data.logged) {
    qqCurrentUser = res.data.user;
    updateUserUI();
    refreshPersonalCenterIfActive();
  } else if (res.success && !res.data.logged) {
    logoutQQ(false);
  } else if (res && res._errorMeta && res._errorMeta.status === 401) {
    logoutQQ(false);
  }
}

function logoutQQ(notify = true) {
  if (qqToken) {
    qqApi('/auth/logout', { method: 'POST' }, 'QQ_AUTH_LOGOUT');
  }
  qqToken = '';
  qqCurrentUser = null;
  qqUserPlaylists = [];
  qqUserFavorites = [];
  qqUserHistory = [];
  qqPlaylistTotal = 0;
  qqFavoriteTotal = 0;
  qqHistoryTotal = 0;
  qqPlaylistPage = 1;
  qqFavoritePage = 1;
  qqHistoryPage = 1;
  localStorage.removeItem('qqToken');
  updateUserUI();
  refreshPersonalCenterIfActive();
  if (notify) showToast('已退出QQ音乐登录');
}

async function generatePlaylist() {
  if (currentPlatform === 'qq') {
    if (!qqToken) return showToast('请先登录QQ音乐', 'error');
  } else {
    if (!token) return showToast('请先登录网易云', 'error');
  }

  const input = document.getElementById('playlistInput').value.trim();
  if (!input) return showToast('请输入链接', 'error');

  const btn = document.getElementById('generateBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="loading"></span>';
  btn.disabled = true;

  try {
    const isQQ = currentPlatform === 'qq';
    const callApi = isQQ ? qqApi : api;
    const parseScope = isQQ ? 'QQ_PLAYLIST_PARSE' : 'PLAYLIST_PARSE';
    const urlScope = isQQ ? 'QQ_PLAYLIST_URL' : 'PLAYLIST_URL';
    const parseRes = await callApi('/playlist/parse?url=' + encodeURIComponent(input), {}, parseScope);
    if (!parseRes.success) {
      showActionError(parseRes, '解析歌单失败');
      return;
    }

    currentPlaylist = parseRes.data;
    currentPlaylist._platform = currentPlatform;

    const urlRes = await callApi('/playlist/url?id=' + currentPlaylist.id, {}, urlScope);
    if (!urlRes.success) {
      showActionError(urlRes, '生成链接失败');
      return;
    }
    
    document.getElementById('playlistCover').src = imageSrc(currentPlaylist.cover);
    document.getElementById('playlistName').textContent = currentPlaylist.name;
    document.getElementById('playlistMeta').textContent = `共 ${currentPlaylist.songCount} 首`;
    lastGeneratedUrls = (urlRes.data && Array.isArray(urlRes.data.urls)) ? urlRes.data.urls : [];
    if (!lastGeneratedUrls.length && urlRes.data && urlRes.data.url) {
      lastGeneratedUrls = [{ type: 'hls', label: 'HLS', url: String(urlRes.data.url) }];
    }
    selectedGeneratedUrlType = (urlRes.data && urlRes.data.default) ? String(urlRes.data.default) : (lastGeneratedUrls[0]?.type || 'hls');
    lastGeneratedUrl = getSelectedGeneratedUrl();
    renderGeneratedUrlOptions();
    document.getElementById('resultSection').classList.add('show');
    
    updateFavoriteBtn();
    
  } catch (e) {
    showActionError(normalizeRuntimeError('PLAYLIST_GENERATE', e, '/ui/generatePlaylist'), '获取歌单失败');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

function copyUrl() {
  const url = getSelectedGeneratedUrl();
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    showToast('复制成功');
  });
}

function renderPagination(containerId, total, page, pageSize, callbackName) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  
  let html = '';
  
  html += `<button class="page-btn" onclick="${callbackName}(${page - 1})" ${page === 1 ? 'disabled' : ''}>&lt;</button>`;
  
  const range = 2;
  
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - range && i <= page + range)) {
      html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="${callbackName}(${i})">${i}</button>`;
    } else if (i === page - range - 1 || i === page + range + 1) {
      html += `<span class="page-ellipsis">...</span>`;
    }
  }
  
  html += `<button class="page-btn" onclick="${callbackName}(${page + 1})" ${page === totalPages ? 'disabled' : ''}>&gt;</button>`;
  
  container.innerHTML = html;
}

async function loadUserPlaylists(page = 1) {
  if (isLoadingPlaylists) return;
  const list = document.getElementById('playlistsList');
  if (!list) return;

  isLoadingPlaylists = true;
  playlistPage = page;
  
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  document.getElementById('playlistsPagination').innerHTML = '';
  
  const offset = (page - 1) * PAGE_SIZE;
  const res = await api(`/playlist/user?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'PLAYLIST_USER');
  isLoadingPlaylists = false;
  
  if (!res.success) {
    renderInlineError(list, res, '获取歌单失败');
    return;
  }
  
  userPlaylists = res.data;
  playlistTotal = res.total;
  
  renderPlaylists();
  renderPagination('playlistsPagination', playlistTotal, playlistPage, PAGE_SIZE, 'loadUserPlaylists');
}

function renderPlaylists() {
  const list = document.getElementById('playlistsList');
  if (!list) return;
  
  if (userPlaylists.length === 0) {
    list.innerHTML = '<div class="empty">暂无歌单</div>';
    return;
  }
  
  const items = userPlaylists.map(p => {
    const safeCover = imageSrc(p.cover);
    const safeName = escapeHtml(p.name);
    const safeId = escapeHtml(String(p.id));
    const count = p.trackCount;
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta">${count}首 • ID: ${safeId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safeId}')">生成</button>
        </div>
      </div>
    `;
  }).join('');
  
  list.innerHTML = items;
}

async function loadQQUserPlaylists(page = 1) {
  if (!qqToken || qqCenterTab !== 'playlists') return;
  if (isLoadingQQPlaylists) return;

  const list = document.getElementById('qqPlaylistsList');
  if (!list) return;

  isLoadingQQPlaylists = true;
  qqPlaylistPage = page;
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  const pagination = document.getElementById('qqPlaylistsPagination');
  if (pagination) pagination.innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await qqApi(`/playlist/user?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'QQ_PLAYLIST_USER');
  isLoadingQQPlaylists = false;

  if (!res.success) {
    renderInlineError(list, res, '获取QQ歌单失败');
    return;
  }

  qqUserPlaylists = Array.isArray(res.data) ? res.data : [];
  qqPlaylistTotal = Number.isFinite(res.total) ? res.total : qqUserPlaylists.length;

  renderQQPlaylists();
  renderPagination('qqPlaylistsPagination', qqPlaylistTotal, qqPlaylistPage, PAGE_SIZE, 'loadQQUserPlaylists');
}

function renderQQPlaylists() {
  const list = document.getElementById('qqPlaylistsList');
  if (!list) return;

  if (!Array.isArray(qqUserPlaylists) || qqUserPlaylists.length === 0) {
    list.innerHTML = '<div class="empty">暂无QQ音乐歌单</div>';
    return;
  }

  const items = qqUserPlaylists.map(p => {
    const safeCover = imageSrc(p.cover);
    const safeName = escapeHtml(p.name);
    const safeId = escapeHtml(String(p.id));
    const count = p.trackCount || p.songCount || 0;
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta"><span class="platform-badge-sm qq">QQ</span> ${count}首 · ID: ${safeId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safeId}', 'qq')">生成</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function loadQQFavorites(page = 1) {
  if (!qqToken || qqCenterTab !== 'favorites') return;
  if (isLoadingQQFavorites) return;

  const list = document.getElementById('qqFavoritesList');
  if (!list) return;

  isLoadingQQFavorites = true;
  qqFavoritePage = page;
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  const pagination = document.getElementById('qqFavoritesPagination');
  if (pagination) pagination.innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await qqApi(`/favorites?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'QQ_FAVORITES_LIST');
  isLoadingQQFavorites = false;

  if (!res.success) {
    renderInlineError(list, res, '获取QQ收藏失败');
    return;
  }

  qqUserFavorites = Array.isArray(res.data) ? res.data : [];
  qqFavoriteTotal = Number.isFinite(res.total) ? res.total : qqUserFavorites.length;

  renderQQFavorites();
  renderPagination('qqFavoritesPagination', qqFavoriteTotal, qqFavoritePage, PAGE_SIZE, 'loadQQFavorites');
}

function renderQQFavorites() {
  const list = document.getElementById('qqFavoritesList');
  if (!list) return;

  if (!Array.isArray(qqUserFavorites) || qqUserFavorites.length === 0) {
    list.innerHTML = '<div class="empty">暂无QQ收藏</div>';
    return;
  }

  const items = qqUserFavorites.map((f) => {
    const safeCover = imageSrc(f.cover);
    const safeName = escapeHtml(f.nickname || f.name || '');
    const safePlaylistId = escapeHtml(String(f.playlistId || ''));
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta"><span class="platform-badge-sm qq">QQ</span> ID: ${safePlaylistId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safePlaylistId}', 'qq')">播放</button>
          <button class="btn btn-ghost" style="padding: 0.4rem;" onclick="removeFavorite('${safePlaylistId}', false, 'qq')">删除</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function loadQQHistory(page = 1) {
  if (!qqToken || qqCenterTab !== 'history') return;
  if (isLoadingQQHistory) return;

  const list = document.getElementById('qqHistoryList');
  if (!list) return;

  isLoadingQQHistory = true;
  qqHistoryPage = page;
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  const pagination = document.getElementById('qqHistoryPagination');
  if (pagination) pagination.innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await qqApi(`/history/recent?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'QQ_HISTORY_RECENT');
  isLoadingQQHistory = false;

  if (!res.success) {
    renderInlineError(list, res, '获取QQ最近播放失败');
    return;
  }

  qqUserHistory = Array.isArray(res.data) ? res.data : [];
  qqHistoryTotal = Number.isFinite(res.total) ? res.total : qqUserHistory.length;

  renderQQHistory();
  renderPagination('qqHistoryPagination', qqHistoryTotal, qqHistoryPage, PAGE_SIZE, 'loadQQHistory');
}

function renderQQHistory() {
  const list = document.getElementById('qqHistoryList');
  if (!list) return;

  if (!Array.isArray(qqUserHistory) || qqUserHistory.length === 0) {
    list.innerHTML = '<div class="empty">暂无QQ最近播放歌单</div>';
    return;
  }

  const items = qqUserHistory.map((h) => {
    const safeCover = imageSrc(h.cover);
    const safeName = escapeHtml(h.name || '');
    const safePlaylistId = escapeHtml(String(h.playlistId || ''));
    const playedAtText = h.playedAt ? formatTime(h.playedAt) : '刚刚';
    const playCount = Number(h.playCount || 0);
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta"><span class="platform-badge-sm qq">QQ</span> 最近播放 ${playedAtText} • 播放 ${playCount} 次 • ID: ${safePlaylistId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safePlaylistId}', 'qq')">获取链接</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function loadFavorites(page = 1) {
  if (isLoadingFavorites) return;
  const list = document.getElementById('favoritesList');
  if (!list) return;

  isLoadingFavorites = true;
  favoritePage = page;
  
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  document.getElementById('favoritesPagination').innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await api(`/favorites?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'FAVORITES_LIST');
  isLoadingFavorites = false;
  
  if (!res.success) {
    renderInlineError(list, res, '获取收藏失败');
    return;
  }
  
  userFavorites = res.data;
  favoriteTotal = res.total;
  
  renderFavorites();
  renderPagination('favoritesPagination', favoriteTotal, favoritePage, PAGE_SIZE, 'loadFavorites');
}

function renderFavorites() {
  const list = document.getElementById('favoritesList');
  if (!list) return;
  
  if (userFavorites.length === 0) {
    list.innerHTML = '<div class="empty">暂无收藏</div>';
    return;
  }
  
  const items = userFavorites.map(f => {
    const safeCover = imageSrc(f.cover);
    const safeName = escapeHtml(f.nickname || f.name);
    const safePlaylistId = escapeHtml(f.playlistId);
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta">ID: ${safePlaylistId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safePlaylistId}')">播放</button>
          <button class="btn btn-ghost" style="padding: 0.4rem;" onclick="removeFavorite('${safePlaylistId}')">删除</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function loadHistory(page = 1) {
  if (isLoadingHistory) return;
  const list = document.getElementById('historyList');
  if (!list) return;

  isLoadingHistory = true;
  historyPage = page;
  
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  document.getElementById('historyPagination').innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await api(`/history/recent?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'HISTORY_RECENT');
  isLoadingHistory = false;
  
  if (!res.success) {
    renderInlineError(list, res, '获取最近播放失败');
    return;
  }
  
  userHistory = res.data;
  historyTotal = res.total;
  
  renderHistory();
  renderPagination('historyPagination', historyTotal, historyPage, PAGE_SIZE, 'loadHistory');
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (!list) return;
  
  if (userHistory.length === 0) {
    list.innerHTML = '<div class="empty">暂无最近播放歌单</div>';
    return;
  }
  
  const items = userHistory.map(h => {
    const safeCover = imageSrc(h.cover);
    const safeName = escapeHtml(h.name || '');
    const safePlaylistId = escapeHtml(String(h.playlistId || ''));
    const playedAtText = h.playedAt ? formatTime(h.playedAt) : '刚刚';
    const playCount = Number(h.playCount || 0);
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta">最近播放 ${playedAtText} • 播放 ${playCount} 次 • ID: ${safePlaylistId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safePlaylistId}')">获取链接</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function updateFavoriteBtn() {
  if (!currentPlaylist) return;
  const btn = document.getElementById('favoriteBtn');
  if (!btn) return;

  const platform = currentPlaylist._platform === 'qq' ? 'qq' : 'netease';
  const callApi = platform === 'qq' ? qqApi : api;
  const scope = platform === 'qq' ? 'QQ_FAVORITES_CHECK' : 'FAVORITES_CHECK';
  const res = await callApi('/favorites/check/' + currentPlaylist.id, {}, scope);

  if (res.success && res.data.favorited) {
    btn.innerHTML = '已收藏';
    btn.className = 'btn btn-primary';
    btn.onclick = () => removeFavorite(currentPlaylist.id, true, platform);
  } else {
    btn.innerHTML = '收藏';
    btn.className = 'btn btn-ghost';
    btn.onclick = () => addFavorite();
  }
}

async function addFavorite() {
  if (!currentPlaylist) return;
  const platform = currentPlaylist._platform === 'qq' ? 'qq' : 'netease';
  const callApi = platform === 'qq' ? qqApi : api;
  const scope = platform === 'qq' ? 'QQ_FAVORITES_ADD' : 'FAVORITES_ADD';
  const res = await callApi('/favorites', {
    method: 'POST',
    body: JSON.stringify({
      playlistId: currentPlaylist.id,
      playlistName: currentPlaylist.name,
      playlistCover: currentPlaylist.cover
    })
  }, scope);
  if (res.success) {
    showToast('收藏成功');
    updateFavoriteBtn();
    if (platform === 'qq') {
      if (document.getElementById('qqFavoritesList')) loadQQFavorites(1);
    } else if (document.getElementById('favoritesList')) {
      loadFavorites(1);
    }
  } else {
    showActionError(res, '收藏失败');
  }
}

async function removeFavorite(playlistId, updateBtn = false, platform = '') {
  const targetPlatform = platform || 'netease';
  const callApi = targetPlatform === 'qq' ? qqApi : api;
  const scope = targetPlatform === 'qq' ? 'QQ_FAVORITES_REMOVE' : 'FAVORITES_REMOVE';
  const res = await callApi('/favorites/' + playlistId, { method: 'DELETE' }, scope);
  if (res.success) {
    showToast('已取消收藏');
    if (targetPlatform === 'qq') {
      if (document.getElementById('qqFavoritesList')) loadQQFavorites(qqFavoritePage);
    } else if (document.getElementById('favoritesList')) {
      loadFavorites(favoritePage);
    }
    if (updateBtn) updateFavoriteBtn();
  } else {
    showActionError(res, '取消收藏失败');
  }
}

async function playFavorite(playlistId, platform) {
  const id = encodeURIComponent(String(playlistId || ''));
  const p = platform || 'netease';

  if (isUserViewActive()) {
    navigate(`/?play=${id}&platform=${p}`);
    return;
  }

  if (p !== currentPlatform) switchPlatform(p);

  const input = document.getElementById('playlistInput');
  if (!input) {
    navigate(`/?play=${id}&platform=${p}`);
    return;
  }

  input.value = String(playlistId || '');
  await generatePlaylist();
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return Math.floor(diff / 86400000) + '天前';
}

function renderAccountCards() {
  const nBody = document.getElementById('neteaseAccountBody');
  const qBody = document.getElementById('qqAccountBody');

  if (nBody) {
    if (currentUser) {
      const av = imageSrc(currentUser.avatar);
      const name = escapeHtml(currentUser.nickname);
      nBody.innerHTML = `
        <img class="user-avatar" src="${av}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <span class="account-name">${name}</span>
        <button class="btn btn-ghost" style="padding:0.3rem 0.6rem;font-size:0.8rem;" onclick="logout()">退出</button>
      `;
    } else {
      nBody.innerHTML = `<button class="btn btn-primary" style="padding:0.4rem 0.8rem;font-size:0.85rem;" onclick="showLogin('netease')">登录</button>`;
    }
  }

  if (qBody) {
    if (qqCurrentUser) {
      const av = imageSrc(qqCurrentUser.avatar);
      const name = escapeHtml(qqCurrentUser.nickname);
      qBody.innerHTML = `
        <img class="user-avatar" src="${av}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <span class="account-name">${name}</span>
        <button class="btn btn-ghost" style="padding:0.3rem 0.6rem;font-size:0.8rem;" onclick="logoutQQ()">退出</button>
      `;
    } else {
      qBody.innerHTML = `<button class="btn btn-primary" style="padding:0.4rem 0.8rem;font-size:0.85rem;" onclick="showLogin('qq')">登录</button>`;
    }
  }
}

async function loadAllPlaylists(page = 1) {
  const list = document.getElementById('playlistsList');
  if (!list) return;

  if ((userPlaylists.length > 0 || qqUserPlaylists.length > 0) && page !== 0) {
    playlistPage = page;
    renderAllPlaylists();
    return;
  }

  if (isLoadingPlaylists) return;
  isLoadingPlaylists = true;

  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  document.getElementById('playlistsPagination').innerHTML = '';

  const promises = [];
  if (token) promises.push(loadUserPlaylistsData());
  if (qqToken) promises.push(loadQQUserPlaylistsData());

  const results = await Promise.all(promises);
  isLoadingPlaylists = false;

  const failed = results.filter(item => item && item.success === false).map(item => item.error);
  if (results.length > 0 && failed.length === results.length) {
    renderInlineError(list, failed[0], '获取歌单失败');
    return;
  }

  playlistPage = page === 0 ? 1 : page;
  renderAllPlaylists();
}

async function loadUserPlaylistsData() {
  const res = await api('/playlist/user?offset=0&limit=100', {}, 'PLAYLIST_USER');
  if (res.success) {
    userPlaylists = (res.data || []).map(p => ({ ...p, _platform: 'netease' }));
    return { success: true };
  }
  return { success: false, error: res };
}

async function loadQQUserPlaylistsData() {
  const res = await qqApi('/playlist/user?offset=0&limit=100', {}, 'QQ_PLAYLIST_USER');
  if (res.success) {
    qqUserPlaylists = (res.data || []).map(p => ({ ...p, _platform: 'qq' }));
    return { success: true };
  }
  return { success: false, error: res };
}

function renderAllPlaylists() {
  const list = document.getElementById('playlistsList');
  if (!list) return;

  const all = [...userPlaylists, ...qqUserPlaylists];
  playlistTotal = all.length;

  if (all.length === 0) {
    list.innerHTML = '<div class="empty">暂无歌单</div>';
    document.getElementById('playlistsPagination').innerHTML = '';
    return;
  }

  const offset = (playlistPage - 1) * PAGE_SIZE;
  const pageData = all.slice(offset, offset + PAGE_SIZE);

  const items = pageData.map(p => {
    const safeCover = imageSrc(p.cover);
    const safeName = escapeHtml(p.name);
    const safeId = escapeHtml(String(p.id));
    const count = p.trackCount || p.songCount || 0;
    const isQQ = p._platform === 'qq';
    const badge = isQQ
      ? '<span class="platform-badge-sm qq">QQ</span>'
      : '<span class="platform-badge-sm netease">网易云</span>';
    const platform = isQQ ? "'qq'" : "'netease'";
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta">${badge} ${count}首 · ID: ${safeId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safeId}', ${platform})">生成</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
  renderPagination('playlistsPagination', playlistTotal, playlistPage, PAGE_SIZE, 'loadAllPlaylists');
}
