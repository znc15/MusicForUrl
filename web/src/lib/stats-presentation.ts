import type { SiteStats } from './types';

type DurationStats = Pick<SiteStats, 'plays' | 'playDurationMs' | 'knownDurationPlays' | 'unknownDurationPlays' | 'unknown'>;

function estimatedDuration(milliseconds: number): string {
  if (milliseconds > 0 && milliseconds < 60000) return '不足 1 分钟';
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
}

export function playbackDurationPresentation(stats?: Partial<DurationStats>): { value: string; detail: string } {
  const missing = { value: '—', detail: stats ? '暂无可估算时长' : '' };
  if (!stats) return missing;
  const number = (key: Exclude<keyof DurationStats, 'unknown'>) => {
    const value = stats[key];
    return !stats.unknown?.includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value : null;
  };
  const plays = number('plays');
  const duration = number('playDurationMs');
  const known = number('knownDurationPlays');
  const unknown = number('unknownDurationPlays');
  if (plays === 0 && duration === 0 && (known === null || known === 0) && (unknown === null || unknown === 0)) {
    return { value: estimatedDuration(0), detail: '' };
  }
  if (plays === null || known === null || known === 0 || known > plays || duration === null || duration === 0) return missing;
  if (unknown !== null && known + unknown !== plays) return missing;
  return {
    value: estimatedDuration(duration),
    detail: known < plays ? `已计入 ${known.toLocaleString('zh-CN')} / ${plays.toLocaleString('zh-CN')} 次` : '',
  };
}
