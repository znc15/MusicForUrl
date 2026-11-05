export interface Announcement {
  id: string;
  title: string;
  date: string;
  paragraphs: string[];
}

export const CURRENT_ANNOUNCEMENT: Announcement | null = {
  id: 'release-2.4.0',
  title: '全新沉浸播放器',
  date: '2026-11-05',
  paragraphs: [
    '大封面与玻璃播放队列，随封面变换背景。点底部播放条即可展开播放器。',
    '现在可以搜索队列、随机播放和切换循环模式，也能使用系统媒体快捷键控制音乐。',
    '本地音频拥有新的播放控件，视频继续使用原生控制。切换页面时，歌单播放继续。',
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
