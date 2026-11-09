// Proxy-asserted identity for multi-user self-hosted deployments.
//
// Enabled with OD_PROXY_AUTH=1. The daemon must then be reachable ONLY through
// an authenticating reverse proxy (e.g. oauth2-proxy) that sets a trusted email
// header (OD_PROXY_EMAIL_HEADER, default `x-forwarded-email`) and strips any
// client-supplied copy. For every non-loopback request this middleware:
//
//   1. requires that email (401 otherwise),
//   2. discards every client-supplied `x-od-workspace-*` / `x-od-app-user-id`
//      header, and
//   3. re-derives them from the local team directory (`collab/local-teams.ts`)
//      for the workspace the client asked for — 403 when the caller is not a
//      member.
//
// The rest of the daemon keeps trusting those headers exactly as it does in
// local mode, so the existing project visibility gate enforces Personal /
// Team-private / Team-shared access without further changes.
//
// Loopback peers are left untouched: they are the daemon's own agent
// subprocesses and the container health check. Never place the reverse proxy
// in the daemon's network namespace (e.g. `network_mode: host` or a sidecar
// sharing the pod network), or proxied traffic would look like loopback.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type { WorkspaceDirectoryItem } from '@open-design/contracts';
import { isTruthyEnvFlag } from '../api-token-auth.js';
import {
  normalizeEmail,
  personalWorkspaceIdForEmail,
  type LocalTeamStore,
} from '../collab/local-teams.js';

const DEFAULT_EMAIL_HEADER = 'x-forwarded-email';
const WORKSPACE_HEADER_PREFIX = 'x-od-workspace-';
const APP_USER_HEADER = 'x-od-app-user-id';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OPEN_PROBE_PATHS = new Set([
  '/health',
  '/api/health',
  '/ready',
  '/api/ready',
  '/version',
  '/api/version',
]);

interface ProxyIdentity {
  email: string;
}

const identityStorage = new AsyncLocalStorage<ProxyIdentity>();
let activeTeamStore: LocalTeamStore | null = null;

/** Registered once at startup so deep authorization seams can resolve membership. */
export function setProxyTeamStore(store: LocalTeamStore | null): void {
  activeTeamStore = store;
}

/**
 * The current proxy user's directory entry for `workspaceId`.
 * `undefined` = no proxy identity on this request (proxy mode off or loopback);
 * `null` = authenticated but not a member.
 */
export function proxyMembershipFor(workspaceId: string): WorkspaceDirectoryItem | null | undefined {
  if (!isProxyAuthEnabled()) return undefined;
  const email = currentProxyEmail();
  if (!email) return undefined;
  return activeTeamStore?.membershipFor(email, workspaceId) ?? null;
}

export function isProxyAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvFlag(env.OD_PROXY_AUTH);
}

export function proxyEmailHeaderName(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OD_PROXY_EMAIL_HEADER?.trim() || DEFAULT_EMAIL_HEADER).toLowerCase();
}

/** The authenticated email for the current request, or null (loopback / off). */
export function currentProxyEmail(): string | null {
  return identityStorage.getStore()?.email ?? null;
}

export function proxyAdminEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    String(env.OD_ADMIN_EMAILS ?? '')
      .split(',')
      .map((value) => normalizeEmail(value))
      .filter((value): value is string => Boolean(value)),
  );
}

/**
 * True when the request may change daemon-wide settings. Loopback callers
 * (agent subprocesses, local CLI) and proxy mode being off keep upstream
 * behavior; otherwise only OD_ADMIN_EMAILS may write.
 */
export function mayWriteGlobalSettings(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isProxyAuthEnabled(env)) return true;
  const email = currentProxyEmail();
  if (!email) return true;
  return proxyAdminEmails(env).has(email);
}

/** Express guard for daemon-wide settings writes. */
export function requireGlobalSettingsWriter(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method) || mayWriteGlobalSettings()) return next();
  res.status(403).json({
    error: {
      code: 'ADMIN_REQUIRED',
      message: 'only OpenDesign administrators (OD_ADMIN_EMAILS) can change shared settings',
    },
  });
}

export function applyWorkspaceIdentityHeaders(req: Request, item: WorkspaceDirectoryItem): void {
  const headers = req.headers;
  headers['x-od-workspace-id'] = item.workspaceId;
  headers['x-od-workspace-member-id'] = item.workspaceMemberId;
  headers['x-od-workspace-type'] = item.workspaceType;
  headers['x-od-workspace-role'] = item.role;
  headers['x-od-workspace-member-status'] = item.memberStatus;
  headers['x-od-workspace-lifecycle-state'] = item.lifecycleState;
  headers['x-od-workspace-can-share-projects'] = 'true';
  headers['x-od-workspace-can-write-synced-files'] = 'true';
}

function stripClientIdentityHeaders(req: Request): void {
  for (const name of Object.keys(req.headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(WORKSPACE_HEADER_PREFIX) || lower === APP_USER_HEADER) {
      delete req.headers[name];
    }
  }
}

/** Rewrite EventSource navigation params so they match the verified headers. */
function rewriteNavigationQuery(req: Request, item: WorkspaceDirectoryItem): void {
  const url = new URL(req.url, 'http://daemon.local');
  if (!url.searchParams.has('workspaceId') && !url.searchParams.has('workspaceMemberId')) return;
  url.searchParams.set('workspaceId', item.workspaceId);
  url.searchParams.set('workspaceMemberId', item.workspaceMemberId);
  req.url = `${url.pathname}${url.search}`;
}

function claimedWorkspaceId(req: Request): string | null {
  const header = req.headers['x-od-workspace-id'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();
  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = query?.workspaceId;
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();
  return null;
}

export interface ProxyIdentityMiddlewareOptions {
  /** Lazy: the daemon opens SQLite after middleware registration. */
  getStore: () => LocalTeamStore | null;
  isLoopbackPeer: (address: string | undefined) => boolean;
  /**
   * Project preview asset paths. Sandboxed preview iframes send no cookies, so
   * the proxy lets these paths through unauthenticated (skip-auth route) and
   * the daemon accepts them only with a valid server-minted preview scope:
   * 'valid' = scoped asset, 'invalid' = preview path with a bad scope (always
   * rejected — never fall back to a possibly client-supplied email header),
   * null = not a preview path.
   */
  classifyPreviewRequest?: (req: Request) => 'valid' | 'invalid' | null;
  env?: NodeJS.ProcessEnv;
}

export function createProxyIdentityMiddleware(options: ProxyIdentityMiddlewareOptions) {
  const env = options.env ?? process.env;
  const headerName = proxyEmailHeaderName(env);

  return function proxyIdentity(req: Request, res: Response, next: NextFunction) {
    if (options.isLoopbackPeer(req.socket?.remoteAddress)) return next();
    if (OPEN_PROBE_PATHS.has(req.path)) return next();
    const preview = options.classifyPreviewRequest?.(req) ?? null;
    if (preview === 'valid' && (req.method === 'GET' || req.method === 'HEAD')) {
      stripClientIdentityHeaders(req);
      return next();
    }
    if (preview !== null) {
      res.status(401).json({
        error: { code: 'PREVIEW_SCOPE_INVALID', message: 'preview link expired; reload the project' },
      });
      return;
    }

    const rawEmail = req.headers[headerName];
    const email = normalizeEmail(Array.isArray(rawEmail) ? rawEmail[0] : rawEmail);
    if (!email) {
      res.status(401).json({
        error: {
          code: 'PROXY_IDENTITY_REQUIRED',
          message: 'request did not pass through the authenticating proxy',
        },
      });
      return;
    }

    const store = options.getStore();
    if (!store) {
      res.status(503).json({ error: { code: 'NOT_READY', message: 'daemon is starting' } });
      return;
    }
    const claimed = claimedWorkspaceId(req);
    stripClientIdentityHeaders(req);
    req.headers[APP_USER_HEADER] = email;

    let item: WorkspaceDirectoryItem | null = null;
    if (claimed) {
      item = store.membershipFor(email, claimed);
      if (!item) {
        res.status(403).json({
          error: 'WORKSPACE_ACCESS_DENIED',
          message: 'the requested workspace is not available to this member',
        });
        return;
      }
    } else if (!SAFE_METHODS.has(req.method)) {
      // Unscoped writes (e.g. create project without a workspace header) land
      // in the caller's Personal workspace instead of an unowned global bucket.
      item = store.membershipFor(email, personalWorkspaceIdForEmail(email));
    }
    if (item) {
      applyWorkspaceIdentityHeaders(req, item);
      rewriteNavigationQuery(req, item);
    }

    identityStorage.run({ email }, () => next());
  };
}
