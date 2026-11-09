import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createLocalTeamStore,
  localMemberIdForEmail,
  LocalTeamError,
  normalizeEmail,
  personalWorkspaceIdForEmail,
  type LocalTeamStore,
} from '../src/collab/local-teams.js';
import {
  closeDatabase,
  ensureWorkspaceProject,
  insertProject,
  openDatabase,
} from '../src/db.js';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';

describe('local team store', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let store: LocalTeamStore;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-local-teams-'));
    db = openDatabase(tempDir, { dataDir: path.join(tempDir, '.od') });
    store = createLocalTeamStore(db);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes emails and rejects junk', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe(ALICE);
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it('gives every user exactly one Personal workspace by default', () => {
    const items = store.directoryFor(ALICE);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      workspaceId: personalWorkspaceIdForEmail(ALICE),
      workspaceType: 'personal',
      workspaceMemberId: localMemberIdForEmail(ALICE),
      role: 'owner',
      memberStatus: 'active',
    });
    expect(store.membershipFor(BOB, personalWorkspaceIdForEmail(ALICE))).toBeNull();
  });

  it('creates a team owned by its creator and lists it in the directory', () => {
    const team = store.createTeam(ALICE, ' Design ');
    expect(team).toMatchObject({ name: 'Design', role: 'owner', memberCount: 1 });
    const teamItem = store.directoryFor(ALICE).find((item) => item.workspaceId === team.id);
    expect(teamItem).toMatchObject({ workspaceType: 'team', role: 'owner', workspaceName: 'Design' });
    expect(store.directoryFor(BOB).some((item) => item.workspaceId === team.id)).toBe(false);
    expect(() => store.createTeam(ALICE, '   ')).toThrow(LocalTeamError);
  });

  it('lets owners add admins and members, admins add members only', () => {
    const team = store.createTeam(ALICE, 'Design');
    expect(store.addMembers(ALICE, team.id, [
      { email: BOB, role: 'admin' },
      { email: 'bad' },
    ])).toEqual([
      { email: BOB, ok: true, memberId: localMemberIdForEmail(BOB) },
      { email: 'bad', ok: false, error: 'invalid_email' },
    ]);
    expect(store.addMembers(BOB, team.id, [{ email: CAROL, role: 'admin' }]))
      .toEqual([{ email: CAROL, ok: false, error: 'forbidden' }]);
    expect(store.addMembers(BOB, team.id, [{ email: CAROL }]))
      .toEqual([{ email: CAROL, ok: true, memberId: localMemberIdForEmail(CAROL) }]);
    expect(store.addMembers(ALICE, team.id, [{ email: CAROL }]))
      .toEqual([{ email: CAROL, ok: false, error: 'already_member' }]);
    expect(store.membershipFor(CAROL, team.id)).toMatchObject({ role: 'member' });
    expect(() => store.addMembers(CAROL, team.id, [{ email: 'dave@example.com' }]))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => store.addMembers('eve@example.com', team.id, [{ email: 'x@example.com' }]))
      .toThrow(expect.objectContaining({ status: 404 }));
  });

  it('removes members, allows leaving, and protects the last owner', () => {
    const team = store.createTeam(ALICE, 'Design');
    store.addMembers(ALICE, team.id, [{ email: BOB }, { email: CAROL }]);
    expect(() => store.removeMember(BOB, team.id, CAROL)).toThrow(expect.objectContaining({ status: 403 }));
    store.removeMember(CAROL, team.id, CAROL);
    expect(store.membershipFor(CAROL, team.id)).toBeNull();
    expect(() => store.removeMember(ALICE, team.id, ALICE)).toThrow(expect.objectContaining({ code: 'LAST_OWNER' }));
    store.removeMember(ALICE, team.id, BOB);
    expect(store.listMembers(team.id).map((member) => member.email)).toEqual([ALICE]);
  });

  it('exposes the member directory with emails as display names', () => {
    const team = store.createTeam(ALICE, 'Design');
    store.addMembers(ALICE, team.id, [{ email: BOB }]);
    expect(store.memberDirectory(team.id)).toEqual([
      { memberId: localMemberIdForEmail(ALICE), displayName: ALICE, role: 'owner' },
      { memberId: localMemberIdForEmail(BOB), displayName: BOB, role: 'member' },
    ]);
  });

  it('lists only active team-visible projects of the workspace', () => {
    const team = store.createTeam(ALICE, 'Design');
    const now = Date.now();
    for (const id of ['shared', 'private', 'deleted', 'elsewhere']) {
      insertProject(db, { id, name: id, createdAt: now, updatedAt: now });
    }
    const creator = localMemberIdForEmail(ALICE);
    ensureWorkspaceProject(db, { projectId: 'shared', workspaceId: team.id, visibility: 'team', createdByWorkspaceMemberId: creator });
    ensureWorkspaceProject(db, { projectId: 'private', workspaceId: team.id, visibility: 'personal', createdByWorkspaceMemberId: creator });
    ensureWorkspaceProject(db, { projectId: 'deleted', workspaceId: team.id, visibility: 'team', resourceState: 'deleted', createdByWorkspaceMemberId: creator });
    ensureWorkspaceProject(db, { projectId: 'elsewhere', workspaceId: personalWorkspaceIdForEmail(ALICE), visibility: 'team', createdByWorkspaceMemberId: creator });

    const projects = store.listTeamProjects(team.id);
    expect(projects.map((project) => project.projectId)).toEqual(['shared']);
    expect(projects[0]).toMatchObject({ ownerMemberId: creator, name: 'shared' });
    expect(store.listTeamProjects('t-missing')).toEqual([]);
  });
});
