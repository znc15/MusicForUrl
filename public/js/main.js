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

const SPA_VIEW_CONTAINER_ID = 'appView';
const SPA_VIEW_CACHE = new Map();
let lastAutoPlayId = null;
let lastGeneratedUrl = '';

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
  return '网易云 → VRChat';
}

function isUserViewActive() {
  return resolveViewFromPath(window.location.pathname) === 'user';
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

  const res = await fetch(`/views/${view}.html`, { cache: 'no-cache' });
  if (!res.ok) throw new Error('加载页面失败');
  const html = await res.text();
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
    console.error(e);
    container.innerHTML = `<div class="empty">页面加载失败，请刷新重试</div>`;
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
    const url = document.getElementById('playlistUrl');

    if (cover) cover.src = imageSrc(currentPlaylist.cover);
    if (name) name.textContent = currentPlaylist.name || '';
    if (meta) meta.textContent = `共 ${currentPlaylist.songCount} 首`;
    if (url) url.textContent = lastGeneratedUrl;
    result.classList.add('show');
    updateFavoriteBtn();
  }
}

async function maybeAutoplayFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const playId = urlParams.get('play');
  if (!playId) return;
  if (playId === lastAutoPlayId) return;
  lastAutoPlayId = playId;

  const input = document.getElementById('playlistInput');
  if (!input) return;
  input.value = playId;
  await generatePlaylist();
}

function onViewMounted(view) {
  if (view === 'home') {
    maybeRestoreHomeState();
    maybeAutoplayFromUrl();
    return;
  }

  if (view === 'user') {
    if (!token) {
      showToast('请先登录', 'error');
      showLogin();
      navigate('/', { replace: true });
      return;
    }

    if (typeof switchPersonalTab === 'function') {
      switchPersonalTab('playlists');
    }
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
      }
    } catch (e) {
      console.error('Failed to load header', e);
    }
  }

  if (footerPlaceholder) {
    try {
      const res = await fetch('/includes/footer.html');
      if (res.ok) {
        footerPlaceholder.outerHTML = await res.text();
      }
    } catch (e) {
      console.error('Failed to load footer', e);
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
  if (message !== '复制成功' && message !== '链接已复制') return;
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast ' + type + ' show';
  setTimeout(() => toast.classList.remove('show'), 3000);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  
  const res = await fetch('/api' + path, {
    ...options,
    headers: { ...headers, ...options.headers }
  });
  return res.json();
}

async function checkLoginStatus() {
  const res = await api('/auth/status');
  if (res.success && res.data.logged) {
    currentUser = res.data.user;
    updateUserUI();
  } else {
    logout(false);
  }
}

function updateUserUI() {
  const area = document.getElementById('userArea');
  if (!area) return;

  if (currentUser) {
    const vipBadge = currentUser.vipType > 0 
      ? `<span class="vip-badge">${currentUser.vipType === 11 ? '黑胶' : 'VIP'}</span>` 
      : '';
    const safeAvatar = imageSrc(currentUser.avatar);
    const safeNickname = escapeHtml(currentUser.nickname);
    area.innerHTML = `
      <div class="user-info" onclick="navigate('/user')" title="进入个人中心">
        <img class="user-avatar" src="${safeAvatar}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <span class="user-name">${safeNickname}</span>
        ${vipBadge}
      </div>
    `;
  } else {
    area.innerHTML = `<button class="btn btn-primary" onclick="showLogin()">登录</button>`;
    if (isUserViewActive()) navigate('/', { replace: true });
  }
}

function logout(notify = true) {
  if (token) {
    api('/auth/logout', { method: 'POST' });
  }
  token = '';
  currentUser = null;
  userPlaylists = [];
  localStorage.removeItem('token');
  updateUserUI();
  if (notify) showToast('已退出登录');
}

function showLogin() {
  const modal = document.getElementById('loginModal');
  if (modal) {
    modal.classList.add('show');
    switchLoginTab('qrcode');
  }
}

function hideLogin() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.remove('show');
  if (qrCheckInterval) {
    clearInterval(qrCheckInterval);
    qrCheckInterval = null;
  }
}

function switchLoginTab(tab) {
  document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.login-content').forEach(c => c.classList.remove('active'));
  
  const tabs = ['qrcode', 'captcha', 'password', 'cookie'];
  const index = tabs.indexOf(tab);
  
  const tabBtns = document.querySelectorAll('.login-tab');
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
  
  const res = await api('/auth/qrcode');
  if (!res.success) {
    status.textContent = '获取失败，请重试';
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
  const res = await api('/auth/qrcode/check?key=' + qrKey);
  const status = document.getElementById('qrStatus');
  
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
    hideLogin();
    updateUserUI();
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
  });
  
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
    showToast(res.message || '发送失败', 'error');
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
  });
  
  if (res.success) {
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    hideLogin();
    updateUserUI();
    showToast('登录成功');
  } else {
    showToast(res.message || '登录失败', 'error');
  }
}

async function loginWithPassword() {
  const phone = document.getElementById('passwordPhone').value;
  const password = document.getElementById('passwordInput').value;
  if (!phone || !password) return showToast('请填写完整', 'error');
  
  const res = await api('/auth/login/password', {
    method: 'POST',
    body: JSON.stringify({ phone, password })
  });
  
  if (res.success) {
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    hideLogin();
    updateUserUI();
    showToast('登录成功');
  } else {
    showToast(res.message || '登录失败', 'error');
  }
}

async function loginWithCookie() {
  const cookie = document.getElementById('cookieInput').value;
  if (!cookie) return showToast('请输入Cookie', 'error');
  
  const res = await api('/auth/login/cookie', {
    method: 'POST',
    body: JSON.stringify({ cookie })
  });
  
  if (res.success) {
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    hideLogin();
    updateUserUI();
    showToast('登录成功');
  } else {
    showToast(res.message || 'Cookie无效', 'error');
  }
}

async function generatePlaylist() {
  if (!token) return showToast('请先登录', 'error');
  
  const input = document.getElementById('playlistInput').value.trim();
  if (!input) return showToast('请输入链接', 'error');
  
  const btn = document.getElementById('generateBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="loading"></span>';
  btn.disabled = true;
  
  try {
    const parseRes = await api('/playlist/parse?url=' + encodeURIComponent(input));
    if (!parseRes.success) throw new Error(parseRes.message);
    
    currentPlaylist = parseRes.data;
    
    const urlRes = await api('/playlist/url?id=' + currentPlaylist.id);
    if (!urlRes.success) throw new Error(urlRes.message);
    
    document.getElementById('playlistCover').src = imageSrc(currentPlaylist.cover);
    document.getElementById('playlistName').textContent = currentPlaylist.name;
    document.getElementById('playlistMeta').textContent = `共 ${currentPlaylist.songCount} 首`;
    lastGeneratedUrl = (urlRes.data && urlRes.data.url) ? String(urlRes.data.url) : '';
    document.getElementById('playlistUrl').textContent = lastGeneratedUrl;
    document.getElementById('resultSection').classList.add('show');
    
    updateFavoriteBtn();
    
  } catch (e) {
    showToast(e.message || '获取失败', 'error');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

function copyUrl() {
  const url = document.getElementById('playlistUrl').textContent;
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
  const res = await api(`/playlist/user?offset=${offset}&limit=${PAGE_SIZE}`);
  isLoadingPlaylists = false;
  
  if (!res.success) {
    list.innerHTML = '<div class="empty">获取失败</div>';
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

async function loadFavorites(page = 1) {
  if (isLoadingFavorites) return;
  const list = document.getElementById('favoritesList');
  if (!list) return;

  isLoadingFavorites = true;
  favoritePage = page;
  
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  document.getElementById('favoritesPagination').innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await api(`/favorites?offset=${offset}&limit=${PAGE_SIZE}`);
  isLoadingFavorites = false;
  
  if (!res.success) {
    list.innerHTML = '<div class="empty">获取失败</div>';
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
  const res = await api(`/history/recent?offset=${offset}&limit=${PAGE_SIZE}`);
  isLoadingHistory = false;
  
  if (!res.success) {
    list.innerHTML = '<div class="empty">获取失败</div>';
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
    list.innerHTML = '<div class="empty">暂无记录</div>';
    return;
  }
  
  const items = userHistory.map(h => {
    const safeSongName = escapeHtml(h.songName);
    const safeArtist = escapeHtml(h.artist);
    return `
      <div class="list-item">
        <div class="item-info">
          <div class="item-name">${safeSongName}</div>
          <div class="item-meta">${safeArtist} • ${formatTime(h.playedAt)}</div>
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
  
  const res = await api('/favorites/check/' + currentPlaylist.id);
  
  if (res.success && res.data.favorited) {
    btn.innerHTML = '已收藏';
    btn.className = 'btn btn-primary';
    btn.onclick = () => removeFavorite(currentPlaylist.id, true);
  } else {
    btn.innerHTML = '收藏';
    btn.className = 'btn btn-ghost';
    btn.onclick = () => addFavorite();
  }
}

async function addFavorite() {
  if (!currentPlaylist) return;
  const res = await api('/favorites', {
    method: 'POST',
    body: JSON.stringify({
      playlistId: currentPlaylist.id,
      playlistName: currentPlaylist.name,
      playlistCover: currentPlaylist.cover
    })
  });
  if (res.success) {
    showToast('收藏成功');
    updateFavoriteBtn();
    if (document.getElementById('favoritesList')) loadFavorites(1);
  } else {
    showToast(res.message || '收藏失败', 'error');
  }
}

async function removeFavorite(playlistId, updateBtn = false) {
  const res = await api('/favorites/' + playlistId, { method: 'DELETE' });
  if (res.success) {
    showToast('已取消收藏');
    if (document.getElementById('favoritesList')) loadFavorites(favoritePage);
    if (updateBtn) updateFavoriteBtn();
  }
}

async function playFavorite(playlistId) {
  const id = encodeURIComponent(String(playlistId || ''));

  if (isUserViewActive()) {
    navigate(`/?play=${id}`);
    return;
  }

  const input = document.getElementById('playlistInput');
  if (!input) {
    navigate(`/?play=${id}`);
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
