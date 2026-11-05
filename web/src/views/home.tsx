import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Heart, Library, Link2, MonitorPlay } from 'lucide-react';
import { accountQueryKey, queryClient, removeCachedFavorite } from '@/lib/query-client';
import { EmptyState } from '@/components/page-header';
import { api } from '@/lib/api';
import { PLAYBACK_PLATFORMS, isPlatform, platformInfo } from '@/lib/platforms';
import { readGeneratorPlatform, writeGeneratorPlatform } from '@/lib/storage';
import type { GeneratedLink, Platform } from '@/lib/types';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/input';
import { CoverArt, PlaylistCard } from '@/components/playlist-card';
import { PlaylistLinkActions, usePlaylistDetails } from '@/components/playlist-details';
import { ListItem, ListReveal, Segmented } from '@/motion/primitives';
import { useAuth } from '@/stores/auth';
import { usePlayer } from '@/stores/player';
import { useUi } from '@/stores/ui';

function RecentGrid({ platform }: { platform: Platform }) {
  const { openDetails, details } = usePlaylistDetails(platform);
  const info = platformInfo(platform);
  const user = useAuth(state => state.users[platform]);
  const token = useAuth(state => state.tokens[platform]);
  const loggedIn = !!user;
  const openLogin = useUi(state => state.openLogin);
  const openPlaylist = usePlayer(state => state.open);
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [...accountQueryKey(platform, user?.userId ?? '', 'recent'), 'home'],
    queryFn: ({ signal }) => api.recent(platform, 0, 6, { token, signal }),
    enabled: loggedIn && info.library,
    staleTime: 60_000,
  });

  async function play(playlistId: string) {
    if (await openPlaylist(platform, playlistId)) navigate('/preview');
    else if (usePlayer.getState().status === 'error') toast.error(usePlayer.getState().message);
  }

  if (!info.library) return null;

  return (
    <section>
      {details}
      <div className="mb-3.5 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">最近播放</h2>
        <Link to="/user" className="text-[12.5px] font-medium text-primary hover:underline">查看全部 →</Link>
      </div>

      {!loggedIn ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-5 py-6 text-[13px] text-muted-foreground">
          登录后这里会显示最近播放的歌单。
          <Button variant="outline" size="sm" onClick={() => openLogin(platform)}>登录音乐账号</Button>
        </div>
      ) : error ? (
        <EmptyState text={error.message || '加载失败，请重试'} action={<Button variant="outline" size="sm" onClick={() => void refetch()}>重试</Button>} />
      ) : isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="aspect-square rounded-xl" />)}
        </div>
      ) : !data?.data.length ? (
        <div className="rounded-xl border border-dashed border-border px-5 py-6 text-[13px] text-muted-foreground">
          最近 30 天还没有播放记录。生成一个链接并播放后会出现在这里。
        </div>
      ) : (
        <ListReveal className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {data.data.map(item => (
            <ListItem key={item.playlistId}>
              <PlaylistCard
                id={item.playlistId}
                name={item.name}
                cover={item.cover}
                meta={`${item.playCount} 次播放`}
                onOpen={() => openDetails({ ...item, id: item.playlistId })}
                onPlay={() => void play(item.playlistId)}
              />
            </ListItem>
          ))}
        </ListReveal>
      )}
    </section>
  );
}

export function HomeView() {
  const [platform, setPlatform] = React.useState<Platform>(readGeneratorPlatform);
  const [input, setInput] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [inputError, setInputError] = React.useState('');
  const [resultState, setResult] = React.useState<{ data: GeneratedLink; platform: Platform; token: string } | null>(null);
  const [favorited, setFavorited] = React.useState(false);
  const [updatingFavorite, setUpdatingFavorite] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const users = useAuth(state => state.users);
  const tokens = useAuth(state => state.tokens);
  const result = resultState?.platform === platform && resultState.token === tokens[platform] ? resultState.data : null;
  const resultRef = React.useRef(result);
  resultRef.current = result;
  const requestRef = React.useRef<AbortController | null>(null);
  const openLogin = useUi(state => state.openLogin);
  const openPlaylist = usePlayer(state => state.open);
  const info = platformInfo(platform);
  // 游客平台不需要登录就能生成链接
  const canGenerate = !info.requireLogin || !!users[platform];

  function switchPlatform(next: Platform) {
    requestRef.current?.abort();
    setBusy(false);
    setPlatform(next);
    writeGeneratorPlatform(next);
    setResult(null);
    setFavorited(false);
    setInputError('');
  }

  const generate = React.useCallback(async (raw: string, target: Platform) => {
    if (!raw.trim()) { setInputError('请粘贴歌单链接或输入歌单 ID'); inputRef.current?.focus(); return; }
    setInputError('');
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const token = useAuth.getState().tokens[target];
    const current = () => !controller.signal.aborted && useAuth.getState().tokens[target] === token;
    setBusy(true);
    setResult(null);
    try {
      const data = await api.generate(target, raw.trim(), { token, signal: controller.signal });
      if (!current()) return;
      setResult({ data, platform: target, token });
      // 游客平台没有收藏，跳过这次请求
      const favorite = platformInfo(target).library
        ? await api.favoriteCheck(target, data.playlist?.id ?? '', { token, signal: controller.signal }).catch(() => false)
        : false;
      if (current()) setFavorited(favorite);
    } catch (error) {
      if (current()) setInputError(error instanceof Error ? error.message : '生成失败，请重试');
    } finally {
      if (requestRef.current === controller) setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    requestRef.current?.abort();
    setResult(null); setFavorited(false); setBusy(false);
    return () => { requestRef.current?.abort(); };
  }, [tokens]);

  // 支持 /?play=<歌单 ID>&platform=<平台> 深链，与旧版行为一致
  React.useEffect(() => {
    const id = params.get('play');
    if (!id) return;
    const requested = params.get('platform');
    const target: Platform = isPlatform(requested) ? requested : 'netease';
    setPlatform(target);
    writeGeneratorPlatform(target);
    setInput(id);
    const needsLogin = platformInfo(target).requireLogin && !useAuth.getState().tokens[target];
    if (!needsLogin) void generate(id, target);
  }, [params, generate]);

  async function toggleFavorite() {
    const playlist = result?.playlist;
    if (!playlist || updatingFavorite) return;
    const token = tokens[platform];
    const userId = users[platform]?.userId ?? '';
    setUpdatingFavorite(true);
    try {
      if (favorited) {
        await api.removeFavorite(platform, playlist.id, token);
        if (useAuth.getState().tokens[platform] === token) removeCachedFavorite(platform, userId, playlist.id);
      }
      else await api.addFavorite(platform, {
        playlistId: playlist.id, playlistName: playlist.name, playlistCover: playlist.cover,
      }, token);
      await queryClient.invalidateQueries({ queryKey: accountQueryKey(platform, userId, 'favorites') });
      if (useAuth.getState().tokens[platform] !== token || resultRef.current !== result) return;
      setFavorited(!favorited);
      toast.success(favorited ? '已取消收藏' : '收藏成功');
    } catch (error) {
      if (resultRef.current === result) toast.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setUpdatingFavorite(false);
    }
  }

  async function preview() {
    const playlist = result?.playlist;
    if (!playlist) return;
    if (await openPlaylist(platform, playlist.id)) navigate('/preview');
    else if (usePlayer.getState().status === 'error') toast.error(usePlayer.getState().message);
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1180px] flex-col gap-6">
      {/* 生成器是页面唯一的核心动作，因此放在品牌色最重的横幅里 */}
      <section className="hero-surface relative overflow-hidden rounded-2xl p-6 md:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-40 size-[420px] rounded-full"
          style={{ backgroundImage: 'radial-gradient(circle, rgb(111 199 234 / 12%), transparent 66%)' }}
        />
        <div className="relative">
          <h1 className="text-[27px] font-semibold leading-tight tracking-tight">把歌单变成播放链接</h1>
          <p className="mt-2 text-[13.5px] text-[var(--hero-muted)]">
            粘贴歌单链接，生成可直接在 VRChat 与播放器中使用的 M3U8。支持网易云、QQ 音乐、酷狗与酷我。
          </p>

          <Segmented
            ariaLabel="音乐平台"
            tone="hero"
            className="mt-5"
            value={platform}
            onChange={switchPlatform}
            options={PLAYBACK_PLATFORMS.map(item => ({ value: item.id, label: item.short }))}
          />

          <form
            className="mt-3 flex flex-col gap-2.5 sm:flex-row"
            onSubmit={event => {
              event.preventDefault();
              if (!canGenerate) { openLogin(platform); return; }
              void generate(input, platform);
            }}
          >
            <div className="flex h-[52px] min-w-0 shrink-0 items-center gap-3 rounded-xl bg-[var(--hero-field)] px-4 text-[var(--hero-field-foreground)] shadow-lg focus-within:ring-2 focus-within:ring-white/70 focus-within:ring-offset-2 focus-within:ring-offset-[var(--hero-mid)] sm:flex-1">
              <Link2 className="size-4 shrink-0" />
              <input
                ref={inputRef}
                value={input}
                onChange={event => { setInput(event.target.value); setInputError(''); }}
                placeholder={`粘贴${info.short}歌单链接或 ID`}
                aria-label="歌单链接或 ID"
                aria-invalid={!!inputError}
                aria-describedby={inputError ? 'playlist-input-error' : undefined}
                autoComplete="off"
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent text-base sm:text-sm text-[#123043] outline-none placeholder:text-[var(--hero-field-foreground)]"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="h-[52px] shrink-0 rounded-xl bg-white px-8 text-sm font-semibold text-[var(--hero-mid)] shadow-lg transition-transform hover:-translate-y-px disabled:opacity-70"
            >
              {busy ? '生成中…' : canGenerate ? '生成链接' : '登录账号'}
            </button>
          </form>
          {inputError && <p id="playlist-input-error" role="alert" className="mt-3 text-sm text-white">{inputError}</p>}
        </div>
      </section>

      {result?.playlist && (
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)] md:flex-row md:items-center">
          <CoverArt
            src={result.playlist.cover}
            seed={result.playlist.id}
            className="size-[62px] shrink-0 rounded-lg"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15.5px] font-semibold">{result.playlist.name}</p>
            <div className="mt-2">
              <PlaylistLinkActions result={result} platform={platform} onPlay={() => void preview()} onRetry={() => void generate(result.playlist!.id, platform)}>
                {info.library && (
                  <Button variant="outline" disabled={updatingFavorite} onClick={() => void toggleFavorite()}>
                    <Heart className={favorited ? 'fill-current' : undefined} />
                    {favorited ? '已收藏' : '收藏'}
                  </Button>
                )}
              </PlaylistLinkActions>
            </div>
          </div>
        </section>
      )}

      <RecentGrid platform={platform} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/preview"
          className="flex items-center gap-3.5 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)] transition-colors hover:bg-accent"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
            <MonitorPlay className="size-[18px]" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">播放器</span>
            <span className="block text-[12.5px] text-muted-foreground">歌单、媒体链接与本地文件</span>
          </span>
        </Link>
        <Link
          to="/user"
          className="flex items-center gap-3.5 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)] transition-colors hover:bg-accent"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
            <Library className="size-[18px]" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">我的音乐</span>
            <span className="block text-[12.5px] text-muted-foreground">歌单、收藏与播放记录</span>
          </span>
        </Link>
      </div>
    </div>
  );
}
