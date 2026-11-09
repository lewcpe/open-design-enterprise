# open-design-enterprise

Patches and deployment files that run [OpenDesign](https://github.com/nexu-io/open-design)
as one shared, multi-user server behind your OIDC identity provider, with
self-service teams.

This repository contains **only our changes**. OpenDesign itself is third-party
code (Apache-2.0, © its authors). It is pinned as the git submodule `upstream/`
and never edited in this repository.

```
upstream/   git submodule → nexu-io/open-design at a pinned commit (unmodified)
patches/    our changes to OpenDesign, as git format-patch files, applied in order
deploy/     docker compose stack: oauth2-proxy (OIDC) + patched OpenDesign + optional Caddy
scripts/    apply-patches.sh / export-patches.sh
```

## What the patch adds

When the daemon runs with `OD_PROXY_AUTH=1`, it does the following. With the flag unset, the
patched build behaves exactly like upstream.

- **Identity from the proxy.** Each user's identity is the email that oauth2-proxy verified and
  forwarded in `X-Forwarded-Email`. Workspace headers sent by the client are thrown away and
  rebuilt on the server.
- **Workspaces.** Every user gets a private **Personal** workspace. Users can **create teams**
  and add colleagues by email at `/team-admin`, or through the existing Invite dialog.
- **Sharing.** A project shared with a team is **read-only** for teammates, who can
  **Duplicate** it. This reuses upstream's local workspace model.
- **Storage.** Teams are stored in the daemon's SQLite database. No Vela/Nexu cloud service is
  needed.
- **Shared settings.** Only `OD_ADMIN_EMAILS` may change shared settings: API keys, agent
  selection, MCP, connectors and project locations.
- **Memory.** The daemon-wide memory store is disabled, so one user's chats never leak into
  another user's prompts.

| Patch | Content |
| --- | --- |
| `0001-feat-daemon-proxy-authenticated-multi-user-mode-with.patch` | Daemon: proxy identity middleware, local team store, `/api/local-teams`, `/team-admin` page |
| `0002-test-daemon-cover-local-team-store-and-proxy-identit.patch` | Vitest coverage for the above |

## Build and run

```bash
git clone --recurse-submodules https://github.com/lewcpe/open-design-enterprise.git
cd open-design-enterprise
scripts/apply-patches.sh                       # check out pinned upstream/ and apply patches/

cp deploy/.env.oidc.example deploy/.env.oidc   # fill in the values
docker compose -f deploy/docker-compose.oidc.yml --env-file deploy/.env.oidc --profile tls up -d --build
# or, behind an existing TLS load balancer pointed at 127.0.0.1:4180:
docker compose -f deploy/docker-compose.oidc.yml --env-file deploy/.env.oidc up -d --build
```

1. Register a confidential OIDC client with redirect URI `https://<host>/oauth2/callback`.
2. Fill in `deploy/.env.oidc`: `OPEN_DESIGN_PUBLIC_URL`, `OD_ADMIN_EMAILS`, `OIDC_*`,
   `OAUTH2_PROXY_COOKIE_SECRET` and the provider API keys.
3. Open the site, sign in, and use **Create team** in the workspace switcher. It opens
   `/team-admin`. Members you add see the team after they reload.

```
browser ──TLS──► caddy (optional) ──► oauth2-proxy ──► open-design (no published ports)
                                       OIDC login        OD_PROXY_AUTH=1
                                       X-Forwarded-Email  local team directory
```

Daemon settings used by this mode:

| Variable | Meaning |
| --- | --- |
| `OD_PROXY_AUTH=1` | Trust the email asserted by the proxy. Replaces `OD_API_TOKEN`. Non-loopback requests without the header get 401. |
| `OD_PROXY_EMAIL_HEADER` | Header that carries the verified email (default `x-forwarded-email`). |
| `OD_ADMIN_EMAILS` | The only users who may change shared settings. |
| `OD_WORKSPACE_SETTINGS_URL` | Target of the "Create team" and "Manage" links (`<public url>/team-admin`). |

## Security notes

- **Reach the daemon only through oauth2-proxy.** The compose file publishes no daemon port and
  keeps the proxy hop on an internal network. Never use `network_mode: host` for either
  service. Proxied traffic would then look like loopback, and this mode trusts loopback for
  the daemon's own agent subprocesses.
- **Preview iframes skip the proxy login.** They are sandboxed and send no cookies, so
  `/api/projects/*/preview/<scope>/…` bypasses oauth2-proxy. The daemon serves those requests
  only when they carry a valid scope minted by the server.
- **Agents share one OS user.** Agent runs execute as one OS user inside the container. Treat
  everyone allowed to sign in as trusted with respect to each other's files on disk.
- **One replica only (SQLite).** Back up the `open_design_data` volume.
- **No invite emails.** Adding someone grants access immediately. When a member is removed,
  their team projects stay in the team, but nobody can edit them any more.

## Working on the patches

```bash
scripts/apply-patches.sh          # upstream/ = pinned commit + one commit per patch
cd upstream
# edit, then commit (or `git commit --fixup` + `git rebase -i --autosquash` on the patch commits)
cd ..
scripts/export-patches.sh         # rewrite and stage patches/ from the commits in upstream/
git commit
```

Run the daemon tests inside the patched tree (Node 24, pnpm 10.33.2 via Corepack):

```bash
cd upstream && corepack enable && pnpm install --frozen-lockfile
pnpm --filter @open-design/daemon exec vitest run tests/local-teams.test.ts tests/proxy-identity.test.ts
pnpm typecheck
```

## Moving to a newer upstream

```bash
scripts/apply-patches.sh
git -C upstream fetch origin main
git -C upstream rebase origin/main          # resolve conflicts in the patch commits
scripts/export-patches.sh origin/main      # exports patches and stages the new upstream pin
git commit -m "chore: rebase patches onto upstream <sha>"
```

Never `git add upstream` by hand while the patches are applied. That would pin the *patched*
commit, which exists only on your machine.

## License

OpenDesign is licensed under Apache-2.0 by its authors; see `upstream/LICENSE`. The patches in
`patches/` modify that code and are distributed under the same license.
