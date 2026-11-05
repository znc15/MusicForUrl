import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Link2, Trash2 } from 'lucide-react';
import { accountQueryKey, queryClient, removeCachedFavorite } from '@/lib/query-client';
import { api } from '@/lib/api';
import { PLATFORMS, platformInfo } from '@/lib/platforms';
import type { FavoriteItem, HistoryItem, Paged, PlaylistSummary, TopSong } from '@/lib/types';
import { formatDateTime, imageSrc } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CoverArt, PlaylistCard } from '@/components/playlist-card';
import { usePlaylistDetails } from '@/components/playlist-details';
import { EmptyState, PageHeader } from '@/components/page-header';
import { ListItem, ListReveal, Segmented } from '@/motion/primitives';
import { useAuth } from '@/stores/auth';
import { usePlayer } from '@/stores/player';
import { useUi } from '@/stores/ui';

const PAGE_SIZE = 18;

// 「我的音乐」只属于有歌单/收藏能力的平台；酷狗可以登录，但暂不提供个人歌单。
const LIBRARY_PLATFORMS = PLATFORMS.filter(item => item.library);

function usePagedList<T>(
  queryKey: unknown[],
  fetcher: (offset: number, limit: number, signal: AbortSignal) => Promise<Paged<T>>,
  enabled: boolean,
) {
  const scope = JSON.stringify(queryKey);
  const [pagination, setPagination] = React.useState({ scope, page: 0 });
  const page = pagination.scope === scope ? pagination.page : 0;
  const setPage = (next: number) => setPagination({ scope, page: next });
  React.useEffect(() => { setPagination({ scope, page: 0 }); }, [scope]);
  const query = useQuery({
    queryKey: [...queryKey, page],
    queryFn: ({ signal }) => fetcher(page * PAGE_SIZE, PAGE_SIZE, signal),
    enabled,
  });
  const pageCount = Math.max(1, Math.ceil((query.data?.total ?? 0) / PAGE_SIZE));
  React.useEffect(() => {
    if (query.data && page >= pageCount) setPagination({ scope, page: pageCount - 1 });
  }, [query.data, page, pageCount, scope]);
  return {
    error: query.error, retry: query.refetch,
    items: query.data?.data ?? [],
    loading: query.isLoading,
    page,
    setPage,
    pageCount,
  };
}

function Pager({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 pt-1">
      <Button variant="outline" size="sm" disabled={page === 0} onClick={() => onChange(page - 1)}>
        <ChevronLeft />上一页
      </Button>
      <span className="text-xs tabular-nums text-muted-foreground">{page + 1} / {pageCount}</span>
      <Button variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => onChange(page + 1)}>
        下一页<ChevronRight />
      </Button>
    </div>
  );
}

function GridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index}>
          <Skeleton className="aspect-square rounded-xl" />
          <Skeleton className="mt-2.5 h-3.5 w-3/4" />
        </div>
      ))}
    </div>
  );
}

export function UserView() {
  const platform = useUi(state => state.personalPlatform);
  const setPlatform = useUi(state => state.setPersonalPlatform);
  const users = useAuth(state => state.users);
  const openLogin = useUi(state => state.openLogin);
  const openPlaylist = usePlayer(state => state.open);
  const navigate = useNavigate();
  const token = useAuth(state => state.tokens[platform]);
  const { openDetails, details } = usePlaylistDetails(platform);
  const [tab, setTab] = React.useState('playlists');
  const [removing, setRemoving] = React.useState('');
  const user = users[platform];
  const userId = user?.userId ?? '';
  const options = { token };
  const loggedIn = !!user;


  const playlists = usePagedList<PlaylistSummary>(
    [...accountQueryKey(platform, userId, 'playlists')], (offset, limit, signal) => api.userPlaylists(platform, offset, limit, { ...options, signal }), loggedIn && tab === 'playlists',
  );
  const favorites = usePagedList<FavoriteItem>(
    [...accountQueryKey(platform, userId, 'favorites')], (offset, limit, signal) => api.favorites(platform, offset, limit, { ...options, signal }), loggedIn && tab === 'favorites',
  );
  const recent = usePagedList<HistoryItem>(
    [...accountQueryKey(platform, userId, 'recent')], (offset, limit, signal) => api.recent(platform, offset, limit, { ...options, signal }), loggedIn && tab === 'recent',
  );
  const top = useQuery({
    queryKey: accountQueryKey(platform, userId, 'top'),
    queryFn: ({ signal }) => api.top(platform, 20, { ...options, signal }),
    enabled: loggedIn && tab === 'top',
  });

  async function play(playlistId: string) {
    if (await openPlaylist(platform, playlistId)) navigate('/preview');
    else if (usePlayer.getState().status === 'error') toast.error(usePlayer.getState().message);
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1180px] flex-col gap-5">
      {details}
      <PageHeader
        eyebrow="My music"
        title="我的音乐"
        actions={(
          <Segmented
            ariaLabel="音乐平台"
            value={platform}
            onChange={setPlatform}
            options={LIBRARY_PLATFORMS.map(item => ({ value: item.id, label: item.short }))}
          />
        )}
      />

      {/* 数据归属提示：明确告诉用户这一页只属于哪一个账号 */}
      {user ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-[var(--shadow-card)]">
          <img
            src={imageSrc(user.avatar)}
            alt=""
            className="size-9 shrink-0 rounded-full border border-border object-cover"
            onError={event => { event.currentTarget.src = '/placeholder.svg'; }}
          />
          <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
            <strong className="mx-1 font-medium text-foreground">{user.nickname || '当前账号'}</strong>
            {platformInfo(platform).label} · ID {user.userId}
          </p>
          <Button variant="ghost" size="sm" asChild>
            <a href="/accounts">管理账号</a>
          </Button>
        </div>
      ) : (
        <EmptyState
          text={`登录${platformInfo(platform).label}后可以查看歌单、收藏和最近播放。`}
          action={<Button size="sm" onClick={() => openLogin(platform)}>登录音乐账号</Button>}
        />
      )}

      {user && (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-fit">
            <TabsTrigger value="playlists">我的歌单</TabsTrigger>
            <TabsTrigger value="favorites">我的收藏</TabsTrigger>
            <TabsTrigger value="recent">最近播放</TabsTrigger>
            <TabsTrigger value="top">近 30 天常听</TabsTrigger>
          </TabsList>

          <TabsContent value="playlists">
            {playlists.error ? <EmptyState text={playlists.error.message || '加载失败，请重试'} action={<Button variant="outline" size="sm" onClick={() => void playlists.retry()}>重试</Button>} /> : playlists.loading ? <GridSkeleton /> : !playlists.items.length ? <EmptyState text="这个账号下没有歌单" /> : (
              <ListReveal className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                {playlists.items.map(item => (
                  <ListItem key={item.id}>
                    <PlaylistCard
                      id={item.id}
                      name={item.name}
                      cover={item.cover}
                      meta={`${item.trackCount ?? item.songCount ?? 0} 首`}
                      onOpen={() => openDetails(item)}
                      onPlay={() => void play(item.id)}
                    />
                  </ListItem>
                ))}
              </ListReveal>
            )}
            <Pager page={playlists.page} pageCount={playlists.pageCount} onChange={playlists.setPage} />
          </TabsContent>

          <TabsContent value="favorites">
            {favorites.error ? <EmptyState text={favorites.error.message || '加载失败，请重试'} action={<Button variant="outline" size="sm" onClick={() => void favorites.retry()}>重试</Button>} /> : favorites.loading ? <GridSkeleton /> : !favorites.items.length ? <EmptyState text="还没有收藏歌单" /> : (
              <ListReveal className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                {favorites.items.map(item => (
                  <ListItem key={item.playlistId}>
                    <div className="group">
                      <PlaylistCard
                        id={item.playlistId}
                        name={item.name}
                        cover={item.cover}
                        meta={item.createdAt ? `收藏于 ${formatDateTime(item.createdAt)}` : ''}
                        onOpen={() => openDetails({ ...item, id: item.playlistId })}
                        onPlay={() => void play(item.playlistId)}
                      />
                      <div className="mt-1.5 flex gap-1.5">
                        <Button variant="ghost" size="sm" asChild>
                          <a href={`/?play=${item.playlistId}&platform=${platform}`}><Link2 />生成链接</a>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="取消收藏"
                          disabled={removing === item.playlistId}
                          onClick={async () => {
                            setRemoving(item.playlistId);
                            try {
                              await api.removeFavorite(platform, item.playlistId, token);
                              if (useAuth.getState().tokens[platform] !== token) return;
                              const key = accountQueryKey(platform, userId, 'favorites');
                              removeCachedFavorite(platform, userId, item.playlistId);
                              await queryClient.invalidateQueries({ queryKey: key });
                              toast.success('已取消收藏');
                            } catch (error) {
                              toast.error(error instanceof Error ? error.message : '操作失败');
                            } finally {
                              setRemoving('');
                            }
                          }}
                        >
                          <Trash2 />取消
                        </Button>
                      </div>
                    </div>
                  </ListItem>
                ))}
              </ListReveal>
            )}
            <Pager page={favorites.page} pageCount={favorites.pageCount} onChange={favorites.setPage} />
          </TabsContent>

          <TabsContent value="recent">
            {recent.error ? <EmptyState text={recent.error.message || '加载失败，请重试'} action={<Button variant="outline" size="sm" onClick={() => void recent.retry()}>重试</Button>} /> : recent.loading ? <GridSkeleton /> : !recent.items.length ? <EmptyState text="最近 30 天没有播放记录" /> : (
              <ListReveal className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                {recent.items.map(item => (
                  <ListItem key={item.playlistId}>
                    <PlaylistCard
                      id={item.playlistId}
                      name={item.name}
                      cover={item.cover}
                      meta={`${formatDateTime(item.playedAt)} · ${item.playCount} 次`}
                      onOpen={() => openDetails({ ...item, id: item.playlistId })}
                      onPlay={() => void play(item.playlistId)}
                    />
                  </ListItem>
                ))}
              </ListReveal>
            )}
            <Pager page={recent.page} pageCount={recent.pageCount} onChange={recent.setPage} />
          </TabsContent>

          <TabsContent value="top">
            {top.error ? <EmptyState text={top.error.message || '加载失败，请重试'} action={<Button variant="outline" size="sm" onClick={() => void top.refetch()}>重试</Button>} /> : top.isLoading ? <GridSkeleton /> : !top.data?.length ? <EmptyState text="还没有足够的播放记录" /> : (
              <ol className="flex flex-col gap-1.5">
                {top.data.map((song: TopSong, index) => (
                  <li
                    key={song.songId}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2"
                  >
                    <span className="w-6 shrink-0 text-center text-[12px] tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <CoverArt src={undefined} seed={song.songId} className="size-9 shrink-0 rounded-md" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{song.songName}</p>
                      <p className="truncate text-[11.5px] text-muted-foreground">{song.artist}</p>
                    </div>
                    <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{song.playCount} 次</span>
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
