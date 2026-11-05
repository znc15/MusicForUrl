import * as React from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ACCOUNT_PLATFORMS, platformLabel } from '@/lib/platforms';
import type { AccountUser, Platform } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Segmented } from '@/motion/primitives';
import { useLoginTask } from '@/hooks/use-login-task';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';

const QR_POLL_MS = 3000;
// 旧版每 2 秒轮询、持续 3 分钟，一次扫码登录会产生约 90 次请求；降频并设上限
const QR_MAX_POLLS = 40;

const QR_MESSAGES: Record<number, string> = {
  800: '二维码已过期，请刷新',
  801: '等待扫码',
  802: '已扫码，请在手机上确认',
  804: '二维码状态异常，请刷新',
};

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function QrPanel({ platform, onSuccess }: {
  platform: Platform;
  onSuccess: (token: string, user: AccountUser) => void;
}) {
  const [image, setImage] = React.useState('');
  const [status, setStatus] = React.useState('正在获取二维码…');
  const begin = useLoginTask();

  const start = React.useCallback(async () => {
    const task = begin();
    if (!task.isCurrent()) return;
    setImage('');
    setStatus('正在获取二维码…');
    try {
      const { key, qrimg } = await api.qrcode(platform, task.signal);
      if (!task.isCurrent()) return;
      setImage(qrimg);
      setStatus('请使用手机 App 扫码');
      for (let attempt = 0; attempt < QR_MAX_POLLS; attempt++) {
        await delay(QR_POLL_MS, task.signal);
        if (!task.isCurrent()) return;
        // 后台标签页不轮询，但仍占用轮询次数上限，避免切回来时无限延长
        if (document.hidden) continue;
        const result = await api.qrcodeCheck(platform, key, task.signal);
        if (!task.isCurrent()) return;
        if (result.code === 803 && result.data) {
          onSuccess(result.data.token, result.data.user);
          return;
        }
        setStatus(QR_MESSAGES[result.code] ?? result.message ?? '等待扫码');
        if (result.code === 800 || result.code === 804) return;
      }
      setStatus('二维码已过期，请刷新');
    } catch (error) {
      if (!task.isCurrent() || (error as Error)?.name === 'AbortError') return;
      setStatus(error instanceof Error ? error.message : '二维码获取失败');
    }
  }, [platform, onSuccess, begin]);

  React.useEffect(() => { void start(); }, [start]);

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="flex size-44 items-center justify-center rounded-md border border-border bg-card">
        {image
          ? <img src={image} alt="登录二维码" className="size-40" />
          : <span className="text-[13px] text-muted-foreground">加载中…</span>}
      </div>
      <p className="text-[13px] text-muted-foreground" role="status" aria-live="polite">{status}</p>
      <Button variant="outline" size="sm" onClick={() => void start()}>刷新二维码</Button>
    </div>
  );
}

function CaptchaPanel({ platform, onSuccess }: {
  platform: Platform;
  onSuccess: (token: string, user: AccountUser) => void;
}) {
  const [phone, setPhone] = React.useState('');
  const [captcha, setCaptcha] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const beginSend = useLoginTask();
  const [busy, setBusy] = React.useState(false);
  const beginSubmit = useLoginTask();

  async function send() {
    const task = beginSend();
    if (!task.isCurrent()) return;
    setSending(true);
    try {
      await api.sendCaptcha(platform, phone, task.signal);
      if (task.isCurrent()) toast.success('验证码已发送');
    } catch (error) {
      if (task.isCurrent()) toast.error(error instanceof Error ? error.message : '验证码发送失败');
    } finally {
      if (task.isCurrent()) setSending(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const task = beginSubmit();
    if (!task.isCurrent()) return;
    setBusy(true);
    try {
      const { token, user } = await api.loginCaptcha(platform, phone, captcha, task.signal);
      if (task.isCurrent()) onSuccess(token, user);
    } catch (error) {
      if (!task.isCurrent()) return;
      toast.error(error instanceof Error ? error.message : '登录失败');
    } finally {
      if (task.isCurrent()) setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="login-phone">手机号</Label>
        <Input id="login-phone" value={phone} onChange={event => setPhone(event.target.value)}
          inputMode="numeric" autoComplete="tel" placeholder="请输入手机号" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="login-captcha">验证码</Label>
        <div className="flex gap-2">
          <Input id="login-captcha" value={captcha} onChange={event => setCaptcha(event.target.value)}
            inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" required />
          <Button type="button" variant="outline" onClick={send} disabled={sending || !/^\d{6,20}$/.test(phone)}>
            {sending ? '发送中' : '发送'}
          </Button>
        </div>
      </div>
      <Button type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</Button>
    </form>
  );
}

function PasswordPanel({ platform, onSuccess }: {
  platform: Platform;
  onSuccess: (token: string, user: AccountUser) => void;
}) {
  const [phone, setPhone] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const beginSubmit = useLoginTask();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const task = beginSubmit();
    if (!task.isCurrent()) return;
    setBusy(true);
    try {
      const { token, user } = await api.loginPassword(platform, phone, password, task.signal);
      if (task.isCurrent()) onSuccess(token, user);
    } catch (error) {
      if (!task.isCurrent()) return;
      toast.error(error instanceof Error ? error.message : '登录失败');
    } finally {
      if (task.isCurrent()) setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="login-phone-pw">手机号</Label>
        <Input id="login-phone-pw" value={phone} onChange={event => setPhone(event.target.value)}
          inputMode="numeric" autoComplete="tel" placeholder="请输入手机号" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="login-password">密码</Label>
        <Input id="login-password" type="password" value={password}
          onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="请输入密码" required />
      </div>
      <Button type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</Button>
    </form>
  );
}

function CookiePanel({ platform, onSuccess }: {
  platform: Platform;
  onSuccess: (token: string, user: AccountUser) => void;
}) {
  const [cookie, setCookie] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const beginSubmit = useLoginTask();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const task = beginSubmit();
    if (!task.isCurrent()) return;
    setBusy(true);
    try {
      const { token, user } = await api.loginCookie(platform, cookie.trim(), task.signal);
      if (task.isCurrent()) onSuccess(token, user);
    } catch (error) {
      if (!task.isCurrent()) return;
      toast.error(error instanceof Error ? error.message : '登录失败');
    } finally {
      if (task.isCurrent()) setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="login-cookie">Cookie</Label>
        <Textarea id="login-cookie" value={cookie} onChange={event => setCookie(event.target.value)}
          placeholder="粘贴浏览器中的完整 Cookie" required />
      </div>
      <Button type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</Button>
    </form>
  );
}

type KuwoCaptchaState = { img: string; token: string; cookie: string };

/** 酷我的图形验证码与匿名会话 Cookie 绑定，token 与 cookie 必须原样带回登录请求。 */
function useKuwoCaptcha() {
  const [captcha, setCaptcha] = React.useState<KuwoCaptchaState | null>(null);
  const [loading, setLoading] = React.useState(false);
  const begin = useLoginTask();

  const refresh = React.useCallback(async () => {
    const task = begin();
    if (!task.isCurrent()) return;
    setLoading(true);
    try {
      const value = await api.authCaptcha('kuwo', task.signal);
      if (task.isCurrent()) setCaptcha(value);
    } catch (error) {
      if (!task.isCurrent()) return;
      setCaptcha(null);
      toast.error(error instanceof Error ? error.message : '获取验证码失败');
    } finally {
      if (task.isCurrent()) setLoading(false);
    }
  }, [begin]);

  React.useEffect(() => { void refresh(); }, [refresh]);
  return { captcha, loading, refresh };
}

function CaptchaField({ captcha, loading, onRefresh }: {
  captcha: KuwoCaptchaState | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onRefresh}
        title="点击刷新验证码"
        className="flex h-9 w-[125px] items-center justify-center overflow-hidden rounded-md border border-border bg-card"
      >
        {captcha
          ? <img src={captcha.img} alt="图形验证码" className="h-full w-full object-cover" />
          : <span className="text-[11.5px] text-muted-foreground">{loading ? '加载中…' : '点击重试'}</span>}
      </button>
      <span className="text-[11.5px] text-muted-foreground">字母区分大小写，点击图片可刷新</span>
    </div>
  );
}

function KuwoPasswordPanel({ onSuccess }: {
  onSuccess: (token: string, user: AccountUser) => void;
}) {
  const { captcha, loading, refresh } = useKuwoCaptcha();
  const [uname, setUname] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [verifyCode, setVerifyCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const beginSubmit = useLoginTask();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!captcha) { toast.error('验证码未加载，请点击图片刷新'); return; }
    const task = beginSubmit();
    if (!task.isCurrent()) return;
    setBusy(true);
    try {
      const { token, user } = await api.loginByPassword('kuwo', {
        uname: uname.trim(), password, verifyCode: verifyCode.trim(),
        verifyCodeToken: captcha.token, cookie: captcha.cookie,
      }, task.signal);
      if (task.isCurrent()) onSuccess(token, user);
    } catch (error) {
      if (!task.isCurrent()) return;
      toast.error(error instanceof Error ? error.message : '登录失败');
      setVerifyCode('');
      void refresh();
    } finally {
      if (task.isCurrent()) setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <div className="space-y-1.5">
        <Label htmlFor="kuwo-uname">酷我账号</Label>
        <Input id="kuwo-uname" value={uname} onChange={event => setUname(event.target.value)}
          autoComplete="username" placeholder="手机号或邮箱" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="kuwo-password">密码</Label>
        <Input id="kuwo-password" type="password" value={password}
          onChange={event => setPassword(event.target.value)} autoComplete="current-password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="kuwo-code">图形验证码</Label>
        <Input id="kuwo-code" value={verifyCode} onChange={event => setVerifyCode(event.target.value)}
          autoComplete="off" maxLength={8} />
        <CaptchaField captcha={captcha} loading={loading} onRefresh={() => void refresh()} />
      </div>
      <Button type="submit" disabled={busy || !captcha}>
        {busy ? '登录中…' : '登录'}
      </Button>
    </form>
  );
}

function KuwoSmsPanel({ onSuccess }: {
  onSuccess: (token: string, user: AccountUser) => void;
}) {
  const { captcha, loading, refresh } = useKuwoCaptcha();
  const [mobile, setMobile] = React.useState('');
  const [verifyCode, setVerifyCode] = React.useState('');
  const [smsCode, setSmsCode] = React.useState('');
  const [tm, setTm] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const beginSend = useLoginTask();
  const [busy, setBusy] = React.useState(false);
  const beginSubmit = useLoginTask();
  const [cooldown, setCooldown] = React.useState(0);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function send() {
    if (!captcha) { toast.error('验证码未加载，请点击图片刷新'); return; }
    if (!/^1\d{10}$/.test(mobile.trim())) { toast.error('请输入 11 位中国大陆手机号'); return; }
    const task = beginSend();
    if (!task.isCurrent()) return;
    setSending(true);
    try {
      const result = await api.sendLoginSms('kuwo', {
        mobile: mobile.trim(), verifyCode: verifyCode.trim(),
        verifyCodeToken: captcha.token, cookie: captcha.cookie,
      }, task.signal);
      if (!task.isCurrent()) return;
      setTm(result.tm);
      setCooldown(60);
      toast.success('短信验证码已发送');
    } catch (error) {
      if (!task.isCurrent()) return;
      toast.error(error instanceof Error ? error.message : '发送失败');
      void refresh();
    } finally {
      if (task.isCurrent()) setSending(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!captcha) { toast.error('验证码已失效，请刷新'); return; }
    if (!tm) { toast.error('请先获取短信验证码'); return; }
    const task = beginSubmit();
    if (!task.isCurrent()) return;
    setBusy(true);
    try {
      const { token, user } = await api.loginBySms('kuwo', {
        mobile: mobile.trim(), verifyCode: verifyCode.trim(), smsCode: smsCode.trim(),
        tm, cookie: captcha.cookie,
      }, task.signal);
      if (task.isCurrent()) onSuccess(token, user);
    } catch (error) {
      if (!task.isCurrent()) return;
      toast.error(error instanceof Error ? error.message : '登录失败');
    } finally {
      if (task.isCurrent()) setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <div className="space-y-1.5">
        <Label htmlFor="kuwo-mobile">手机号</Label>
        <Input id="kuwo-mobile" value={mobile} onChange={event => setMobile(event.target.value)}
          autoComplete="tel" inputMode="numeric" placeholder="11 位手机号" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="kuwo-sms-code">图形验证码</Label>
        <div className="flex gap-2">
          <Input id="kuwo-sms-code" value={verifyCode} onChange={event => setVerifyCode(event.target.value)}
            autoComplete="off" maxLength={8} className="flex-1" />
          <Button type="button" variant="outline" disabled={sending || cooldown > 0 || !captcha}
            onClick={() => void send()}>
            {cooldown > 0 ? `${cooldown}s 后重发` : sending ? '发送中…' : '发送验证码'}
          </Button>
        </div>
        <CaptchaField captcha={captcha} loading={loading} onRefresh={() => void refresh()} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="kuwo-sms">短信验证码</Label>
        <Input id="kuwo-sms" value={smsCode} onChange={event => setSmsCode(event.target.value)}
          autoComplete="one-time-code" inputMode="numeric" maxLength={8} />
      </div>
      <Button type="submit" disabled={busy || !tm}>
        {busy ? '登录中…' : '登录'}
      </Button>
    </form>
  );
}

export function LoginDialog() {
  const open = useUi(state => state.loginOpen);
  const platform = useUi(state => state.loginPlatform);
  const closeLogin = useUi(state => state.closeLogin);
  const setPlatform = useUi(state => state.openLogin);
  const adopt = useAuth(state => state.adopt);
  const epoch = useUi(state => state.loginEpoch);
  const restartLogin = useUi(state => state.restartLogin);

  const handleSuccess = React.useCallback((target: Platform) => (token: string, user: AccountUser) => {
    const current = useUi.getState();
    if (!current.loginOpen || current.loginEpoch !== epoch || current.loginPlatform !== target) return;
    adopt(target, token, user);
    toast.success(`已登录 ${user.nickname || platformLabel(target)}`);
    closeLogin();
  }, [adopt, closeLogin, epoch]);

  // 每个平台的成功回调都要稳定引用，否则二维码面板会被反复重挂
  const handlers = React.useMemo(
    () => Object.fromEntries(ACCOUNT_PLATFORMS.map(item => [item.id, handleSuccess(item.id)])) as
      Record<string, (token: string, user: AccountUser) => void>,
    [handleSuccess],
  );
  const active: Platform = ACCOUNT_PLATFORMS.some(item => item.id === platform) ? platform : 'netease';

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) closeLogin(); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>登录音乐账号</DialogTitle>
        </DialogHeader>

        <Segmented
          ariaLabel="选择平台"
          className="mb-4"
          value={active}
          onChange={setPlatform}
          options={ACCOUNT_PLATFORMS.map(item => ({ value: item.id, label: item.label }))}
        />

        <div key={active} className="dialog-content-enter">
        {active === 'netease' ? (
          <Tabs defaultValue="qrcode" onValueChange={restartLogin}>
            <TabsList className="w-full">
              <TabsTrigger value="qrcode">扫码</TabsTrigger>
              <TabsTrigger value="captcha">验证码</TabsTrigger>
              <TabsTrigger value="password">密码</TabsTrigger>
              <TabsTrigger value="cookie">Cookie</TabsTrigger>
            </TabsList>
            <TabsContent value="qrcode"><QrPanel key={epoch} platform="netease" onSuccess={handlers.netease} /></TabsContent>
            <TabsContent value="captcha"><CaptchaPanel key={epoch} platform="netease" onSuccess={handlers.netease} /></TabsContent>
            <TabsContent value="password"><PasswordPanel key={epoch} platform="netease" onSuccess={handlers.netease} /></TabsContent>
            <TabsContent value="cookie"><CookiePanel key={epoch} platform="netease" onSuccess={handlers.netease} /></TabsContent>
          </Tabs>
        ) : active === 'kuwo' ? (
          <Tabs defaultValue="password" onValueChange={restartLogin}>
            <TabsList className="w-full">
              <TabsTrigger value="password">账号密码</TabsTrigger>
              <TabsTrigger value="sms">手机短信</TabsTrigger>
            </TabsList>
            <TabsContent value="password"><KuwoPasswordPanel key={epoch} onSuccess={handlers.kuwo} /></TabsContent>
            <TabsContent value="sms"><KuwoSmsPanel key={epoch} onSuccess={handlers.kuwo} /></TabsContent>
          </Tabs>
        ) : (
          <QrPanel key={epoch} platform={active} onSuccess={handlers[active]} />
        )}
        </div>

      </DialogContent>
    </Dialog>
  );
}
