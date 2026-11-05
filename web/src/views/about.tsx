import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, MinusCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCount, formatDateTime, formatTotalDuration } from '@/lib/utils';
import { PLATFORMS } from '@/lib/platforms';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/input';
import { PageHeader } from '@/components/page-header';
import { useCapabilities } from '@/hooks/use-capabilities';

interface Health {
  status: string;
  degradeMode?: string;
  version?: string;
  features?: { analytics?: boolean; audioCache?: boolean };
}

const LINKS = [
  { href: 'https://github.com/znc15/MusicForUrl', label: '项目仓库' },
  { href: 'https://znc15.github.io/MusicForUrl/', label: '官网与文档' },
  { href: 'https://github.com/znc15/MusicForUrl/issues', label: '问题反馈' },
];

const DEGRADE_LABELS: Record<string, string> = {
  normal: '正常',
  'links-only': '仅提供链接（额度接近上限，已关闭站内播放器）',
  shed: '暂停新会话（额度接近上限，已签发的链接仍可播放）',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-0 last:pb-0">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-[13px] font-medium">{children}</span>
    </div>
  );
}

/** 统计数字块。数值在加载时用占位骨架，避免先闪一个 0 再跳到真实值。 */
function Stat({
  label, value, loading, wide = false,
}: {
  label: string;
  value: string;
  loading: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'col-span-2 sm:col-span-1' : undefined}>
      <p className="text-[11.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-24" />
      ) : (
        <p className="mt-1.5 text-[27px] font-semibold leading-none tracking-tight tabular-nums">{value}</p>
      )}
    </div>
  );
}

function CapabilityCell({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className={ok ? 'inline-flex items-center gap-1.5 text-foreground' : 'inline-flex items-center gap-1.5 text-muted-foreground'}>
      {ok ? <CheckCircle2 className="size-3.5 text-success" /> : <MinusCircle className="size-3.5" />}
      {text}
    </span>
  );
}

export function AboutView() {
  const capabilityQuery = useCapabilities();
  const capabilities = capabilityQuery.data;
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: async ({ signal }): Promise<Health> => {
      const response = await fetch('/api/health', { cache: 'no-store', signal });
      if (!response.ok) throw new Error(`服务状态获取失败（HTTP ${response.status}）`);
      const data: Health = await response.json();
      if (!data || typeof data.status !== 'string') throw new Error('服务状态响应无效');
      return data;
    },
    staleTime: 60_000,
  });
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.stats(),
    staleTime: 5 * 60_000,
  });

  const health = healthQuery.data;
  const capabilityUnknown = capabilityQuery.isPending ? '加载中…' : '未知';
  const healthUnknown = healthQuery.isPending ? '加载中…' : '未知';
  const data = stats.data;
  const loading = stats.isLoading;
  const updatedAt = data?.updatedAt ? formatDateTime(new Date(data.updatedAt).toISOString()) : '';

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5">
      <PageHeader
        eyebrow="About"
        title="关于 MusicForUrl"
        description="把网易云音乐、QQ 音乐、酷狗与酷我的歌单转换为轻量音频 M3U8 播放链接，并提供账号管理、收藏与媒体预览。"
      />

      {/* 站点统计：全站汇总口径，不含任何账号信息 */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold">站点统计</h2>
          <p className="text-[11.5px] text-muted-foreground">
            全站汇总口径{updatedAt ? ` · 更新于 ${updatedAt}` : ''}
          </p>
        </div>

        {stats.isError && (
          <div role="alert" className="mb-4 flex items-center gap-3 text-sm text-destructive">
            <span>{data ? '统计刷新失败' : '统计暂时不可用'}</span>
            <Button size="sm" variant="outline" disabled={stats.isFetching} onClick={() => void stats.refetch()}>重试</Button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="累计解析歌曲" value={data?.parsedSongs == null ? '—' : `${formatCount(data.parsedSongs)} 首`} loading={loading} />
          <Stat label="总播放时长" value={data?.playDurationMs == null ? '—' : formatTotalDuration(data.playDurationMs)} loading={loading} />
          <Stat label="使用人数" value={data?.listeners == null ? '—' : `${formatCount(data.listeners)} 人`} loading={loading} />
          <Stat label="累计播放" value={data?.plays == null ? '—' : `${formatCount(data.plays)} 次`} loading={loading} />
          <Stat label="生成链接" value={data?.generatedLinks == null ? '—' : `${formatCount(data.generatedLinks)} 个`} loading={loading} wide />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-[var(--shadow-card)]">
          <CardHeader className="pb-2"><CardTitle className="text-[15px]">构建信息</CardTitle></CardHeader>
          <CardContent>
            <Row label="前端版本"><span className="font-mono text-[12.5px]">{__APP_VERSION__}</span></Row>
            <Row label="播放后端"><span className="font-mono text-[12.5px]">{capabilities?.backend ?? capabilityUnknown}</span></Row>
            <Row label="无损音源">
              {typeof capabilities?.mp3Only === 'boolean' ? (
                <Badge variant={capabilities.mp3Only ? 'outline' : 'success'}>
                  {capabilities.mp3Only ? '当前部署不支持' : '可用'}
                </Badge>
              ) : capabilityUnknown}
            </Row>
            <Row label="私有音频缓存">
              {typeof capabilities?.privateCache === 'boolean' ? (
                <Badge variant={capabilities.privateCache ? 'success' : 'outline'}>
                  {capabilities.privateCache ? '已启用' : '未启用'}
                </Badge>
              ) : capabilityUnknown}
            </Row>
            {capabilityQuery.isError && (
              <div role="alert" className="flex items-center justify-between gap-3 py-2 text-sm text-destructive">
                <span>播放配置获取失败</span>
                <Button size="sm" variant="outline" disabled={capabilityQuery.isFetching} onClick={() => void capabilityQuery.refetch()}>重试</Button>
              </div>
            )}
            <Row label="服务状态">
              <span className="flex flex-wrap items-center justify-end gap-2">
                {healthQuery.isError ? <span role="alert" className="text-destructive">暂时不可用</span>
                  : health?.degradeMode ? DEGRADE_LABELS[health.degradeMode] ?? health.degradeMode : healthUnknown}
                {healthQuery.isError && <Button size="sm" variant="outline" disabled={healthQuery.isFetching} onClick={() => void healthQuery.refetch()}>重试</Button>}
              </span>
            </Row>
          </CardContent>
        </Card>

        <Card className="shadow-[var(--shadow-card)]">
          <CardHeader className="pb-2"><CardTitle className="text-[15px]">链接</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {LINKS.map(link => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary underline-offset-2 hover:underline"
              >
                {link.label}<ExternalLink className="size-3.5" />
              </a>
            ))}
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              项目代码采用 MIT License。各平台接口并非官方开放平台服务，可能随上游调整而失效。
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-[var(--shadow-card)]">
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px]">平台支持范围</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[38rem] border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">平台</th>
                <th className="py-2 pr-3 font-medium">账号接入</th>
                <th className="py-2 pr-3 font-medium">歌单解析</th>
                <th className="py-2 pr-3 font-medium">音源播放</th>
                <th className="py-2 font-medium">说明</th>
              </tr>
            </thead>
            <tbody>
              {PLATFORMS.map(item => (
                <tr key={item.id} className="border-b border-border last:border-0 align-top">
                  <td className="py-2.5 pr-3 font-medium">{item.label}</td>
                  <td className="py-2.5 pr-3">
                    <CapabilityCell ok={item.account} text={item.account ? '支持' : '不支持'} />
                  </td>
                  <td className="py-2.5 pr-3"><CapabilityCell ok={item.playback} text="支持" /></td>
                  <td className="py-2.5 pr-3"><CapabilityCell ok={item.playback} text="支持" /></td>
                  <td className="py-2.5 text-muted-foreground">{item.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
