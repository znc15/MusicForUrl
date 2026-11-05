import policy from '../../lib/player-policy.js';
import { sha256Hex } from './security.js';
import { degradeMode, secondsUntilUtcMidnight } from './degrade.js';

const CONTROL_LIMIT = 30;
const REFRESH_WINDOW_MS = 10000;

function clientIp(request) {
  return request?.headers.get('cf-connecting-ip') || 'local';
}

function retryAfter(windowMs = 60000, now = Date.now()) {
  return Math.max(1, Math.ceil((windowMs - now % windowMs) / 1000));
}

// bucket 始终使用分钟，保持与现有 Cron 清理口径一致。
// 冲突更新封顶：超限后的请求只读取冲突行，不再产生行更新。
async function rateLimited(env, request, scope, maxHits, {
  identity = clientIp(request), windowMs = 60000, now = Date.now(),
} = {}) {
  const key = await sha256Hex(`${scope}:${identity}:${Math.floor(now / windowMs)}`);
  const bucket = Math.floor(now / 60000);
  const result = await env.DB.prepare(`
    INSERT INTO rate_limits (scope, key_hash, bucket, hits) VALUES (?, ?, ?, 1)
    ON CONFLICT (scope, key_hash, bucket) DO UPDATE SET hits = hits + 1
    WHERE rate_limits.hits < ?
    RETURNING hits
  `).bind(scope, key, bucket, maxHits).first();
  return !result;
}

function requestError(message, status, code, seconds) {
  const error = new policy.PlayerError(message, status, code);
  error.retryAfter = seconds;
  return error;
}

async function admitControl(env, request, platform, hasGrant = false) {
  if (!hasGrant && degradeMode(env) === 'shed') {
    throw requestError('今日额度已用完，请在 00:00 UTC 后重试', 503,
      'service_busy', secondsUntilUtcMidnight());
  }
  if (await rateLimited(env, request, `${platform}:parse`, CONTROL_LIMIT)) {
    throw requestError('解析请求过于频繁，请稍后重试', 429, 'rate_limited', retryAfter());
  }
}

async function admitRefresh(env, request, user, sourceKey) {
  const identity = `${user.guest ? `ip:${clientIp(request)}` : `user:${user.id}`}:${sourceKey}`;
  if (await rateLimited(env, request, `${user.platform}:refresh`, 1,
    { identity, windowMs: REFRESH_WINDOW_MS })) {
    throw requestError('音源刚刚刷新，请稍后重试', 429, 'rate_limited', retryAfter(REFRESH_WINDOW_MS));
  }
}

export { admitControl, admitRefresh, rateLimited, retryAfter };
