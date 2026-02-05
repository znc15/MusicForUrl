const express = require('express');
const router = express.Router();
const netease = require('../lib/netease');
const { encrypt, generateToken } = require('../lib/crypto');
const { userOps } = require('../lib/db');

const qrCodeSessions = new Map();
const QR_SESSION_MAX = 500;
const QR_SESSION_TTL = 3 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of qrCodeSessions.entries()) {
    if (now - value.created > QR_SESSION_TTL) {
      qrCodeSessions.delete(key);
    }
  }
}, 60 * 1000);

router.get('/qrcode', async (req, res) => {
  try {
    if (qrCodeSessions.size >= QR_SESSION_MAX) {
      return res.status(503).json({ success: false, message: '登录请求过多，请稍后重试' });
    }
    
    const { key, qrimg } = await netease.createQRCode();
    qrCodeSessions.set(key, { created: Date.now() });
    
    setTimeout(() => qrCodeSessions.delete(key), QR_SESSION_TTL);
    
    res.json({ success: true, data: { key, qrimg } });
  } catch (e) {
    console.error('获取二维码失败:', e);
    res.status(500).json({ success: false, message: '获取二维码失败' });
  }
});

router.get('/qrcode/check', async (req, res) => {
  const { key } = req.query;
  
  if (!key || !qrCodeSessions.has(key)) {
    return res.json({ success: false, message: '二维码已过期，请刷新' });
  }
  
  try {
    const result = await netease.checkQRCode(key);
    
    if (result.code === 803 && result.cookie) {
      qrCodeSessions.delete(key);
      
      const status = await netease.checkLoginStatus(result.cookie);
      
      if (!status.logged) {
        return res.json({ success: false, message: '登录状态异常' });
      }
      
      const token = generateToken();
      
      userOps.upsert.run({
        netease_id: String(status.userId),
        nickname: status.nickname,
        avatar: status.avatar,
        vip_type: status.vipType,
        cookie: encrypt(result.cookie),
        token
      });
      
      return res.json({
        success: true,
        code: result.code,
        message: '登录成功',
        data: {
          token,
          user: {
            nickname: status.nickname,
            avatar: status.avatar,
            vipType: status.vipType
          }
        }
      });
    }
    
    res.json({
      success: true,
      code: result.code,
      message: result.message
    });
  } catch (e) {
    console.error('检查二维码状态失败:', e);
    res.status(500).json({ success: false, message: '检查状态失败' });
  }
});

router.post('/captcha/send', async (req, res) => {
  const { phone } = req.body;
  
  if (!phone) {
    return res.status(400).json({ success: false, message: '请输入手机号' });
  }
  
  try {
    const sent = await netease.sendCaptcha(phone);
    res.json({ success: sent, message: sent ? '验证码已发送' : '发送失败' });
  } catch (e) {
    console.error('发送验证码失败:', e);
    res.status(500).json({ success: false, message: '发送验证码失败' });
  }
});

router.post('/login/captcha', async (req, res) => {
  const { phone, captcha } = req.body;
  
  if (!phone || !captcha) {
    return res.status(400).json({ success: false, message: '请输入手机号和验证码' });
  }
  
  try {
    const result = await netease.loginWithCaptcha(phone, captcha);
    const status = await netease.checkLoginStatus(result.cookie);
    
    const token = generateToken();
    
    userOps.upsert.run({
      netease_id: String(status.userId),
      nickname: status.nickname,
      avatar: status.avatar,
      vip_type: status.vipType,
      cookie: encrypt(result.cookie),
      token
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
    console.error('验证码登录失败:', e);
    res.status(400).json({ success: false, message: e.message || '登录失败' });
  }
});

router.post('/login/password', async (req, res) => {
  const { phone, password } = req.body;
  
  if (!phone || !password) {
    return res.status(400).json({ success: false, message: '请输入手机号和密码' });
  }
  
  try {
    const result = await netease.loginWithPassword(phone, password);
    const status = await netease.checkLoginStatus(result.cookie);
    
    const token = generateToken();
    
    userOps.upsert.run({
      netease_id: String(status.userId),
      nickname: status.nickname,
      avatar: status.avatar,
      vip_type: status.vipType,
      cookie: encrypt(result.cookie),
      token
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
    console.error('密码登录失败:', e);
    res.status(400).json({ success: false, message: e.message || '登录失败' });
  }
});

router.post('/login/cookie', async (req, res) => {
  const { cookie } = req.body;
  
  if (!cookie) {
    return res.status(400).json({ success: false, message: '请输入 Cookie' });
  }
  
  try {
    const status = await netease.checkLoginStatus(cookie);
    
    if (!status.logged) {
      return res.status(400).json({ success: false, message: 'Cookie 无效或已过期' });
    }
    
    const token = generateToken();
    
    userOps.upsert.run({
      netease_id: String(status.userId),
      nickname: status.nickname,
      avatar: status.avatar,
      vip_type: status.vipType,
      cookie: encrypt(cookie),
      token
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
    console.error('Cookie 登录失败:', e);
    res.status(400).json({ success: false, message: 'Cookie 无效' });
  }
});

router.get('/status', async (req, res) => {
  const token = req.headers['x-token'] || req.query.token;
  
  if (!token) {
    return res.json({ success: true, data: { logged: false } });
  }
  
  const user = userOps.getByToken.get(token);
  
  if (!user) {
    return res.json({ success: true, data: { logged: false } });
  }
  
  res.json({
    success: true,
    data: {
      logged: true,
      user: {
        nickname: user.nickname,
        avatar: user.avatar,
        vipType: user.vip_type
      }
    }
  });
});

router.post('/logout', (req, res) => {
  const token = req.headers['x-token'] || req.body.token;
  
  if (token) {
    const user = userOps.getByToken.get(token);
    if (user) {
      const newToken = generateToken();
      userOps.rotateToken.run(newToken, '', user.id);
    }
  }
  
  res.json({ success: true, message: '已退出登录' });
});

module.exports = router;
