// Self-contained team management page served at /team-admin in
// proxy-authenticated mode. Plain HTML + inline script so it needs no web
// build changes; it talks only to the same-origin /api/local-teams routes.

export const TEAM_ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenDesign Teams</title>
<style>
  :root { --bg:#f7f7f5; --panel:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e3e3de; --accent:#2f5bea; --danger:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --panel:#1f1f1d; --text:#ececea; --muted:#a2a29c; --line:#33332f; --accent:#7d9bff; --danger:#ff7b6b; } }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin:0; font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
  .grid { display:grid; grid-template-columns: 260px 1fr; gap: 16px; }
  @media (max-width: 680px) { .grid { grid-template-columns: 1fr; } }
  section { background: var(--panel); border:1px solid var(--line); border-radius: 10px; padding: 16px; }
  ul { list-style:none; margin:0; padding:0; }
  .team { width:100%; text-align:left; background:none; border:1px solid transparent; border-radius:8px; padding:8px 10px; color:inherit; cursor:pointer; font:inherit; }
  .team[aria-current="true"] { border-color: var(--accent); }
  .team small { display:block; color: var(--muted); }
  form { display:flex; gap:8px; flex-wrap:wrap; margin-top: 12px; }
  input, select { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:inherit; min-width:0; }
  input[type=email], input[type=text] { flex: 1 1 180px; }
  button.primary, button.danger { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  button.danger { background:none; color: var(--danger); border-color: var(--line); padding:4px 10px; }
  table { width:100%; border-collapse: collapse; }
  td, th { text-align:left; padding:8px 4px; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
  th { font-weight:600; color: var(--muted); font-size: 12px; }
  #status { min-height: 1.5em; margin: 8px 0 0; }
  #status.error { color: var(--danger); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Teams</h1>
    <span class="muted">Signed in as <strong id="me">…</strong> · <a href="/">Back to OpenDesign</a></span>
  </header>
  <div class="grid">
    <section aria-labelledby="teams-h">
      <h2 id="teams-h">Your teams</h2>
      <ul id="teams"></ul>
      <form id="create">
        <input type="text" id="team-name" placeholder="New team name" maxlength="120" required aria-label="New team name">
        <button class="primary" type="submit">Create</button>
      </form>
    </section>
    <section aria-labelledby="members-h">
      <h2 id="members-h">Members</h2>
      <p id="empty" class="muted">Select or create a team.</p>
      <div id="detail" hidden>
        <table>
          <thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
          <tbody id="members"></tbody>
        </table>
        <form id="add" hidden>
          <input type="email" id="add-email" placeholder="colleague@example.com" required aria-label="Email">
          <select id="add-role" aria-label="Role"><option value="member">Member</option><option value="admin">Admin</option></select>
          <button class="primary" type="submit">Add</button>
        </form>
        <p class="muted">Added colleagues get access immediately. They see the team in OpenDesign's workspace switcher after their next page load.</p>
      </div>
      <p id="status" role="status"></p>
    </section>
  </div>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let me = '';
  let selected = params.get('workspaceId') || null;
  let myRole = 'member';

  function status(text, isError) {
    $('status').textContent = text || '';
    $('status').className = isError ? 'error' : '';
  }
  async function api(path, options) {
    const res = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' }, credentials: 'same-origin' }, options || {}));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body && body.error && (body.error.message || body.error)) || ('HTTP ' + res.status));
    return body;
  }
  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    (children || []).forEach((child) => node.append(child));
    return node;
  }

  async function loadTeams() {
    const data = await api('/api/local-teams');
    me = data.me;
    $('me').textContent = me;
    const list = $('teams');
    list.replaceChildren();
    if (!data.teams.length) list.append(el('li', { className: 'muted', textContent: 'No teams yet.' }));
    data.teams.forEach((team) => {
      const button = el('button', { className: 'team', type: 'button' }, [
        team.name,
        el('small', { textContent: team.role + ' · ' + team.memberCount + (team.memberCount === 1 ? ' member' : ' members') }),
      ]);
      button.setAttribute('aria-current', String(team.id === selected));
      button.addEventListener('click', () => { selected = team.id; history.replaceState(null, '', '?workspaceId=' + encodeURIComponent(team.id)); render(); });
      list.append(el('li', {}, [button]));
    });
    if (selected && !data.teams.some((team) => team.id === selected)) selected = null;
  }

  async function loadMembers() {
    if (!selected) { $('detail').hidden = true; $('empty').hidden = false; return; }
    const data = await api('/api/local-teams/' + encodeURIComponent(selected) + '/members');
    myRole = data.role;
    const manager = myRole === 'owner' || myRole === 'admin';
    $('empty').hidden = true;
    $('detail').hidden = false;
    $('add').hidden = !manager;
    $('add-role').querySelector('option[value=admin]').disabled = myRole !== 'owner';
    const tbody = $('members');
    tbody.replaceChildren();
    data.members.forEach((member) => {
      const self = member.email === me;
      const canRemove = self || (manager && (member.role !== 'owner' || myRole === 'owner'));
      const action = el('td');
      if (canRemove) {
        const remove = el('button', { className: 'danger', type: 'button', textContent: self ? 'Leave' : 'Remove' });
        remove.addEventListener('click', async () => {
          if (!confirm(self ? 'Leave this team?' : 'Remove ' + member.email + '?')) return;
          try {
            await api('/api/local-teams/' + encodeURIComponent(selected) + '/members/' + encodeURIComponent(member.email), { method: 'DELETE' });
            if (self) selected = null;
            status(self ? 'You left the team.' : 'Removed ' + member.email + '.');
            await render();
          } catch (error) { status(error.message, true); }
        });
        action.append(remove);
      }
      tbody.append(el('tr', {}, [el('td', { textContent: member.email + (self ? ' (you)' : '') }), el('td', { textContent: member.role }), action]));
    });
  }

  async function render() {
    try { await loadTeams(); await loadMembers(); } catch (error) { status(error.message, true); }
  }

  $('create').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/local-teams', { method: 'POST', body: JSON.stringify({ name: $('team-name').value }) });
      $('team-name').value = '';
      selected = data.team.id;
      history.replaceState(null, '', '?workspaceId=' + encodeURIComponent(selected));
      status('Team created. Add members below, then reload OpenDesign to switch to it.');
      await render();
    } catch (error) { status(error.message, true); }
  });

  $('add').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/local-teams/' + encodeURIComponent(selected) + '/members', {
        method: 'POST',
        body: JSON.stringify({ email: $('add-email').value, role: $('add-role').value }),
      });
      const result = data.results[0];
      if (result && result.ok) { $('add-email').value = ''; status('Added ' + result.email + '.'); }
      else status('Could not add: ' + ((result && result.error) || 'unknown error'), true);
      await render();
    } catch (error) { status(error.message, true); }
  });

  render().then(() => {
    if (params.get('workspace') === 'create') $('team-name').focus();
    else if (params.get('invite') && !$('add').hidden) $('add-email').focus();
  });
})();
</script>
</body>
</html>
`;
