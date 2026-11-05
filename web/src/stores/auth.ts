import { create } from 'zustand';
import { clearAccountQueries } from '../lib/query-client';
import { usePlayer } from './player';
import { api } from '../lib/api';
import { ACCOUNT_PLATFORMS, PLATFORM_IDS } from '../lib/platforms';
import { clearToken, readToken, writeToken } from '../lib/storage';
import { activeAccount, readAccounts, removeAccount, upsertAccount, writeAccounts } from '../lib/workspace-rules';
import type { AccountUser, Platform } from '../lib/types';

/** 每个平台保留独立活动令牌，多账号登记按平台与账号 ID 保存。 */
export interface AccountRecord {
  platform: Platform;
  userId: string;
  nickname: string;
  avatar: string;
  vipType: number;
  token: string;
  addedAt: number;
}

interface AuthState {
  /** 每个平台当前生效的令牌 */
  tokens: Record<Platform, string>;
  /** 每个平台当前生效的账号资料 */
  users: Record<Platform, AccountUser | null>;
  /** 本机登录过的账号（含当前生效的），最近的排在最前 */
  accounts: AccountRecord[];
  ready: boolean;
  adopt(platform: Platform, token: string, user: AccountUser): void;
  switchTo(platform: Platform, userId: string): Promise<{ ok: boolean; message?: string }>;
  logout(platform: Platform): Promise<void>;
  forget(platform: Platform, userId: string): void;
  refresh(platform: Platform): Promise<AccountUser | null>;
  refreshAll(): Promise<void>;
}

const emptyTokens = () => Object.fromEntries(PLATFORM_IDS.map(id => [id, ''])) as Record<Platform, string>;
const emptyUsers = () => Object.fromEntries(PLATFORM_IDS.map(id => [id, null])) as Record<Platform, AccountUser | null>;

function initialAccounts(): AccountRecord[] {
  try { return readAccounts(localStorage) as AccountRecord[]; } catch { return []; }
}

function initialTokens(): Record<Platform, string> {
  const tokens = emptyTokens();
  for (const item of ACCOUNT_PLATFORMS) tokens[item.id] = readToken(item.id);
  // 旧版只给网易/QQ 分键；有明确登记归属时迁移共享键中的活动会话。
  const misplaced = initialAccounts().find(item => item.token === tokens.netease
    && (item.platform === 'kugou' || item.platform === 'kuwo'));
  if (misplaced) {
    if (!tokens[misplaced.platform]) {
      tokens[misplaced.platform] = misplaced.token;
      writeToken(misplaced.platform, misplaced.token);
    }
    tokens.netease = '';
    clearToken('netease');
  }
  return tokens;
}

/** 登记表只保存有账号能力的平台，游客平台没有令牌可存。 */
function persist(accounts: AccountRecord[]): AccountRecord[] {
  try { writeAccounts(localStorage, accounts); } catch { /* 隐私模式下忽略 */ }
  return accounts;
}

function recordFrom(platform: Platform, token: string, user: AccountUser): AccountRecord {
  return {
    platform,
    userId: user.userId,
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    vipType: user.vipType || 0,
    token,
    addedAt: Date.now(),
  };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && 'status' in error && (error as { status?: number }).status === 401;
}

export const useAuth = create<AuthState>((set, get) => {
  const pending = new Map<Platform, { token: string; controller: AbortController; promise: Promise<AccountUser | null> }>();
  let bootstrap: Promise<void> | null = null;

  function invalidate(platform: Platform) {
    pending.get(platform)?.controller.abort();
    pending.delete(platform);
    clearAccountQueries(platform);
    if (usePlayer.getState().platform === platform) usePlayer.getState().clear();
  }

  function drop(platform: Platform, userId?: string) {
    invalidate(platform);
    clearToken(platform);
    set(state => ({
      tokens: { ...state.tokens, [platform]: '' },
      users: { ...state.users, [platform]: null },
      accounts: persist(userId ? removeAccount(state.accounts, platform, userId) : state.accounts),
    }));
  }

  return {
    tokens: initialTokens(), users: emptyUsers(),
    accounts: initialAccounts(), ready: false,

    adopt(platform, token, user) {
      invalidate(platform);
      writeToken(platform, token);
      set(state => ({
        tokens: { ...state.tokens, [platform]: token },
        users: { ...state.users, [platform]: { ...user, platform } },
        accounts: persist(upsertAccount(state.accounts, recordFrom(platform, token, user))),
      }));
    },

    async switchTo(platform, userId) {
      const record = get().accounts.find(item => item.platform === platform && item.userId === userId);
      if (!record) return { ok: false, message: '请重新登录这个账号' };
      invalidate(platform);
      writeToken(platform, record.token);
      set(state => ({
        tokens: { ...state.tokens, [platform]: record.token },
        users: { ...state.users, [platform]: null },
      }));
      const user = await get().refresh(platform);
      if (get().tokens[platform] !== record.token) return { ok: false, message: '账号已切换' };
      return user ? { ok: true } : { ok: false, message: '未能验证账号，请重试或重新登录' };
    },

    async logout(platform) {
      const token = get().tokens[platform];
      const active = activeAccount(get().accounts, platform, token);
      drop(platform, active?.userId);
      try { await api.logout(platform, token); } catch { /* 本地已退出，旧 token 仍由服务端有效期限制 */ }
    },

    forget(platform, userId) {
      const active = activeAccount(get().accounts, platform, get().tokens[platform]);
      if (active?.userId === userId) drop(platform, userId);
      else set(state => ({ accounts: persist(removeAccount(state.accounts, platform, userId)) }));
    },

    refresh(platform) {
      const token = get().tokens[platform];
      if (!token) return Promise.resolve(null);
      const existing = pending.get(platform);
      if (existing?.token === token) return existing.promise;
      existing?.controller.abort();
      const controller = new AbortController();
      const current = () => !controller.signal.aborted && get().tokens[platform] === token;
      const promise = (async () => {
        try {
          const status = await api.authStatus(platform, { token, signal: controller.signal });
          if (!current()) return null;
          const user = status.logged && status.user ? { ...status.user, platform } : null;
          if (!user) {
            drop(platform, activeAccount(get().accounts, platform, token)?.userId);
            return null;
          }
          set(state => ({
            users: { ...state.users, [platform]: user },
            accounts: persist(upsertAccount(state.accounts, recordFrom(platform, token, user))),
          }));
          return user;
        } catch (error) {
          if (current() && isUnauthorized(error)) drop(platform, activeAccount(get().accounts, platform, token)?.userId);
          return null;
        } finally {
          if (pending.get(platform)?.controller === controller) pending.delete(platform);
        }
      })();
      pending.set(platform, { token, controller, promise });
      return promise;
    },

    refreshAll() {
      if (get().ready) return Promise.resolve();
      bootstrap ??= Promise.all(ACCOUNT_PLATFORMS.map(item => get().refresh(item.id)))
        .then(() => { set({ ready: true }); });
      return bootstrap;
    },
  };
});

export function activeToken(platform: Platform): string {
  return useAuth.getState().tokens[platform];
}

/** 当前生效账号的登记表条目；没有对应条目时返回 null。 */
export function currentAccount(platform: Platform): AccountRecord | null {
  const { accounts, tokens } = useAuth.getState();
  return activeAccount(accounts, platform, tokens[platform]) as AccountRecord | null;
}
