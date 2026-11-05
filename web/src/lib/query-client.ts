import { QueryClient } from '@tanstack/react-query';
import type { FavoriteItem, Paged, Platform } from './types';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

export function accountQueryKey(platform: Platform, userId: string, resource: string) {
  return ['account', platform, userId, resource] as const;
}

export function clearAccountQueries(platform: Platform) {
  const filters = { queryKey: ['account', platform] };
  void queryClient.cancelQueries(filters);
  queryClient.removeQueries(filters);
}

export function removeCachedFavorite(platform: Platform, userId: string, playlistId: string) {
  queryClient.setQueriesData<Paged<FavoriteItem>>({ queryKey: accountQueryKey(platform, userId, 'favorites') }, previous => previous && ({
    total: Math.max(0, previous.total - 1),
    data: previous.data.filter(item => item.playlistId !== playlistId),
  }));
}
