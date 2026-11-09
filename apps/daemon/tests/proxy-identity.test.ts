import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDirectoryItem } from '@open-design/contracts';

import type { LocalTeamStore } from '../src/collab/local-teams.js';
import { personalWorkspaceIdForEmail } from '../src/collab/local-teams.js';
import {
  createProxyIdentityMiddleware,
  currentProxyEmail,
  mayWriteGlobalSettings,
  proxyMembershipFor,
  setProxyTeamStore,
} from '../src/http/proxy-identity.js';

const ALICE = 'alice@example.com';
const TEAM = 't-design';

function item(overrides: Partial<WorkspaceDirectoryItem>): WorkspaceDirectoryItem {
  return {
    workspaceId: TEAM,
    workspaceName: 'Design',
    workspaceType: 'team',
    workspaceMemberId: 'u-alice',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    ...overrides,
  };
}

function fakeStore(): LocalTeamStore {
  return {
    membershipFor: (email: string, workspaceId: string) => {
      if (email !== ALICE) return null;
      if (workspaceId === TEAM) return item({});
      if (workspaceId === personalWorkspaceIdForEmail(ALICE)) {
        return item({ workspaceId, workspaceType: 'personal', role: 'owner', workspaceName: 'Personal' });
      }
      return null;
    },
  } as unknown as LocalTeamStore;
}

function fakeReq(input: {
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  remoteAddress?: string;
}) {
  const url = input.url ?? '/api/projects/p1';
  const req: any = {
    method: input.method ?? 'GET',
    url,
    headers: { ...(input.headers ?? {}) },
    socket: { remoteAddress: input.remoteAddress ?? '172.18.0.5' },
  };
  Object.defineProperty(req, 'path', { get: () => new URL(req.url, 'http://x').pathname });
  Object.defineProperty(req, 'query', {
    get: () => Object.fromEntries(new URL(req.url, 'http://x').searchParams),
  });
  return req;
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

describe('proxy identity middleware', () => {
  const env = { OD_PROXY_AUTH: '1', OD_ADMIN_EMAILS: 'admin@example.com' } as NodeJS.ProcessEnv;
  const middleware = createProxyIdentityMiddleware({
    getStore: () => fakeStore(),
    isLoopbackPeer: (address) => address === '127.0.0.1',
    env,
  });

  beforeEach(() => {
    vi.stubEnv('OD_PROXY_AUTH', '1');
    vi.stubEnv('OD_ADMIN_EMAILS', 'admin@example.com');
    setProxyTeamStore(fakeStore());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setProxyTeamStore(null);
  });

  it('rejects non-loopback requests without the proxy email header', () => {
    const next = vi.fn();
    const res = fakeRes();
    middleware(fakeReq({}), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('lets loopback (agent subprocess / health check) requests through untouched', () => {
    const next = vi.fn();
    const req = fakeReq({ remoteAddress: '127.0.0.1', headers: { 'x-od-workspace-id': TEAM } });
    middleware(req, fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.headers['x-od-workspace-id']).toBe(TEAM);
  });

  it('replaces spoofed workspace headers with the verified membership', () => {
    let seenEmail: string | null = null;
    const req = fakeReq({
      headers: {
        'x-forwarded-email': 'Alice@Example.com',
        'x-od-workspace-id': TEAM,
        'x-od-workspace-member-id': 'u-mallory',
        'x-od-workspace-role': 'owner',
        'x-od-app-user-id': 'mallory',
      },
    });
    middleware(req, fakeRes(), () => { seenEmail = currentProxyEmail(); });
    expect(seenEmail).toBe(ALICE);
    expect(req.headers).toMatchObject({
      'x-od-workspace-id': TEAM,
      'x-od-workspace-member-id': 'u-alice',
      'x-od-workspace-role': 'member',
      'x-od-workspace-type': 'team',
      'x-od-app-user-id': ALICE,
    });
  });

  it('denies workspaces the user is not a member of', () => {
    const next = vi.fn();
    const res = fakeRes();
    middleware(fakeReq({ headers: { 'x-forwarded-email': ALICE, 'x-od-workspace-id': 't-other' } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('rewrites EventSource navigation query params to the verified pair', () => {
    const req = fakeReq({
      url: `/api/workspace/events?workspaceId=${TEAM}&workspaceMemberId=u-mallory`,
      headers: { 'x-forwarded-email': ALICE },
    });
    middleware(req, fakeRes(), () => undefined);
    expect(req.query).toMatchObject({ workspaceId: TEAM, workspaceMemberId: 'u-alice' });
    expect(req.headers['x-od-workspace-member-id']).toBe('u-alice');
  });

  it('scopes unscoped writes to the caller Personal workspace and leaves unscoped reads unscoped', () => {
    const write = fakeReq({ method: 'POST', url: '/api/projects', headers: { 'x-forwarded-email': ALICE } });
    middleware(write, fakeRes(), () => undefined);
    expect(write.headers['x-od-workspace-id']).toBe(personalWorkspaceIdForEmail(ALICE));
    expect(write.headers['x-od-workspace-type']).toBe('personal');

    const read = fakeReq({ headers: { 'x-forwarded-email': ALICE, 'x-od-workspace-member-id': 'u-mallory' } });
    middleware(read, fakeRes(), () => undefined);
    expect(read.headers['x-od-workspace-id']).toBeUndefined();
    expect(read.headers['x-od-workspace-member-id']).toBeUndefined();
  });

  it('accepts valid preview scopes without identity and never trusts headers on bad ones', () => {
    const previewMiddleware = createProxyIdentityMiddleware({
      getStore: () => fakeStore(),
      isLoopbackPeer: () => false,
      classifyPreviewRequest: (req) =>
        req.path.includes('/preview/') ? (req.path.includes('/good/') ? 'valid' : 'invalid') : null,
      env,
    });
    const okNext = vi.fn();
    const ok = fakeReq({ url: '/api/projects/p1/preview/good/index.html', headers: { 'x-od-workspace-id': TEAM } });
    previewMiddleware(ok, fakeRes(), okNext);
    expect(okNext).toHaveBeenCalledOnce();
    expect(ok.headers['x-od-workspace-id']).toBeUndefined();

    const badNext = vi.fn();
    const badRes = fakeRes();
    previewMiddleware(
      fakeReq({ url: '/api/projects/p1/preview/bad/index.html', headers: { 'x-forwarded-email': ALICE } }),
      badRes,
      badNext,
    );
    expect(badNext).not.toHaveBeenCalled();
    expect(badRes.statusCode).toBe(401);
  });

  it('resolves membership and admin rights only inside a proxied request', () => {
    expect(proxyMembershipFor(TEAM)).toBeUndefined();
    expect(mayWriteGlobalSettings()).toBe(true);
    const req = fakeReq({ headers: { 'x-forwarded-email': ALICE } });
    middleware(req, fakeRes(), () => {
      expect(proxyMembershipFor(TEAM)).toMatchObject({ workspaceMemberId: 'u-alice' });
      expect(proxyMembershipFor('t-other')).toBeNull();
      expect(mayWriteGlobalSettings()).toBe(false);
    });
    const admin = fakeReq({ headers: { 'x-forwarded-email': 'admin@example.com' } });
    middleware(admin, fakeRes(), () => {
      expect(mayWriteGlobalSettings()).toBe(true);
    });
  });
});
