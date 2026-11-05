export type Platform = 'netease' | 'qq' | 'kugou' | 'kuwo';
export type QualityId = 'low' | 'medium' | 'high' | 'lossless';
export type ThemeName = 'light' | 'dark' | 'system';

export interface AccountUser {
  userId: string;
  nickname: string;
  avatar: string;
  vipType: number;
  platform?: Platform;
}

export interface AuthStatus {
  logged: boolean;
  user?: AccountUser;
  /** 游客平台会带上 supported:false 与原因，用于「我的音乐」的空状态文案 */
  supported?: boolean;
  message?: string;
}

export interface PlatformCapability {
  id: Platform;
  account: boolean;
  library: boolean;
  playback: boolean;
}

export interface SiteStats {
  parsedSongs: number | null;
  generatedLinks: number | null;
  plays: number | null;
  playDurationMs: number | null;
  listeners: number | null;
  songs: number | null;
  playlists: number | null;
  updatedAt: number;
  version?: number;
  startedAt?: number | null;
  stale?: boolean;
  unknown?: string[];
  knownDurationPlays?: number | null;
  unknownDurationPlays?: number | null;
  playSources?: { player: number; hls: number; redirect: number };
  rankingWindowDays?: number;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  cover: string;
  songCount?: number;
  trackCount?: number;
  totalCount?: number;
  includedCount?: number;
  partialReason?: 'upstream_page_failed' | 'platform_limit' | 'missing_tracks' | null;
}

export interface FavoriteItem {
  playlistId: string;
  name: string;
  cover: string;
  nickname?: string | null;
  createdAt: string;
}

export interface HistoryItem {
  playlistId: string;
  name: string;
  cover: string;
  playedAt: string;
  playCount: number;
}

export interface TopSong {
  songId: string;
  songName: string;
  artist: string;
  playCount: number;
}

export interface UrlOption {
  type: string;
  label: string;
  url: string;
  note?: string;
}

export interface GeneratedLink {
  url: string;
  urls: UrlOption[];
  default: string;
  playlist?: PlaylistSummary;
  expiresAt?: number;
}

export interface QualityOption {
  id: QualityId;
  label: string;
  format: string;
  bitrate: number | null;
  enabled: boolean;
  reason: string;
}

export interface Capabilities {
  backend: string;
  mp3Only: boolean;
  defaultQuality: QualityId;
  privateCache: boolean;
  degraded?: 'normal' | 'links-only' | 'shed';
  /** 后端注册表下发的平台能力，前端只用来做兜底校验 */
  platforms?: PlatformCapability[];
  qualities: QualityOption[];
}

export interface PlayerTrack {
  id: string;
  name: string;
  artist: string;
  cover: string;
  duration: number;
}

export interface PlayerPlaylist {
  id: string;
  name: string;
  cover: string;
  platform: Platform;
  grant: string;
  tracks: PlayerTrack[];
}

export interface ResolvedSource {
  mediaUrl: string;
  coverUrl: string;
  song: PlayerTrack;
  requestedQuality: QualityId;
  quality: QualityId;
  format: string;
  bitrate: number | null;
  trial: boolean;
  warnings: string[];
  expiresAt: number;
}

export interface Paged<T> {
  data: T[];
  total: number;
}
