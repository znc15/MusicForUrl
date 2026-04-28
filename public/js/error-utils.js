(function initErrorUtils(globalObj) {
  const STATUS_MESSAGES = {
    400: '请求参数不正确，请检查后重试',
    401: '登录状态已失效，请重新登录',
    403: '没有权限执行该操作',
    404: '请求资源不存在',
    429: '请求过于频繁，请稍后再试',
    500: '服务器内部错误，请稍后重试',
    502: '上游服务异常，请稍后重试',
    503: '服务暂时不可用，请稍后重试'
  };

  function normalizeToken(value, fallback) {
    const token = String(value == null ? '' : value)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return token || fallback;
  }

  function buildErrorCode(kind, scope, statusOrTag) {
    const normalizedKind = normalizeToken(kind, 'FE');
    const normalizedScope = normalizeToken(scope, 'UNKNOWN');
    const normalizedTag = normalizeToken(statusOrTag, 'UNKNOWN');
    return `E-${normalizedKind}-${normalizedScope}-${normalizedTag}`;
  }

  function pickMessage(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    if (typeof payload === 'object') {
      const message = payload.message || payload.error || payload.msg;
      if (typeof message === 'string') return message.trim();
    }
    return '';
  }

  function normalizeHttpError({ scope, status, payload, requestPath }) {
    const normalizedScope = normalizeToken(scope, 'UNKNOWN');
    const statusCode = Number(status) || 0;
    const isHttpError = statusCode >= 400;
    const kind = isHttpError ? 'HTTP' : 'BIZ';
    const tag = isHttpError ? String(statusCode) : 'RESP';
    const payloadMessage = pickMessage(payload);
    const defaultMessage = STATUS_MESSAGES[statusCode] || '请求失败，请稍后重试';
    const message = payloadMessage || defaultMessage;

    return {
      success: false,
      message,
      errorCode: buildErrorCode(kind, normalizedScope, tag),
      _errorMeta: {
        kind,
        scope: normalizedScope,
        status: statusCode || null,
        requestPath: requestPath || '',
        rawMessage: payloadMessage || ''
      }
    };
  }

  function normalizeCaughtError({ scope, error, requestPath }) {
    const normalizedScope = normalizeToken(scope, 'UNKNOWN');
    const err = error || {};
    const sourceType = err.__mfuType || '';
    const statusCode = Number(err.__mfuStatus) || null;
    const rawMessage = String(err.message || err || '');
    let kind = 'FE';
    let tag = 'UNKNOWN';
    let message = rawMessage || '请求失败，请稍后重试';

    if (sourceType === 'PARSE') {
      kind = 'PARSE';
      tag = 'RESP';
      message = '响应解析失败，请稍后重试';
    } else if (sourceType === 'UNHANDLED') {
      kind = 'FE';
      tag = 'UNHANDLED';
      message = '页面出现未处理异常，请刷新重试';
    } else if (sourceType === 'NET' || err instanceof TypeError) {
      kind = 'NET';
      tag = 'REQ';
      message = '网络连接失败，请检查网络后重试';
    } else if (err.name === 'SyntaxError') {
      kind = 'PARSE';
      tag = 'RESP';
      message = '响应解析失败，请稍后重试';
    }

    return {
      success: false,
      message,
      errorCode: buildErrorCode(kind, normalizedScope, tag),
      _errorMeta: {
        kind,
        scope: normalizedScope,
        status: statusCode,
        requestPath: requestPath || '',
        rawMessage
      }
    };
  }

  function toDisplayMessage(errorLike, fallbackMessage) {
    const fallback = String(fallbackMessage || '请求失败，请稍后重试');
    if (!errorLike || typeof errorLike !== 'object') return fallback;
    const message = String(errorLike.message || '').trim() || fallback;
    const code = String(errorLike.errorCode || '').trim();
    return code ? `${message} (${code})` : message;
  }

  function logDebug(meta) {
    if (meta == null) return;
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[MFU_ERROR]', meta);
    }
  }

  function installGlobalErrorHandlers({ onError, cooldownMs } = {}) {
    if (typeof globalObj.addEventListener !== 'function') {
      return () => {};
    }

    const showError = typeof onError === 'function' ? onError : function noop() {};
    const cooldown = Number(cooldownMs) > 0 ? Number(cooldownMs) : 5000;
    let lastKey = '';
    let lastTs = 0;

    function canNotify(code, message) {
      const now = Date.now();
      const key = `${code}|${message}`;
      if (key === lastKey && now - lastTs < cooldown) return false;
      lastKey = key;
      lastTs = now;
      return true;
    }

    function handleUnknown(error, requestPath) {
      const unknownError = (error && typeof error === 'object')
        ? error
        : new Error(String(error || 'Unknown error'));
      unknownError.__mfuType = 'UNHANDLED';
      const normalized = normalizeCaughtError({
        scope: 'UNKNOWN',
        error: unknownError,
        requestPath: requestPath || (globalObj.location && globalObj.location.pathname) || ''
      });
      logDebug({
        channel: 'global',
        errorCode: normalized.errorCode,
        meta: normalized._errorMeta
      });
      if (canNotify(normalized.errorCode, normalized.message)) {
        showError(normalized);
      }
    }

    function onWindowError(event) {
      handleUnknown(event && (event.error || event.message), globalObj.location && globalObj.location.pathname);
    }

    function onUnhandledRejection(event) {
      const reason = event && event.reason;
      handleUnknown(reason, globalObj.location && globalObj.location.pathname);
    }

    globalObj.addEventListener('error', onWindowError);
    globalObj.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      globalObj.removeEventListener('error', onWindowError);
      globalObj.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }

  const api = {
    buildErrorCode,
    normalizeHttpError,
    normalizeCaughtError,
    toDisplayMessage,
    logDebug,
    installGlobalErrorHandlers
  };

  globalObj.MfuError = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
