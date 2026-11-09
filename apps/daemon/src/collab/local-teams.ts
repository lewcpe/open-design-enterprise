// Local (self-hosted) team directory for proxy-authenticated deployments.
//
// When OD_PROXY_AUTH=1 the daemon serves many users at once behind an OIDC
// reverse proxy. Identity is the proxy-asserted email; team membership lives in
// two SQLite tables owned by this module instead of the Vela cloud directory.
// Every user implicitly owns one Personal workspace, plus one directory entry
// per team they belong to. The rest of the daemon consumes these entries
// through the existing `WorkspaceDirectoryItem` contract, so the project
// visibility gate and the web workspace UI work unchanged.

import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CollabCloudMemberDirectoryEntry,
  CollabMemberRole,
  TeamProject,
  WorkspaceDirectoryItem,
} from '@open-design/contracts';

type SqliteDb = Database.Database;

export const LOCAL_TEAM_ROLES = ['owner', 'admin', 'member'] as const;
export type LocalTeamRole = (typeof LOCAL_TEAM_ROLES)[number];

const MAX_TEAM_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

export function migrateLocalTeams(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_team_members (
      team_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      added_by_email TEXT,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, email),
      FOREIGN KEY(team_id) REFERENCES local_teams(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_local_team_members_email
      ON local_team_members(email);
  `);
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

function digest(prefix: string, email: string, length: number): string {
  return `${prefix}${createHash('sha256').update(email).digest('hex').slice(0, length)}`;
}

/** Stable, opaque member id for an email (safe in headers, URLs, file names). */
export function localMemberIdForEmail(email: string): string {
  return digest('u-', email, 24);
}

/** Every user's implicit Personal workspace id. */
export function personalWorkspaceIdForEmail(email: string): string {
  return digest('p-', email, 24);
}

export interface LocalTeam {
  id: string;
  name: string;
  createdByEmail: string;
  createdAt: number;
  role: LocalTeamRole;
  memberCount: number;
}

export interface LocalTeamMember {
  email: string;
  memberId: string;
  role: LocalTeamRole;
  addedByEmail: string | null;
  addedAt: number;
}

export class LocalTeamError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalTeamError';
  }
}

function asRole(value: unknown): LocalTeamRole {
  return value === 'owner' || value === 'admin' ? value : 'member';
}

export interface LocalTeamStore {
  directoryFor(email: string): WorkspaceDirectoryItem[];
  /** The caller's directory entry for one workspace, or null if not a member. */
  membershipFor(email: string, workspaceId: string): WorkspaceDirectoryItem | null;
  listTeams(email: string): LocalTeam[];
  createTeam(email: string, name: unknown): LocalTeam;
  renameTeam(email: string, teamId: string, name: unknown): void;
  listMembers(teamId: string): LocalTeamMember[];
  memberDirectory(workspaceId: string): CollabCloudMemberDirectoryEntry[];
  addMembers(
    byEmail: string,
    teamId: string,
    items: Array<{ email: unknown; role?: unknown }>,
  ): Array<{ email: string; ok: boolean; error?: string; memberId?: string }>;
  removeMember(byEmail: string, teamId: string, email: unknown): void;
  listTeamProjects(workspaceId: string): TeamProject[];
}

export function createLocalTeamStore(db: SqliteDb): LocalTeamStore {
  migrateLocalTeams(db);

  const memberRow = (teamId: string, email: string) =>
    db
      .prepare(`SELECT role FROM local_team_members WHERE team_id = ? AND email = ?`)
      .get(teamId, email) as { role: string } | undefined;

  const teamExists = (teamId: string) =>
    Boolean(db.prepare(`SELECT 1 FROM local_teams WHERE id = ?`).get(teamId));

  const requireManager = (byEmail: string, teamId: string): LocalTeamRole => {
    if (!teamExists(teamId)) throw new LocalTeamError(404, 'TEAM_NOT_FOUND', 'team not found');
    const row = memberRow(teamId, byEmail);
    if (!row) throw new LocalTeamError(404, 'TEAM_NOT_FOUND', 'team not found');
    const role = asRole(row.role);
    if (role === 'member') {
      throw new LocalTeamError(403, 'FORBIDDEN', 'only team owners and admins can manage members');
    }
    return role;
  };

  const ownerCount = (teamId: string) =>
    (db
      .prepare(`SELECT COUNT(*) AS n FROM local_team_members WHERE team_id = ? AND role = 'owner'`)
      .get(teamId) as { n: number }).n;

  const parseName = (name: unknown): string => {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > MAX_TEAM_NAME_LENGTH) {
      throw new LocalTeamError(400, 'INVALID_TEAM_NAME', 'team name must be 1-120 characters');
    }
    return value;
  };

  const listTeams = (email: string): LocalTeam[] =>
    (db
      .prepare(
        `SELECT t.id, t.name, t.created_by_email, t.created_at, m.role,
                (SELECT COUNT(*) FROM local_team_members c WHERE c.team_id = t.id) AS member_count
           FROM local_team_members m
           JOIN local_teams t ON t.id = m.team_id
          WHERE m.email = ?
          ORDER BY t.name COLLATE NOCASE, t.id`,
      )
      .all(email) as Array<Record<string, any>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdByEmail: String(row.created_by_email),
      createdAt: Number(row.created_at),
      role: asRole(row.role),
      memberCount: Number(row.member_count),
    }));

  const personalItem = (email: string): WorkspaceDirectoryItem => ({
    workspaceId: personalWorkspaceIdForEmail(email),
    workspaceName: 'Personal',
    workspaceType: 'personal',
    workspaceMemberId: localMemberIdForEmail(email),
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    memberCount: 1,
    isDefault: true,
  });

  const teamItem = (email: string, team: LocalTeam): WorkspaceDirectoryItem => ({
    workspaceId: team.id,
    workspaceName: team.name,
    workspaceType: 'team',
    workspaceMemberId: localMemberIdForEmail(email),
    role: team.role as CollabMemberRole,
    memberStatus: 'active',
    lifecycleState: 'active',
    memberCount: team.memberCount,
  });

  const directoryFor = (email: string): WorkspaceDirectoryItem[] => [
    personalItem(email),
    ...listTeams(email).map((team) => teamItem(email, team)),
  ];

  const listMembers = (teamId: string): LocalTeamMember[] =>
    (db
      .prepare(
        `SELECT email, role, added_by_email, added_at
           FROM local_team_members
          WHERE team_id = ?
          ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, email`,
      )
      .all(teamId) as Array<Record<string, any>>).map((row) => ({
      email: String(row.email),
      memberId: localMemberIdForEmail(String(row.email)),
      role: asRole(row.role),
      addedByEmail: row.added_by_email == null ? null : String(row.added_by_email),
      addedAt: Number(row.added_at),
    }));

  return {
    directoryFor,

    membershipFor(email, workspaceId) {
      if (workspaceId === personalWorkspaceIdForEmail(email)) return personalItem(email);
      const team = listTeams(email).find((entry) => entry.id === workspaceId);
      return team ? teamItem(email, team) : null;
    },

    listTeams,

    createTeam(email, name) {
      const teamName = parseName(name);
      const id = `t-${randomBytes(12).toString('hex')}`;
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO local_teams (id, name, created_by_email, created_at) VALUES (?, ?, ?, ?)`,
        ).run(id, teamName, email, now);
        db.prepare(
          `INSERT INTO local_team_members (team_id, email, role, added_by_email, added_at)
           VALUES (?, ?, 'owner', ?, ?)`,
        ).run(id, email, email, now);
      })();
      return { id, name: teamName, createdByEmail: email, createdAt: now, role: 'owner', memberCount: 1 };
    },

    renameTeam(email, teamId, name) {
      requireManager(email, teamId);
      db.prepare(`UPDATE local_teams SET name = ? WHERE id = ?`).run(parseName(name), teamId);
    },

    listMembers,

    memberDirectory(workspaceId) {
      return listMembers(workspaceId).map((member) => ({
        memberId: member.memberId,
        displayName: member.email,
        role: member.role as CollabMemberRole,
      }));
    },

    addMembers(byEmail, teamId, items) {
      const byRole = requireManager(byEmail, teamId);
      const now = Date.now();
      const upsert = db.prepare(
        `INSERT INTO local_team_members (team_id, email, role, added_by_email, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(team_id, email) DO NOTHING`,
      );
      return items.map((item) => {
        const email = normalizeEmail(item.email);
        if (!email) return { email: String(item.email ?? ''), ok: false, error: 'invalid_email' };
        const role: LocalTeamRole = item.role === 'admin' ? 'admin' : 'member';
        if (role === 'admin' && byRole !== 'owner') {
          return { email, ok: false, error: 'forbidden' };
        }
        const result = upsert.run(teamId, email, role, byEmail, now);
        if (result.changes === 0) return { email, ok: false, error: 'already_member' };
        return { email, ok: true, memberId: localMemberIdForEmail(email) };
      });
    },

    removeMember(byEmail, teamId, rawEmail) {
      const email = normalizeEmail(rawEmail);
      if (!email) throw new LocalTeamError(400, 'INVALID_EMAIL', 'invalid email');
      const target = memberRow(teamId, email);
      if (!target) throw new LocalTeamError(404, 'MEMBER_NOT_FOUND', 'member not found');
      const targetRole = asRole(target.role);
      if (email !== byEmail) {
        const byRole = requireManager(byEmail, teamId);
        if (targetRole === 'owner' && byRole !== 'owner') {
          throw new LocalTeamError(403, 'FORBIDDEN', 'only owners can remove an owner');
        }
      }
      if (targetRole === 'owner' && ownerCount(teamId) <= 1) {
        throw new LocalTeamError(409, 'LAST_OWNER', 'a team must keep at least one owner');
      }
      db.prepare(`DELETE FROM local_team_members WHERE team_id = ? AND email = ?`).run(teamId, email);
    },

    listTeamProjects(workspaceId) {
      if (!teamExists(workspaceId)) return [];
      return (db
        .prepare(
          `SELECT wp.project_id, wp.created_by_workspace_member_id, wp.updated_at AS shared_at,
                  p.name, p.skill_id, p.design_system_id, p.metadata_json,
                  p.created_at, p.updated_at
             FROM workspace_projects wp
             JOIN projects p ON p.id = wp.project_id
            WHERE wp.workspace_id = ?
              AND wp.visibility = 'team'
              AND wp.resource_state = 'active'
            ORDER BY p.updated_at DESC`,
        )
        .all(workspaceId) as Array<Record<string, any>>).map((row) => {
        let metadata: TeamProject['metadata'];
        try {
          metadata = row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined;
        } catch {
          metadata = undefined;
        }
        return {
          projectId: String(row.project_id),
          ownerMemberId: String(row.created_by_workspace_member_id ?? ''),
          sharedAt: new Date(Number(row.shared_at)).toISOString(),
          name: String(row.name),
          skillId: row.skill_id ?? null,
          designSystemId: row.design_system_id ?? null,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          ...(metadata ? { metadata } : {}),
        };
      });
    },
  };
}
