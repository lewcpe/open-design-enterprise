// Team management for proxy-authenticated self-hosted deployments
// (OD_PROXY_AUTH=1). Replaces the Vela web console that upstream links to for
// "Create team" / "Manage members": `OD_WORKSPACE_SETTINGS_URL` points the
// existing web entries at the `/team-admin` page served here.

import type { Express, Request, Response } from 'express';
import { LocalTeamError, type LocalTeamStore } from '../collab/local-teams.js';
import { currentProxyEmail } from '../http/proxy-identity.js';
import { TEAM_ADMIN_PAGE_HTML } from './local-teams-page.js';

export interface LocalTeamRoutesDeps {
  getStore: () => LocalTeamStore | null;
  /** Notify open web clients that a workspace's membership changed. */
  onMembershipChanged?: (workspaceId: string) => void;
}

function sendError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

export function registerLocalTeamRoutes(app: Express, deps: LocalTeamRoutesDeps): void {
  const withCaller = (
    handler: (store: LocalTeamStore, email: string, req: Request, res: Response) => void,
  ) => (req: Request, res: Response) => {
    const store = deps.getStore();
    const email = currentProxyEmail();
    if (!store || !email) {
      return sendError(res, 401, 'PROXY_IDENTITY_REQUIRED', 'sign in through the identity proxy');
    }
    try {
      handler(store, email, req, res);
    } catch (error) {
      if (error instanceof LocalTeamError) {
        return sendError(res, error.status, error.code, error.message);
      }
      return sendError(res, 500, 'INTERNAL_ERROR', String(error));
    }
  };

  const requireMember = (store: LocalTeamStore, email: string, teamId: string) => {
    const membership = store.membershipFor(email, teamId);
    if (!membership || membership.workspaceType !== 'team') {
      throw new LocalTeamError(404, 'TEAM_NOT_FOUND', 'team not found');
    }
    return membership;
  };

  // The web client derives sub-pages from the settings URL
  // (/team-admin/team, /team-admin/dashboard?workspace=create, ...); every one
  // renders the same page.
  const sendPage = (_req: Request, res: Response) => {
    res
      .status(200)
      .type('html')
      .set('Cache-Control', 'no-store')
      .set('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
      .send(TEAM_ADMIN_PAGE_HTML);
  };
  app.get('/team-admin', sendPage);
  app.get('/team-admin/*rest', sendPage);

  app.get('/api/local-teams', withCaller((store, email, _req, res) => {
    res.json({ me: email, teams: store.listTeams(email) });
  }));

  app.post('/api/local-teams', withCaller((store, email, req, res) => {
    const team = store.createTeam(email, (req.body as { name?: unknown } | null)?.name);
    res.status(201).json({ team });
  }));

  app.patch('/api/local-teams/:teamId', withCaller((store, email, req, res) => {
    const teamId = String(req.params.teamId);
    store.renameTeam(email, teamId, (req.body as { name?: unknown } | null)?.name);
    deps.onMembershipChanged?.(teamId);
    res.json({ ok: true });
  }));

  app.get('/api/local-teams/:teamId/members', withCaller((store, email, req, res) => {
    const teamId = String(req.params.teamId);
    const membership = requireMember(store, email, teamId);
    res.json({ role: membership.role, members: store.listMembers(teamId) });
  }));

  app.post('/api/local-teams/:teamId/members', withCaller((store, email, req, res) => {
    const teamId = String(req.params.teamId);
    const body = req.body as { email?: unknown; role?: unknown; members?: unknown } | null;
    const items = Array.isArray(body?.members)
      ? (body!.members as Array<{ email?: unknown; role?: unknown }>)
      : [{ email: body?.email, role: body?.role }];
    const results = store.addMembers(email, teamId, items.map((item) => ({
      email: item?.email,
      role: item?.role,
    })));
    if (results.some((result) => result.ok)) deps.onMembershipChanged?.(teamId);
    res.json({ results });
  }));

  app.delete('/api/local-teams/:teamId/members/:email', withCaller((store, email, req, res) => {
    const teamId = String(req.params.teamId);
    store.removeMember(email, teamId, String(req.params.email));
    deps.onMembershipChanged?.(teamId);
    res.json({ ok: true });
  }));
}
