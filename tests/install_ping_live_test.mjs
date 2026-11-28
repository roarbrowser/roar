// Install counting (src/install_ping.h, Controller::InstallPing) in a headless scratch Roar against a fake
// Umami: nothing while the welcome page is up, first_seen once it's done (only name, version, os and arch;
// no cookies), nothing on a relaunch, update after a version change (and from "unknown" for a profile
// from before counting), nothing while the switch is off and no backfill after, retry after a 5xx.
// Usage: node tests/install_ping_live_test.mjs <Roar binary>   (scripts/test-install-ping-live.sh)
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, until } from './lib/cdp-probe.mjs';

const [bin] = process.argv.slice(2);
if (!bin) { console.error('usage: install_ping_live_test.mjs <Roar binary>'); process.exit(2); }
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// The fake Umami: records each POST; `status` is what it answers.
const got = [];
let status = 200;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body); } catch {}
    got.push({ path: req.url, method: req.method, cookie: req.headers.cookie, ua: req.headers['user-agent'] || '', json });
    res.writeHead(status, { 'Content-Type': 'application/json' }).end('{}');
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/api/send`;

const dirs = [];
const dir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'roar-ping-'))); dirs.push(d); return d; };
const saved = (d) => { try { return JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).settings || {}; } catch { return {}; } };
const seed = (d, settings) => writeFileSync(join(d, 'state.json'), JSON.stringify({ settings: { onboarded: true, ...settings } }));
async function run(d, fn) {
  const r = await launch({ bin, data: d, env: { ROAR_INSTALL_PING_URL: url } });
  try {
    if (!(await r.cdp.waitFor('sidebar', 30000))) throw new Error('no sidebar');
    await until(async () => (await r.cdp.sidebar(`typeof ask === 'function'`)) === true, 10000);
    await fn(r);
  } finally { await r.stop(); }
}
const set = (r, o) => r.cdp.sidebar(`ask({ cmd: 'settings.set', settings: ${JSON.stringify(o)} }).then(() => 1)`);

let version = '';
try {
  // A new profile: the welcome page is up, so nothing yet.
  const fresh = dir();
  await run(fresh, async (r) => {
    await sleep(3000);
    check(got.length === 0, 'first launch sends nothing while the welcome page is open');
    check(saved(fresh).pingVersion === 'fresh', 'and notes the first launch happened');
    const box = await until(async () => (await r.cdp.send('welcome.html', 'Runtime.evaluate', { expression: `(() => { const b = document.getElementById('ping-on'); return b && JSON.stringify({ on: b.checked, text: b.closest('label').textContent }); })()`, returnByValue: true }))?.result?.value, 10000);
    const w = box ? JSON.parse(box) : {};
    check(w.on === true && /Count this install/.test(w.text || ''), 'the welcome page shows the switch, on');
    await set(r, { onboarded: true });
    const e = await until(async () => got[0], 10000);
    check(!!e, 'finishing the welcome page sends first_seen');
    const p = e?.json?.payload || {};
    version = p.data?.version || '';
    check(e?.path === '/api/send' && e?.method === 'POST' && e?.json?.type === 'event' && p.name === 'first_seen', 'a Umami event named first_seen');
    check(/^\d+\.\d+\.\d+$/.test(version), `with the version (${version})`);
    check(['mac', 'windows'].includes(p.data?.os) && ['arm64', 'x64'].includes(p.data?.arch), `os and arch (${p.data?.os}, ${p.data?.arch})`);
    check(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['data', 'hostname', 'name', 'url', 'website']), `no other fields (${Object.keys(p)})`);
    check(JSON.stringify(Object.keys(p.data || {}).sort()) === JSON.stringify(['arch', 'os', 'version']), 'data holds only version, os and arch');
    check(p.hostname === 'app.roarbrowser.app' && /^[0-9a-f-]{36}$/.test(p.website || ''), 'the Roar site id with the app hostname');
    check(!e?.cookie, 'no cookies sent');
    check(!/Headless/i.test(e?.ua || ''), 'a browser user agent Umami accepts');
    await until(async () => saved(fresh).pingVersion === version, 5000);
    check(saved(fresh).pingVersion === version, 'the version is noted once it is counted');
  });
  check(got.length === 1, 'exactly one event');

  // Same profile, same version: nothing.
  await run(fresh, async () => { await sleep(3000); });
  check(got.length === 1, 'a relaunch on the same version sends nothing');

  // A version change: one update with the version before.
  const s = saved(fresh);
  seed(fresh, { ...s, pingVersion: '1.0.0' });
  got.length = 0;
  await run(fresh, async () => { await until(async () => got[0], 10000); await sleep(1000); });
  const up = got[0]?.json?.payload;
  check(got.length === 1 && up?.name === 'update' && up?.data?.from === '1.0.0' && up?.data?.version === version, 'a new version sends one update with from');
  check(saved(fresh).pingVersion === version, 'and notes the new version');

  // A profile from before install counting (no pingVersion key): an update from "unknown".
  const older = dir();
  writeFileSync(join(older, 'state.json'), JSON.stringify({ settings: { onboarded: true } }));
  got.length = 0;
  await run(older, async () => { await until(async () => got[0], 10000); });
  check(got[0]?.json?.payload?.name === 'update' && got[0]?.json?.payload?.data?.from === 'unknown', 'an older profile sends update from unknown');

  // Switch off: nothing, and that version is never sent later.
  const off = dir();
  seed(off, { pingVersion: '1.0.0', installPing: false });
  got.length = 0;
  await run(off, async () => { await sleep(3000); });
  check(got.length === 0, 'switch off: nothing sent');
  check(saved(off).pingVersion === version, 'and the version is skipped');
  seed(off, { ...saved(off), installPing: true });
  await run(off, async () => { await sleep(3000); });
  check(got.length === 0, 'turning it back on sends nothing for a skipped version');

  // Off on the welcome page before finishing: no first_seen at all.
  const welcomeOff = dir();
  await run(welcomeOff, async (r) => {
    await set(r, { installPing: false });
    await set(r, { onboarded: true });
    await sleep(3000);
  });
  check(got.length === 0, 'turned off on the welcome page: first_seen is never sent');

  // A server error: the next launch tries again.
  const retry = dir();
  seed(retry, { pingVersion: '1.0.0' });
  status = 500;
  await run(retry, async () => { await until(async () => got[0], 10000); await sleep(1000); });
  check(got.length === 1 && saved(retry).pingVersion === '1.0.0', 'a 5xx leaves it for the next launch');
  status = 200;
  got.length = 0;
  await run(retry, async () => { await until(async () => got[0], 10000); await sleep(1000); });
  check(got.length === 1 && saved(retry).pingVersion === version, 'which sends it');

  // Without the test URL a scratch data dir never sends (here the fake would see nothing either way).
  const quiet = dir();
  got.length = 0;
  const r = await launch({ bin, data: quiet });
  try { await r.cdp.waitFor('sidebar', 30000); await set(r, { onboarded: true }); await sleep(3000); } finally { await r.stop(); }
  check(saved(quiet).pingVersion === 'fresh', 'a scratch data dir without the test URL counts nothing');
} catch (e) {
  failed++;
  console.log('FAIL', e.stack || e);
} finally {
  server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? `${failed} failing` : 'all passed');
process.exit(failed ? 1 : 0);
