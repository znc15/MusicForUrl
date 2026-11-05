export interface Announcement {
  id: string;
  title: string;
  date: string;
  paragraphs: string[];
}

export const CURRENT_ANNOUNCEMENT: Announcement | null = {
  id: 'release-2.3.0',
  title: '歌单复制与播放体验更新',
  date: '2026-11-05',
  paragraphs: [
    '点开歌单可查看详情并复制播放地址，封面上的播放按钮仍可直接播放。',
    '登录弹窗和平台切换增加过渡，手机上的分类标签可横向浏览。',
    '修复了取消登录后的账号切换异常，以及静音和快速切歌时的状态问题。',
  ],
};

const KEY = 'mfu:announcements-read';
const sessionRead = new Set<string>();

export function hasReadAnnouncement(id: string): boolean {
  if (sessionRead.has(id)) return true;
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(ids) && ids.includes(id);
  } catch { return false; }
}

export function markAnnouncementRead(id: string) {
  sessionRead.add(id);
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    const ids = Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : [];
    localStorage.setItem(KEY, JSON.stringify([...new Set([...ids, id])].slice(-32)));
  } catch { /* The current page session still remembers dismissal. */ }
}

export function activeAnnouncement(item: Announcement | null = CURRENT_ANNOUNCEMENT): Announcement | null {
  return item?.id.trim() && item.title.trim() && item.paragraphs.some(paragraph => paragraph.trim()) ? item : null;
}
