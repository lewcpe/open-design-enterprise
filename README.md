# open-design-enterprise

Patches and deployment files that run [OpenDesign](https://github.com/nexu-io/open-design)
as one shared, multi-user server behind your OIDC identity provider, with
self-service teams.

This repository contains **only our changes**. OpenDesign itself is third-party
code (Apache-2.0, © its authors). It is pinned as the git submodule `upstream/`
and never edited in this repository.

```
upstream/         git submodule → nexu-io/open-design, pinned to a release tag (unmodified)
UPSTREAM_VERSION  the upstream release upstream/ is pinned to = our version number
patches/          our changes to OpenDesign, as git format-patch files, applied in order
deploy/           docker compose stack: oauth2-proxy (OIDC) + patched OpenDesign + optional Caddy
scripts/          apply-patches.sh / export-patches.sh
.github/          upstream-sync (follow upstream releases) and build (test + publish image)
```

## Versions and images

Our version is the upstream OpenDesign release we are built on. Upstream tags
`open-design-v0.27.0` → `UPSTREAM_VERSION` `0.27.0` → image and release `0.27.0`.

| Image tag | Meaning |
| --- | --- |
| `ghcr.io/lewcpe/open-design-enterprise:0.27.0` | Newest build on upstream 0.27.0. Moves forward when our patches change. |
| `ghcr.io/lewcpe/open-design-enterprise:0.27.0-<sha7>` | Immutable build from our commit `<sha7>`. |
| `ghcr.io/lewcpe/open-design-enterprise:latest` | Newest build overall. |

- **`upstream-sync`** runs every 6 hours, or manually with an optional version. When upstream
  publishes a new release, it does the following:
  - pins `upstream/` to the new tag and re-applies `patches/`
  - commits the new pin and `UPSTREAM_VERSION` to `main`
  - runs the daemon typecheck and the patch tests
  - pushes the image
  - creates the GitHub release `v<version>`

  If the patches no longer apply, it opens an issue that includes the steps to fix them, and
  publishes nothing.
- **`build`** runs on every push to `main` that changes the patches, the pin or the scripts. It
  re-tests the current version, re-publishes its image, and creates release `v<version>` if it
  doesn't exist yet.

Repository settings this needs:
- **Workflow permissions** set to *Read and write* (Settings → Actions → General).
- **`main`** must accept pushes from `github-actions[bot]`.

Set the repository variable `IMAGE_PLATFORMS=linux/amd64,linux/arm64` to also build arm64.
GHCR packages start out private. Make the package public, or run `docker login ghcr.io` on the
server.

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

Only `deploy/` is needed on the server. The image comes from GHCR.

```bash
cp deploy/.env.oidc.example deploy/.env.oidc   # fill in the values, incl. OPEN_DESIGN_VERSION
docker compose -f deploy/docker-compose.oidc.yml --env-file deploy/.env.oidc --profile tls up -d
# or, behind an existing TLS load balancer pointed at 127.0.0.1:4180:
docker compose -f deploy/docker-compose.oidc.yml --env-file deploy/.env.oidc up -d
```

To upgrade, change `OPEN_DESIGN_VERSION`, then run `docker compose ... pull && docker compose ... up -d`.

To build the image yourself from this repository:

```bash
git clone --recurse-submodules https://github.com/lewcpe/open-design-enterprise.git
cd open-design-enterprise && scripts/apply-patches.sh
docker compose -f deploy/docker-compose.oidc.yml -f deploy/docker-compose.build.yml \
  --env-file deploy/.env.oidc up -d --build
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

## Moving to a newer upstream by hand

`upstream-sync` does this automatically. Do it by hand only when the patches conflict, for
example for upstream `0.28.0`:

```bash
scripts/apply-patches.sh
git -C upstream fetch origin tag open-design-v0.28.0
git -C upstream rebase --onto open-design-v0.28.0 "$(git ls-tree HEAD upstream | awk '{print $3}')"
# resolve conflicts in the patch commits, then:
scripts/export-patches.sh open-design-v0.28.0   # exports patches and stages the new upstream pin
echo 0.28.0 > UPSTREAM_VERSION && git add UPSTREAM_VERSION
git commit -m "chore: track upstream open-design v0.28.0" && git push   # build publishes :0.28.0
```

The push runs `build`, which publishes `:0.28.0` and creates release `v0.28.0`.

Never `git add upstream` by hand while the patches are applied. That would pin the *patched*
commit, which exists only on your machine.

## License

OpenDesign is licensed under Apache-2.0 by its authors; see `upstream/LICENSE`. The patches in
`patches/` modify that code and are distributed under the same license.
