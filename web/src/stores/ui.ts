import { activeAnnouncement, hasReadAnnouncement, markAnnouncementRead } from '../lib/announcements';
import { create } from 'zustand';
import { PLATFORMS } from '../lib/platforms';
import { readPersonalPlatform, readSidebarCollapsed, writePersonalPlatform, writeSidebarCollapsed } from '../lib/storage';
import type { Platform } from '../lib/types';

/** 「我的音乐」只能选有账号能力的平台；记住的值失效时回退到网易云。 */
function initialPersonalPlatform(): Platform {
  const remembered = readPersonalPlatform();
  return remembered && PLATFORMS.some(item => item.id === remembered && item.library) ? remembered : 'netease';
}

interface UiState {
  loginOpen: boolean;
  loginEpoch: number;
  restartLogin(): void;
  announcementOpen: boolean;
  announcementPending: boolean;
  announcementUnread: boolean;
  showAnnouncement(): void;
  closeAnnouncement(): void;
  queueAnnouncement(): void;
  loginPlatform: Platform;
  /** 侧栏默认收起，展开状态持久化在本机 */
  sidebarCollapsed: boolean;
  /** 「我的音乐」当前选中的平台，侧栏头像与它保持一致 */
  personalPlatform: Platform;
  openLogin(platform?: Platform): void;
  closeLogin(): void;
  toggleSidebar(): void;
  setSidebar(collapsed: boolean): void;
  setPersonalPlatform(platform: Platform): void;
}

export const useUi = create<UiState>(set => ({
  loginOpen: false,
  loginEpoch: 0,
  announcementOpen: false,
  announcementPending: false,
  announcementUnread: !!activeAnnouncement() && !hasReadAnnouncement(activeAnnouncement()!.id),
  showAnnouncement() {
    if (!activeAnnouncement()) return;
    set(state => state.loginOpen ? { announcementPending: true } : { announcementOpen: true, announcementPending: false });
  },
  closeAnnouncement() {
    const item = activeAnnouncement();
    if (item) markAnnouncementRead(item.id);
    set({ announcementOpen: false, announcementPending: false, announcementUnread: false });
  },
  queueAnnouncement() {
    if (!activeAnnouncement()) return;
    set(state => state.announcementUnread && !state.announcementOpen ? { announcementPending: true } : {});
  },
  loginPlatform: 'netease',
  sidebarCollapsed: readSidebarCollapsed(),
  personalPlatform: initialPersonalPlatform(),

  openLogin(platform) {
    set(state => ({ loginOpen: true, loginEpoch: state.loginEpoch + 1, loginPlatform: platform ?? state.loginPlatform,
      announcementOpen: false, announcementPending: state.announcementPending || state.announcementOpen }));
  },
  closeLogin() { set({ loginOpen: false }); },
  restartLogin() { set(state => ({ loginEpoch: state.loginEpoch + 1 })); },

  toggleSidebar() {
    set(state => {
      const next = !state.sidebarCollapsed;
      writeSidebarCollapsed(next);
      return { sidebarCollapsed: next };
    });
  },

  setSidebar(collapsed) {
    writeSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed });
  },

  setPersonalPlatform(platform) {
    writePersonalPlatform(platform);
    set({ personalPlatform: platform });
  },
}));
