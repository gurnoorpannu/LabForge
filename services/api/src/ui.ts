// Minimal UI: one HTML page + one script. No framework, no build step.
// Script is a separate file so the CSP can forbid inline scripts.

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LabForge</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --muted: #666; --accent: #0b6e4f; --border: #ddd; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #161616; --muted: #999; --accent: #3ccf91; --border: #333; } }
  body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  p.sub { color: var(--muted); margin: 0 0 2rem; }
  button, a.btn { font: inherit; padding: .55rem 1rem; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
  button.primary, a.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: 1rem 0; }
  #msg { color: var(--muted); min-height: 1.5em; }
  #countdown { font-variant-numeric: tabular-nums; font-weight: 600; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<h1>LabForge</h1>
<p class="sub">A temporary Linux terminal in your browser. Wiped when the timer runs out.</p>

<section id="anon" hidden>
  <a class="btn primary" href="/auth/login">Log in with Google</a>
</section>

<section id="user" hidden>
  <div class="row"><span>Signed in as <b id="email"></b></span><button id="logout">Log out</button></div>
  <div id="nolab" hidden class="row"><button id="start" class="primary">Start lab</button></div>
  <div id="haslab" hidden>
    <div class="row"><a id="open" class="btn primary" target="_blank" rel="noopener">Open terminal</a><button id="end">End lab</button></div>
    <p>Expires in <span id="countdown"></span></p>
  </div>
</section>

<p id="msg" role="status"></p>
<script src="/app.js"></script>
</body>
</html>
`;

export const APP_JS = `"use strict";
const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };
const msg = (t) => { $("msg").textContent = t || ""; };
let timer;

async function api(method, path) {
  const res = await fetch(path, { method, credentials: "same-origin" });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { res, body };
}

function renderLab(lab) {
  clearInterval(timer);
  show("nolab", !lab);
  show("haslab", !!lab);
  if (!lab) return;
  $("open").href = lab.url;
  const end = new Date(lab.expiresAt).getTime();
  const tick = () => {
    const s = Math.max(0, Math.round((end - Date.now()) / 1000));
    $("countdown").textContent = Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
    if (s === 0) { clearInterval(timer); renderLab(null); msg("Your lab expired and was wiped."); }
  };
  tick();
  timer = setInterval(tick, 1000);
}

async function load() {
  const me = await api("GET", "/api/me");
  show("anon", me.res.status === 401);
  show("user", me.res.ok);
  if (!me.res.ok) return;
  $("email").textContent = me.body.email || me.body.id;
  const lab = await api("GET", "/api/labs/me");
  renderLab(lab.res.ok ? lab.body : null);
}

$("start").onclick = async () => {
  $("start").disabled = true;
  msg("Starting your lab…");
  const { res, body } = await api("POST", "/api/labs");
  $("start").disabled = false;
  if (res.status === 201 || res.status === 409) { msg(""); renderLab(res.status === 201 ? body : body.lab); return; }
  if (res.status === 503) { msg("All lab slots are busy. Try again in " + (res.headers.get("retry-after") || "60") + "s."); return; }
  if (res.status === 429) { msg("Too many attempts. Wait a minute and try again."); return; }
  msg("Could not start a lab (" + res.status + ").");
};

$("end").onclick = async () => {
  if (!confirm("End your lab? Everything in it is deleted.")) return;
  await api("DELETE", "/api/labs/me");
  renderLab(null);
  msg("Lab ended.");
};

$("logout").onclick = async () => { await api("POST", "/auth/logout"); location.reload(); };

load().catch((e) => msg("Error: " + e.message));
`;
