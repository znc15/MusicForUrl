import { create } from 'zustand';
import { ApiError, api } from '../lib/api';
import { readPlayerQuality, writePlayerQuality } from '../lib/storage';
import type { Platform, PlayerPlaylist, QualityId, ResolvedSource } from '../lib/types';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

interface PlayerState {
  platform: Platform | null;
  playlist: PlayerPlaylist | null;
  index: number;
  quality: QualityId;
  source: ResolvedSource | null;
  status: PlayerStatus;
  message: string;
  /** 服务端错误码，用来区分「这首歌不可播」与登录/网络问题 */
  errorCode: string;
  autoplay: boolean;
  generation: number;

  open(platform: Platform, playlistId: string, grant?: string): Promise<boolean>;
  playIndex(index: number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  setQuality(quality: QualityId): Promise<void>;
  retry(): Promise<void>;
  markPlaying(generation?: number): void;
  markPaused(generation?: number): void;
  fail(message: string, generation?: number): void;
  clear(): void;
}

const initialQuality = (): QualityId => readPlayerQuality() || 'low';

export const usePlayer = create<PlayerState>((set, get) => {
  let inFlight: AbortController | null = null;
  let skipTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSkipTimer() {
    if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
  }

  async function load(index: number, options: { fresh?: boolean; autoplay?: boolean } = {}) {
    const { playlist, quality } = get();
    if (!playlist) return false;
    const track = playlist.tracks[index];
    if (!track) return false;

    clearSkipTimer();
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const generation = get().generation + 1;
    set({
      index,
      source: null,
      status: 'loading',
      message: '',
      errorCode: '',
      generation,
      autoplay: options.autoplay ?? true,
    });

    try {
      const source = await api.resolve(playlist.platform, {
        playlistId: playlist.id,
        grant: playlist.grant,
        songId: track.id,
        quality,
        fresh: options.fresh,
        signal: controller.signal,
      });
      if (controller.signal.aborted || inFlight !== controller || get().generation !== generation) return false;
      set({ source, status: 'loading', message: source.warnings.join(' ') });
      return true;
    } catch (error) {
      if (controller.signal.aborted || inFlight !== controller || get().generation !== generation) return false;
      const errorCode = error instanceof ApiError ? error.code : '';
      set({
        status: 'error',
        source: null,
        message: error instanceof Error ? error.message : '音源加载失败',
        errorCode,
      });
      // 平台判定整首不可播（版权、VIP、地区）时不打断整个歌单，提示后自动下一首
      if (errorCode === 'unavailable' && index + 1 < playlist.tracks.length) {
        clearSkipTimer();
        skipTimer = setTimeout(() => {
          skipTimer = null;
          if (get().generation === generation && get().errorCode === 'unavailable') void get().next();
        }, 1200);
      }
      return false;
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  return {
    platform: null,
    playlist: null,
    index: 0,
    quality: initialQuality(),
    source: null,
    status: 'idle',
    message: '',
    errorCode: '',
    autoplay: true,
    generation: 0,

    async open(platform, playlistId, grant = '') {
      clearSkipTimer();
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      const generation = get().generation + 1;
      set({ platform, generation, index: 0, status: 'loading', message: '', errorCode: '', source: null, playlist: null });
      try {
        const playlist = await api.playerPlaylist(platform, playlistId, grant, controller.signal);
        if (controller.signal.aborted || inFlight !== controller || get().generation !== generation) return false;
        if (!playlist.tracks.length) {
          set({ status: 'error', message: '这个歌单里没有可播放的歌曲', errorCode: 'empty' });
          return false;
        }
        set({ playlist });
        return await load(0, { autoplay: true });
      } catch (error) {
        if (controller.signal.aborted || inFlight !== controller || get().generation !== generation) return false;
        set({
          status: 'error',
          message: error instanceof Error ? error.message : '歌单加载失败',
          errorCode: error instanceof ApiError ? error.code : '',
        });
        return false;
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    },

    async playIndex(index) { await load(index, { autoplay: true }); },

    async next() {
      const { playlist, index } = get();
      if (!playlist) return;
      if (index + 1 >= playlist.tracks.length) {
        clearSkipTimer();
        inFlight?.abort();
        inFlight = null;
        set({ status: 'ended', message: '歌单播放结束', errorCode: '', autoplay: false, generation: get().generation + 1 });
        return;
      }
      await load(index + 1, { autoplay: true });
    },

    async prev() {
      const { index } = get();
      if (index <= 0) return;
      await load(index - 1, { autoplay: true });
    },

    async setQuality(quality) {
      writePlayerQuality(quality);
      set({ quality });
      await load(get().index, { autoplay: true });
    },

    // 播放出错时保留进度重试一次，与旧版行为一致
    async retry() {
      await load(get().index, { fresh: true, autoplay: true });
    },

    markPlaying(generation = get().generation) {
      if (generation === get().generation && get().source) set({ status: 'playing' });
    },
    markPaused(generation = get().generation) {
      if (generation === get().generation && get().source && get().status === 'playing') set({ status: 'paused' });
    },
    fail(message, generation = get().generation) {
      if (generation === get().generation && get().source) set({ status: 'error', message, errorCode: 'media' });
    },

    clear() {
      clearSkipTimer();
      inFlight?.abort();
      inFlight = null;
      set({
        platform: null, playlist: null, index: 0, source: null, status: 'idle', message: '', errorCode: '',
        autoplay: false, generation: get().generation + 1,
      });
    },
  };
});

export function currentTrack(state: PlayerState) {
  return state.playlist?.tracks[state.index] ?? null;
}
