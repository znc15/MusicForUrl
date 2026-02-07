const express = require('express');
const router = express.Router();
const qqmusic = require('../lib/qqmusic');
const { encrypt, generateToken } = require('../lib/crypto');
const { qqUserOps } = require('../lib/db');

const qrCodeSessions = new Map();
const QR_SESSION_MAX = 500;
const QR_SESSION_TTL = 3 * 60 * 1000;

function tokenTtlHours() {
  const raw = parseInt(process.env.TOKEN_TTL_HOURS, 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 24 * 365);
  return 168;
}

function toSqliteDatetime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function computeTokenExpiresAt() {
  const hours = tokenTtlHours();
  const expires = new Date(Date.now() + hours * 60 * 60 * 1000);
  return toSqliteDatetime(expires);
}

function resolveQQAvatar(avatar, uin) {
  const raw = String(avatar || '').trim();
  if (!raw) return qqmusic.buildQQAvatarUrl(uin);

  const isLegacyThirdqq =
    /thirdqq\.qlogo\.cn\/g\?/i.test(raw) &&
    /(?:^|[?&])b=oidb(?:&|$)/i.test(raw);

  if (isLegacyThirdqq) return qqmusic.buildQQAvatarUrl(uin);
  return raw;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of qrCodeSessions.entries()) {
    if (now - value.created > QR_SESSION_TTL) {
      qrCodeSessions.delete(key);
    }
  }
}, 60 * 1000);

// ─── QR 码登录 ────────────────────────────────────────────

router.get('/qrcode', async (req, res) => {
  try {
    if (qrCodeSessions.size >= QR_SESSION_MAX) {
      return res.status(503).json({ success: false, message: '登录请求过多，请稍后重试' });
    }

    const { qrsig, qrimg } = await qqmusic.createQRCode();
    qrCodeSessions.set(qrsig, { created: Date.now() });

    setTimeout(() => qrCodeSessions.delete(qrsig), QR_SESSION_TTL);

    res.json({ success: true, data: { key: qrsig, qrimg } });
  } catch (e) {
    console.error('获取QQ音乐二维码失败:', e);
    res.status(500).json({ success: false, message: e.message || '获取二维码失败' });
  }
});

router.get('/qrcode/check', async (req, res) => {
  const { key } = req.query;

  if (!key || !qrCodeSessions.has(key)) {
    return res.json({ success: false, message: '二维码已过期，请刷新' });
  }

  try {
    const result = await qqmusic.checkQRCode(key);

    if (result.code === 0) {
      qrCodeSessions.delete(key);

      const cookie = String(result.cookie || '').trim();
      const resultUin = String(result.uin || '').trim();
      const cookieUin = qqmusic.extractUin(cookie);
      const fallbackUin = resultUin || cookieUin;

      if (!cookie || !fallbackUin) {
        return res.json({
          success: false,
          code: 804,
          message: '登录成功但会话初始化失败，请重试扫码'
        });
      }

      let status = { logged: false };
      try {
        status = await qqmusic.checkLoginStatus(cookie);
      } catch (e) {
        console.warn('[QQ登录] checkLoginStatus 失败，按宽松策略继续:', e.message);
      }
      const uin = status.userId || fallbackUin;

      if (!uin) {
        return res.json({
          success: false,
          code: 804,
          message: '登录成功但会话初始化失败，请重试扫码'
        });
      }

      const token = generateToken();
      const token_expires_at = computeTokenExpiresAt();
      const nickname = status.nickname || result.nickname || `QQ用户${uin}`;
      const avatar = resolveQQAvatar(status.avatar, uin);
      const vipType = Number(status.vipType) || 0;

      qqUserOps.upsert.run({
        qq_uin: String(uin),
        nickname,
        avatar,
        vip_type: vipType,
        cookie: encrypt(cookie),
        token,
        token_expires_at
      });

      return res.json({
        success: true,
        code: 803,
        message: '登录成功',
        data: {
          token,
          user: {
            nickname,
            avatar,
            vipType
          }
        }
      });
    }

    // 映射到和网易云一致的 code
    let code;
    if (result.code === 66) code = 801;        // 未扫码
    else if (result.code === 67) code = 802;   // 已扫码未确认
    else if (result.code === 65) code = 800;   // 已过期
    else code = result.code;

    res.json({
      success: true,
      code,
      message: result.message
    });
  } catch (e) {
    console.error('检查QQ音乐二维码状态失败:', e);
    res.status(500).json({ success: false, message: '检查状态失败' });
  }
});

// ─── Cookie 登录 ──────────────────────────────────────────

router.post('/login/cookie', async (req, res) => {
  const { cookie } = req.body;

  if (!cookie) {
    return res.status(400).json({ success: false, message: '请输入 Cookie' });
  }

  try {
    const status = await qqmusic.checkLoginStatus(cookie);

    if (!status.logged) {
      return res.status(400).json({ success: false, message: 'Cookie 无效或已过期' });
    }

    const token = generateToken();
    const token_expires_at = computeTokenExpiresAt();

    qqUserOps.upsert.run({
      qq_uin: String(status.userId),
      nickname: status.nickname,
      avatar: status.avatar,
      vip_type: status.vipType,
      cookie: encrypt(cookie),
      token,
      token_expires_at
    });

    res.json({
      success: true,
      data: {
        token,
        user: {
          nickname: status.nickname,
          avatar: status.avatar,
          vipType: status.vipType
        }
      }
    });
  } catch (e) {
    console.error('QQ音乐Cookie登录失败:', e);
    res.status(400).json({ success: false, message: 'Cookie 无效' });
  }
});

// ─── 状态查询 ─────────────────────────────────────────────

router.get('/status', async (req, res) => {
  const token = req.headers['x-qq-token'] || req.query.qqtoken;

  if (!token) {
    return res.json({ success: true, data: { logged: false } });
  }

  const user = qqUserOps.getByToken.get(token);

  if (!user) {
    return res.json({ success: true, data: { logged: false } });
  }

  res.json({
    success: true,
    data: {
      logged: true,
      user: {
        nickname: user.nickname,
        avatar: resolveQQAvatar(user.avatar, user.qq_uin),
        vipType: user.vip_type
      }
    }
  });
});

// ─── 退出登录 ─────────────────────────────────────────────

router.post('/logout', (req, res) => {
  const token = req.headers['x-qq-token'] || req.body.qqtoken;

  if (token) {
    const user = qqUserOps.getByToken.get(token);
    if (user) {
      const newToken = generateToken();
      const expiredAt = toSqliteDatetime(new Date());
      qqUserOps.rotateToken.run(newToken, '', expiredAt, user.id);
    }
  }

  res.json({ success: true, message: '已退出登录' });
});

module.exports = router;
