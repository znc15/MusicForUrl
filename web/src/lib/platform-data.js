// 平台能力表的唯一事实来源（前端侧）。
//
// 刻意写成纯 JS：node:test 可以直接导入它，与 cloudflare/src/platforms.js 做逐字段
// 对照，不需要构建步骤。cloudflare/tests/platform-parity.test.js 就是这条守卫——
// 两边分叉时会出现「按钮点了报 403」，所以宁可让测试红掉。
//
// account  —— 支持账号登录（有 Cookie、头像、昵称）
// library  —— 有「我的音乐」：歌单、收藏、播放记录都依赖账号
// playback —— 能解析音源并生成播放链接
export const PLATFORM_TABLE = [
  {
    id: 'netease',
    label: '网易云音乐',
    short: '网易云',
    account: true,
    requireLogin: true,
    library: true,
    playback: true,
    note: '支持扫码 / 验证码 / 密码 / Cookie 登录，可读歌单、收藏与播放记录。',
  },
  {
    id: 'qq',
    label: 'QQ 音乐',
    short: 'QQ 音乐',
    account: true,
    requireLogin: true,
    library: true,
    playback: true,
    note: '支持扫码登录，可读歌单、收藏与播放记录。',
  },
  {
    id: 'kugou',
    label: '酷狗音乐',
    short: '酷狗',
    account: true,
    requireLogin: false,
    library: false,
    playback: true,
    note: '支持扫码登录；免登录也能读取公开歌单与音源。个人歌单与会员音源尚未接入。',
  },
  {
    id: 'kuwo',
    label: '酷我音乐',
    short: '酷我',
    account: true,
    requireLogin: false,
    library: false,
    playback: true,
    note: '支持账号密码 / 手机短信登录；免登录也能解析音源。个人歌单与会员音源尚未接入。',
  },
];
