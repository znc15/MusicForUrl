import { PLATFORM_TABLE } from './platform-data.js';
import type { Platform } from './types';

/**
 * 平台能力矩阵（前端侧）。
 *
 * 数据本体在 platform-data.js，这样 node:test 可以不经过构建直接导入它与后端
 * cloudflare/src/platforms.js 对照。后端决定接口是否存在，前端据此决定入口是否显示，
 * 两边必须一致，否则会出现「按钮点了报 403」。
 */
export interface PlatformInfo {
  id: Platform;
  /** 完整名称，用于标签与标题 */
  label: string;
  /** 短名称，用于侧栏与账号胶囊 */
  short: string;
  /** 是否支持账号登录（有 Cookie、头像、昵称） */
  account: boolean;
  /** 生成播放链接是否要求登录 */
  requireLogin: boolean;
  /** 是否有「我的音乐」：歌单、收藏、播放记录都依赖账号 */
  library: boolean;
  /** 是否能解析音源并生成播放链接 */
  playback: boolean;
  /** 平台能力摘要 */
  note: string;
}

export const PLATFORMS: PlatformInfo[] = PLATFORM_TABLE as PlatformInfo[];

export const PLATFORM_IDS = PLATFORMS.map(item => item.id);

const BY_ID = new Map(PLATFORMS.map(item => [item.id, item]));

export function platformInfo(id: Platform): PlatformInfo {
  return BY_ID.get(id) ?? PLATFORMS[0];
}

export function platformLabel(id: Platform): string {
  return platformInfo(id).label;
}

export function platformShort(id: Platform): string {
  return platformInfo(id).short;
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && BY_ID.has(value as Platform);
}

/** 有账号能力的平台，用于登录入口与「我的音乐」平台切换。 */
export const ACCOUNT_PLATFORMS = PLATFORMS.filter(item => item.account);

/** 能生成链接的平台，用于首页生成器。 */
export const PLAYBACK_PLATFORMS = PLATFORMS.filter(item => item.playback);
