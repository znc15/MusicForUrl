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
  /** 重新播放和切歌清零进度；音质切换/续源保留这个代次。 */
  restartKey: number;
  retryKey: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  order: number[];
  orderIndex: number;
  canPrevious: boolean;
  canNext: boolean;

  open(platform: Platform, playlistId: string, grant?: string): Promise<boolean>;
  playIndex(index: number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  ended(): Promise<void>;
  toggleShuffle(): void;
  cycleRepeat(): void;
  setQuality(quality: QualityId): Promise<void>;
  retry(automatic?: boolean): Promise<void>;
  markPlaying(generation?: number): void;
  markPaused(generation?: number): void;
  fail(message: string, generation?: number): void;
  clear(): void;
}

const initialQuality = (): QualityId => readPlayerQuality() || 'low';

export const usePlayer = create<PlayerState>((set, get) => {
  let inFlight: AbortController | null = null;
  let skipTimer: ReturnType<typeof setTimeout> | null = null;
  const unavailable = new Set<number>();
  let visited: number[] = [];
  let visitedIndex = -1;

  function shuffled(values: number[]) {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  }

  function resetOrder(index: number) {
    const { playlist, shuffle } = get();
    const all = playlist?.tracks.map((_, position) => position) ?? [];
    const order = shuffle ? [index, ...shuffled(all.filter(position => position !== index))] : all;
    set({ order, orderIndex: order.indexOf(index) });
    syncNavigation();
  }

  function syncNavigation() {
    const { playlist, shuffle, repeat, index, order, orderIndex } = get();
    set({
      canPrevious: !!playlist && (shuffle ? visitedIndex > 0 : index > 0),
      canNext: !!playlist && ((shuffle && visitedIndex + 1 < visited.length) || orderIndex + 1 < order.length || repeat === 'all'),
    });
  }

  function finish() {
    clearSkipTimer();
    inFlight?.abort();
    inFlight = null;
    set({ status: 'ended', message: '歌单播放结束', errorCode: '', autoplay: false, generation: get().generation + 1 });
  }

  async function move(index: number, remember = true) {
    if (remember) { visited = [...visited.slice(0, visitedIndex + 1), index]; visitedIndex++; }
    set({ index, orderIndex: get().order.indexOf(index), restartKey: get().restartKey + 1 });
    syncNavigation();
    await load(index, { autoplay: true });
  }

  async function advance(skipping = false) {
    const { playlist, order, orderIndex, repeat, shuffle } = get();
    if (!playlist) return;
    if (shuffle && !skipping && visitedIndex + 1 < visited.length) {
      visitedIndex++;
      await move(visited[visitedIndex], false);
      return;
    }
    let nextOrder = order;
    let position = orderIndex + 1;
    if (position >= order.length && repeat === 'all') {
      nextOrder = playlist.tracks.map((_, index) => index);
      if (shuffle) {
        shuffled(nextOrder);
        if (nextOrder.length > 1 && nextOrder[0] === get().index) [nextOrder[0], nextOrder[1]] = [nextOrder[1], nextOrder[0]];
      }
      position = 0;
    }
    if (skipping) while (position < nextOrder.length && unavailable.has(nextOrder[position])) position++;
    if (position >= nextOrder.length) { finish(); return; }
    set({ order: nextOrder });
    await move(nextOrder[position]);
  }

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
      unavailable.clear();
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
      if (errorCode === 'unavailable') unavailable.add(index);
      if (errorCode === 'unavailable' && unavailable.size < playlist.tracks.length
        && (get().orderIndex + 1 < get().order.length || get().repeat === 'all')) {
        clearSkipTimer();
        skipTimer = setTimeout(() => {
          skipTimer = null;
          if (get().generation === generation && get().errorCode === 'unavailable') void advance(true);
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
    restartKey: 0,
    retryKey: 0,
    shuffle: false,
    repeat: 'off',
    order: [],
    orderIndex: 0,
    canPrevious: false,
    canNext: false,

    async open(platform, playlistId, grant = '') {
      clearSkipTimer();
      unavailable.clear(); visited = []; visitedIndex = -1;
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      const generation = get().generation + 1;
      set({ platform, generation, restartKey: get().restartKey + 1, order: [], orderIndex: 0, canPrevious: false, canNext: false,
        index: 0, status: 'loading', message: '', errorCode: '', source: null, playlist: null });
      try {
        const playlist = await api.playerPlaylist(platform, playlistId, grant, controller.signal);
        if (controller.signal.aborted || inFlight !== controller || get().generation !== generation) return false;
        if (!playlist.tracks.length) {
          set({ status: 'error', message: '这个歌单里没有可播放的歌曲', errorCode: 'empty' });
          return false;
        }
        set({ playlist });
        resetOrder(0);
        visited = [0]; visitedIndex = 0;
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

    async playIndex(index) {
      if (!get().playlist?.tracks[index] || !Number.isInteger(index)) return;
      unavailable.clear();
      if (get().shuffle && index !== get().index) resetOrder(index);
      await move(index);
    },

    async next() {
      unavailable.clear();
      await advance();
    },

    async prev() {
      unavailable.clear();
      const { index, shuffle } = get();
      if (shuffle && visitedIndex > 0) { visitedIndex--; await move(visited[visitedIndex], false); return; }
      if (!shuffle && index > 0) await move(index - 1);
    },

    async ended() {
      if (get().repeat === 'one' && get().errorCode !== 'unavailable') await move(get().index, false);
      else await advance();
    },

    toggleShuffle() {
      set({ shuffle: !get().shuffle }); resetOrder(get().index);
    },
    cycleRepeat() {
      set({ repeat: get().repeat === 'off' ? 'all' : get().repeat === 'all' ? 'one' : 'off' });
      syncNavigation();
    },

    async setQuality(quality) {
      writePlayerQuality(quality);
      set({ quality });
      await load(get().index, { autoplay: true });
    },

    // 播放出错时保留进度重试一次，与旧版行为一致
    async retry(automatic = false) {
      if (!automatic) set({ retryKey: get().retryKey + 1 });
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
      unavailable.clear(); visited = []; visitedIndex = -1;
      inFlight?.abort();
      inFlight = null;
      set({
        platform: null, playlist: null, index: 0, source: null, status: 'idle', message: '', errorCode: '',
        autoplay: false, generation: get().generation + 1,
        restartKey: get().restartKey + 1, order: [], orderIndex: 0, canPrevious: false, canNext: false,
      });
    },
  };
});

export function currentTrack(state: PlayerState) {
  return state.playlist?.tracks[state.index] ?? null;
}
