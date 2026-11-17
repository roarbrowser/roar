#!/usr/bin/env node
// Files opened from Finder (CFBundleDocumentTypes -> application:openURLs:): a PDF and an HTML file become tabs in
// the active space, the PDF in Chromium's viewer, both while Roar runs and sent the moment a starting Roar takes
// Apple events (a pid-targeted event still lands after Controller::Start; OpenLink's queue covers an earlier one).
// The odoc Apple event goes to the scratch instance's pid, never through LaunchServices, which would hand it to the
// person's own Roar (same bundle id).
//   node tests/open_files_test.mjs <Roar.app>
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpClient, freePort, sleep, until } from './lib/cdp-probe.mjs';

const app = process.argv[2] || 'build/src/Release/Roar.app';
const bin = join(app, 'Contents/MacOS/Roar');
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// kAEOpenDocuments ('aevt'/'odoc') to one pid, as Finder sends it. Resolves false until the app takes Apple events.
function sendOpen(pid, paths) {
  const js = `ObjC.import('Foundation');
    const ev = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
      0x61657674, 0x6f646f63, $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(${pid}), -1, 0);
    const list = $.NSAppleEventDescriptor.listDescriptor;
    ${JSON.stringify(paths)}.forEach((p, i) => list.insertDescriptorAtIndex($.NSAppleEventDescriptor.descriptorWithFileURL($.NSURL.fileURLWithPath(p)), i + 1));
    ev.setParamDescriptorForKeyword(list, 0x2d2d2d2d);
    const err = $();
    const r = ev.sendEventWithOptionsTimeoutError(0x3, 10, err);
    r.isNil() ? 'error ' + err.localizedDescription.js : 'sent';`;
  try { return execFileSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' }).trim(); } catch (e) { return 'error ' + (e.stderr || e.message).trim(); }
}

function start(port) {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-open-files-')));
  const proc = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: String(port), ROAR_DATA_DIR: data }, stdio: 'ignore', detached: true });
  const cdp = cdpClient({ port, data });
  const stop = async () => {
    try { await cdp.sidebar(`ask({cmd:'run',id:'quit'})`, 2000); } catch {}
    for (let i = 0; i < 20 && proc.exitCode === null; i++) await sleep(500);
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    for (let i = 0; i < 50; i++) { try { process.kill(-proc.pid, 0); } catch { break; } await sleep(100); }
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { proc, data, cdp, stop };
}

const tabs = async (cdp) => (await cdp.sidebar(`ask({cmd:'state'})`).catch(() => null))?.tabs || [];

const files = realpathSync(mkdtempSync(join(tmpdir(), 'roar-open-files-docs-')));
const html = join(files, 'Open me.html');
writeFileSync(html, '<!doctype html><title>Roar open-file test</title><h1>Opened from Finder</h1>');
// A one-page PDF with a line of text, offsets computed so the xref is valid.
const pdf = join(files, 'report.pdf');
{
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const text = 'BT /F1 36 Tf 72 700 Td (Roar PDF test) Tj ET';
  objs[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(pdf, out);
}
const url = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');

const ports = [9361, 9362];
const runs = [];
try {
  // 1. Roar already running.
  const warm = start(ports[0]);
  runs.push(warm);
  check(!!(await warm.cdp.waitFor('sidebar', 60000)), 'warm: sidebar up');
  await sleep(1500);
  const sent = await until(async () => sendOpen(warm.proc.pid, [pdf, html]) === 'sent' || undefined, 15000, 500);
  check(!!sent, 'warm: odoc delivered to the scratch pid');
  const got = await until(async () => { const t = await tabs(warm.cdp); return t.some((x) => x.url === url(pdf)) && t.some((x) => x.url === url(html)) && t; }, 20000);
  check(!!got, `warm: both files are tabs (${(got || await tabs(warm.cdp)).map((t) => t.url).join(', ')})`);
  // The state lists the active space's tabs and ghost tabs.
  if (got) check(got.filter((t) => t.url.startsWith('file://')).every((t) => !t.ghost), 'warm: in the active space, not ghost tabs');
  const page = await until(async () => (await warm.cdp.list()).find((t) => t.type === 'page' && t.url === url(html) && t.title === 'Roar open-file test'), 20000);
  check(!!page, 'warm: the HTML file loaded (title from the file)');
  // Chromium's PDF viewer is the PDF extension's page inside the tab.
  const viewer = await until(async () => (await warm.cdp.list()).find((t) => t.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')), 20000);
  check(!!viewer, `warm: PDF viewer target exists (${viewer?.type} ${viewer?.url})`);
  await sleep(2000);
  const shot = join(tmpdir(), 'roar-open-files-pdf.png');
  check(!!(await warm.cdp.screenshot((t) => t.type === 'page' && t.url === url(pdf), shot)), `warm: PDF tab screenshot ${shot}`);
  await warm.stop();
  runs.pop();

  // 2. The file launches Roar: send as soon as the process takes Apple events, before its window exists.
  const cold = start(ports[1]);
  runs.push(cold);
  const coldSent = await until(async () => sendOpen(cold.proc.pid, [pdf]) === 'sent' || undefined, 30000, 50);
  const sidebarAtSend = !!(await cold.cdp.find('sidebar').catch(() => null));
  check(!!coldSent, `cold: odoc delivered (sidebar target up right after delivery: ${sidebarAtSend})`);
  const coldTab = await until(async () => (await tabs(cold.cdp)).find((t) => t.url === url(pdf)), 60000);
  check(!!coldTab, 'cold: the PDF is a tab once Roar is up');
  const n = (await tabs(cold.cdp)).filter((t) => t.url === url(pdf)).length;
  check(n === 1, `cold: opened once (${n})`);
  check(!!(await until(async () => (await cold.cdp.list()).find((t) => t.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')), 20000)), 'cold: PDF viewer target exists');
} finally {
  for (const r of runs) await r.stop();
  rmSync(files, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
