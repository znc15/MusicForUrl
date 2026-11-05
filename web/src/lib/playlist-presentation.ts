import type { PlaylistSummary } from './types';

export function playlistCountLabel(playlist?: PlaylistSummary): string {
  if (!playlist) return '';
  const total = playlist.totalCount ?? playlist.songCount ?? playlist.trackCount;
  const included = playlist.includedCount;
  if (included != null && total != null && (included < total || playlist.partialReason)) {
    return `已纳入 ${included} / ${total} 首`;
  }
  const count = included ?? total;
  return count == null ? '歌曲数量待获取' : `${count} 首`;
}

export function partialPlaylistMessage(playlist?: PlaylistSummary): string {
  if (playlist?.partialReason === 'upstream_page_failed') return '部分歌曲获取失败，可以重新获取。';
  if (playlist?.partialReason === 'platform_limit') return '已达到本次歌单读取上限。';
  if (playlist?.partialReason === 'missing_tracks') return '部分歌曲暂未取得。';
  return '';
}
