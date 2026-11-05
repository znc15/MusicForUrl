import { isPlatform } from './platforms';
import type { Platform, QualityId, ThemeName } from './types';

// 前六个键必须与旧版前端逐字节一致，否则现有用户会被登出、丢失主题与音质偏好。
// 之后的是新增键，老版本读不到也不会报错。
export const STORAGE_KEYS = {
  token: 'token',
  qqToken: 'qqToken',
  kugouToken: 'kugouToken',
  kuwoToken: 'kuwoToken',
  theme: 'theme',
  generatorPlatform: 'generatorPlatform',
  personalPlatformTab: 'personalPlatformTab',
  playerQuality: 'mfu:player-quality',
  playerVolume: 'mfu:player-volume',
  playerMuted: 'mfu:player-muted',
  sidebarCollapsed: 'mfu:sidebar-collapsed',
  accounts: 'mfu:accounts',
} as const;

function safeRead(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function safeWrite(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式下忽略 */ }
}

function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* 忽略 */ }
}

const TOKEN_KEYS: Record<Platform, string> = {
  netease: STORAGE_KEYS.token, qq: STORAGE_KEYS.qqToken,
  kugou: STORAGE_KEYS.kugouToken, kuwo: STORAGE_KEYS.kuwoToken,
};

export function readToken(platform: Platform): string {
  return safeRead(TOKEN_KEYS[platform]);
}

export function writeToken(platform: Platform, token: string): void {
  safeWrite(TOKEN_KEYS[platform], token);
}

export function clearToken(platform: Platform): void {
  safeRemove(TOKEN_KEYS[platform]);
}

export type { ThemeName };

export function readTheme(): ThemeName {
  const value = safeRead(STORAGE_KEYS.theme);
  // 旧版只写 'light' / 'dark'，读不懂的值一律回退到 'light'，保持与旧版一致
  return value === 'dark' ? 'dark' : value === 'system' ? 'system' : 'light';
}

// 旧版写入的是 'light' 字符串而不是删除键，保持一致以免出现两种状态
export function writeTheme(theme: ThemeName): void {
  safeWrite(STORAGE_KEYS.theme, theme);
}

export function readGeneratorPlatform(): Platform {
  const value = safeRead(STORAGE_KEYS.generatorPlatform);
  return isPlatform(value) ? value : 'netease';
}

export function writeGeneratorPlatform(platform: Platform): void {
  safeWrite(STORAGE_KEYS.generatorPlatform, platform);
}

export function readPersonalPlatform(): Platform | '' {
  const value = safeRead(STORAGE_KEYS.personalPlatformTab);
  return isPlatform(value) ? value : '';
}

export function writePersonalPlatform(platform: Platform): void {
  safeWrite(STORAGE_KEYS.personalPlatformTab, platform);
}

export function readPlayerQuality(): QualityId | '' {
  const value = safeRead(STORAGE_KEYS.playerQuality);
  return value === 'low' || value === 'medium' || value === 'high' || value === 'lossless' ? value : '';
}

export function writePlayerQuality(quality: QualityId): void {
  safeWrite(STORAGE_KEYS.playerQuality, quality);
}

/** 音量是 0–1 的浮点数；损坏的值回退到 1，避免出现「静音了但没提示」的状态。 */
export function readPlayerVolume(): number {
  const value = Number.parseFloat(safeRead(STORAGE_KEYS.playerVolume));
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
}

export function writePlayerVolume(volume: number): void {
  safeWrite(STORAGE_KEYS.playerVolume, String(Math.min(1, Math.max(0, volume))));
}

export function readPlayerMuted(): boolean {
  return safeRead(STORAGE_KEYS.playerMuted) === '1';
}

export function writePlayerMuted(muted: boolean): void {
  safeWrite(STORAGE_KEYS.playerMuted, muted ? '1' : '0');
}

/** 侧栏默认收起；只有显式展开过才会写入 '0'。 */
export function readSidebarCollapsed(): boolean {
  return safeRead(STORAGE_KEYS.sidebarCollapsed) !== '0';
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  safeWrite(STORAGE_KEYS.sidebarCollapsed, collapsed ? '1' : '0');
}
