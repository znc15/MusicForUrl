const express = require('express');
const router = express.Router();
const { favoriteOps } = require('../lib/db');
const { auth } = require('../lib/auth');

function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

router.get('/', auth, (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  try {
    const favorites = favoriteOps.getByUser.all(req.user.id, limit, offset);
    const totalResult = favoriteOps.count.get(req.user.id);
    const total = totalResult ? totalResult.count : 0;
    
    res.json({
      success: true,
      data: favorites.map(f => ({
        playlistId: f.playlist_id,
        name: f.playlist_name,
        cover: f.playlist_cover,
        nickname: f.nickname,
        createdAt: f.created_at
      })),
      total
    });
  } catch (e) {
    console.error('获取收藏失败:', e);
    res.status(500).json({ success: false, message: '获取收藏失败' });
  }
});

router.post('/', auth, (req, res) => {
  const { playlistId, playlistName, playlistCover, nickname } = req.body;
  const pid = String(playlistId || '').trim();
  
  if (!pid) {
    return res.status(400).json({ success: false, message: '缺少歌单ID' });
  }
  if (!isValidNumericId(pid)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }
  
  try {
    favoriteOps.add.run({
      user_id: req.user.id,
      playlist_id: pid,
      playlist_name: playlistName || '',
      playlist_cover: playlistCover || '',
      nickname: nickname || null
    });
    
    res.json({ success: true, message: '收藏成功' });
  } catch (e) {
    console.error('添加收藏失败:', e);
    res.status(500).json({ success: false, message: '添加收藏失败' });
  }
});

router.delete('/:playlistId', auth, (req, res) => {
  const pid = String(req.params.playlistId || '').trim();
  if (!isValidNumericId(pid)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }
  
  try {
    favoriteOps.remove.run(req.user.id, pid);
    res.json({ success: true, message: '已取消收藏' });
  } catch (e) {
    console.error('删除收藏失败:', e);
    res.status(500).json({ success: false, message: '删除收藏失败' });
  }
});

router.get('/check/:playlistId', auth, (req, res) => {
  const pid = String(req.params.playlistId || '').trim();
  if (!isValidNumericId(pid)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }
  
  try {
    const exists = favoriteOps.check.get(req.user.id, pid);
    res.json({ success: true, data: { favorited: !!exists } });
  } catch (e) {
    console.error('检查收藏失败:', e);
    res.status(500).json({ success: false, message: '检查收藏失败' });
  }
});

module.exports = router;
