(function initThemeFromStorage() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

const MFU_ERROR = (typeof window !== 'undefined' && window.MfuError) ? window.MfuError : null;

function normalizePasswordError(scope, error, requestPath) {
  if (error && typeof error === 'object' && error.success === false && error.errorCode) {
    return error;
  }

  if (MFU_ERROR && typeof MFU_ERROR.normalizeCaughtError === 'function') {
    return MFU_ERROR.normalizeCaughtError({ scope, error, requestPath });
  }

  return {
    success: false,
    message: (error && error.message) ? String(error.message) : '请求失败，请稍后重试',
    errorCode: `E-FE-${String(scope || 'UNKNOWN').toUpperCase()}-UNKNOWN`,
    _errorMeta: {
      kind: 'FE',
      scope: String(scope || 'UNKNOWN').toUpperCase(),
      status: null,
      requestPath: requestPath || '',
      rawMessage: (error && error.message) ? String(error.message) : ''
    }
  };
}

function toPasswordDisplayMessage(errorLike, fallback) {
  if (MFU_ERROR && typeof MFU_ERROR.toDisplayMessage === 'function') {
    return MFU_ERROR.toDisplayMessage(errorLike, fallback);
  }
  return String((errorLike && errorLike.message) || fallback || '请求失败，请稍后重试');
}

function logPasswordDebug(meta) {
  if (MFU_ERROR && typeof MFU_ERROR.logDebug === 'function') {
    MFU_ERROR.logDebug(meta);
    return;
  }
  console.error('[MFU_ERROR]', meta);
}

function showPasswordError(errorMessageEl, errorLike, fallback) {
  if (!errorMessageEl) return;
  errorMessageEl.textContent = toPasswordDisplayMessage(errorLike, fallback);
  errorMessageEl.classList.add('show');
}

async function submitPassword(password, currentPath) {
  let response;
  try {
    response = await fetch(currentPath, {
      headers: {
        'X-Site-Password': password
      }
    });
  } catch (error) {
    const normalized = normalizePasswordError('SITE_PASSWORD_VERIFY', error, currentPath);
    logPasswordDebug({
      channel: 'password',
      requestPath: currentPath,
      errorCode: normalized.errorCode,
      meta: normalized._errorMeta
    });
    return normalized;
  }

  if (response.ok) {
    return { success: true };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    const parseError = Object.assign(new Error(error && error.message ? error.message : 'response parse error'), {
      __mfuType: 'PARSE',
      __mfuStatus: response.status
    });
    const normalized = normalizePasswordError('SITE_PASSWORD_VERIFY', parseError, currentPath);
    logPasswordDebug({
      channel: 'password',
      requestPath: currentPath,
      errorCode: normalized.errorCode,
      meta: normalized._errorMeta
    });
    return normalized;
  }

  let normalized;
  if (MFU_ERROR && typeof MFU_ERROR.normalizeHttpError === 'function') {
    normalized = MFU_ERROR.normalizeHttpError({
      scope: 'SITE_PASSWORD_VERIFY',
      status: response.status,
      payload,
      requestPath: currentPath
    });
  } else {
    normalized = {
      success: false,
      message: '密码错误，请重试',
      errorCode: `E-HTTP-SITE_PASSWORD_VERIFY-${response.status}`,
      _errorMeta: {
        kind: 'HTTP',
        scope: 'SITE_PASSWORD_VERIFY',
        status: response.status,
        requestPath: currentPath,
        rawMessage: payload && payload.message ? payload.message : ''
      }
    };
  }

  if (response.status === 401) {
    normalized.message = '密码错误，请重试';
  }

  logPasswordDebug({
    channel: 'password',
    requestPath: currentPath,
    errorCode: normalized.errorCode,
    meta: normalized._errorMeta
  });
  return normalized;
}

function handleSubmit(e) {
  e.preventDefault();

  const passwordInput = document.getElementById('passwordInput');
  const errorMessage = document.getElementById('errorMessage');
  const password = passwordInput ? passwordInput.value : '';

  if (!password) {
    if (errorMessage) {
      errorMessage.textContent = '请输入密码';
      errorMessage.classList.add('show');
    }
    return false;
  }

  if (errorMessage) {
    errorMessage.classList.remove('show');
  }

  sessionStorage.setItem('sitePassword', password);
  const currentPath = window.location.pathname + window.location.search;

  submitPassword(password, currentPath)
    .then((result) => {
      if (result && result.success) {
        window.location.reload();
        return;
      }

      showPasswordError(errorMessage, result, '密码验证失败，请重试');
      if (passwordInput) {
        passwordInput.value = '';
        passwordInput.focus();
      }
    });

  return false;
}

(function attachSitePasswordHeader() {
  const savedPassword = sessionStorage.getItem('sitePassword');
  if (savedPassword) {
    const originalFetch = window.fetch;
    window.fetch = function patchedFetch(url, options = {}) {
      options.headers = options.headers || {};
      options.headers['X-Site-Password'] = savedPassword;
      return originalFetch(url, options);
    };
  }
})();
