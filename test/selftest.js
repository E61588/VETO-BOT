// End-to-end self-test against a local mock of the Metropark search page.
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const API_KEY = 'test-key-1234567890';
const reports = [];
const mockHtml = `<!doctype html><html dir="rtl"><body>
<form method="post" action="/results"><h1>בקשה לעירעור</h1>
<label for="txtReportId">מספר דוח</label><input id="txtReportId" name="reportSearchParams.ReportId" type="number">
<label for="txtLicenseNumber">מספר רכב</label><input id="txtLicenseNumber" name="reportSearchParams.LicenseNumber" type="number">
<div id="captcha" style="position:absolute;left:100px;top:300px;width:300px;height:80px;background:#eee"
 onclick="document.getElementById('g-recaptcha-response').value='x'.repeat(40);this.textContent='✓'">אני לא רובוט</div>
<textarea id="g-recaptcha-response" style="display:none"></textarea>
<button type="submit" style="position:absolute;top:420px">חיפוש</button></form></body></html>`;
const resultsHtml = `<!doctype html><html dir="rtl"><body><h2>אישור הגשה</h2><label for="reason">נימוק</label><textarea id="reason" name="reason"></textarea><button>שלח</button></body></html>`;

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/hook') { reports.push(JSON.parse(body)); res.end('{}'); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url.startsWith('/results') ? resultsHtml : mockHtml);
  });
});

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port;
  const botPort = 39000 + Math.floor(Math.random() * 500);
  const dataDir = fs.mkdtempSync('/tmp/vetobot-');
  const bot = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, BOT_TEST_MODE: '1', PORT: String(botPort), BOT_API_KEY: API_KEY,
      WEBHOOK_URL: `http://127.0.0.1:${mp}/hook`, DATA_DIR: dataDir, HUMAN_STEP_TIMEOUT_MS: '30000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let botLog = '';
  bot.stdout.on('data', (d) => (botLog += d)); bot.stderr.on('data', (d) => (botLog += d));
  await wait(1500);
  const api = (p, opts = {}) => fetch(`http://127.0.0.1:${botPort}${p}`, { ...opts, headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...(opts.headers || {}) } });
  const results = [];
  const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

  try {
    // 1. auth
    const unauth = await fetch(`http://127.0.0.1:${botPort}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('rejects missing api key', unauth.status === 401);
    // 2. unknown portal refused (SSRF / unmapped)
    const bad = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ job_id: 'job_bad_1', portal_url: 'https://evil.example.com/x' }) });
    check('refuses unknown portal', bad.status === 422);
    // 3. start mock metropark job
    const start = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ job_id: 'job_test_1', portal_url: `http://127.0.0.1:${mp}/appeal`, ticket_number: '12-345', vehicle_number: '123-45-678' }) });
    check('job accepted', start.status === 202);

    // wait for AWAITING_HUMAN
    let st;
    for (let i = 0; i < 30; i++) { st = await (await api('/api/jobs/job_test_1')).json(); if (st.status === 'AWAITING_HUMAN') break; await wait(500); }
    check('pauses for the human step', st.status === 'AWAITING_HUMAN' && st.accepting_input === true);

    // live view with a bad token is refused
    const badWs = await new Promise((r) => { const w = new WebSocket(`ws://127.0.0.1:${botPort}/live?token=x.y.z`); w.on('error', () => r('refused')); w.on('open', () => r('open')); });
    check('live view refuses a bad token', badWs === 'refused');

    // mint a valid token the same way Base44 will
    process.env.BOT_API_KEY = API_KEY;
    const tokens = require('../engine/tokens');
    const ws = new WebSocket(`ws://127.0.0.1:${botPort}/live?token=${tokens.mint('job_test_1', 60)}`);
    let frames = 0;
    ws.on('message', (m) => { const j = JSON.parse(m); if (j.type === 'frame') frames++; });
    await new Promise((r) => ws.on('open', r));
    await wait(1500);
    check('live view streams frames', frames > 0, `(${frames} frames)`);
    // click the mock captcha box at (250, 340) in a 1024x900 viewport
    ws.send(JSON.stringify({ type: 'click', fx: 250 / 1024, fy: 340 / 900 }));

    for (let i = 0; i < 40; i++) { st = await (await api('/api/jobs/job_test_1')).json(); if (['FAILED', 'COMPLETED', 'READY_TO_SUBMIT', 'EXPIRED'].includes(st.status)) break; await wait(500); }
    check('continues after the human click and stops at the unmapped step', st.status === 'FAILED' && /לא מופה/.test(st.message), `(${st.status}: ${st.message})`);

    const recon = await (await api('/api/recon')).json();
    const f = recon.files.find((x) => x.includes('job_test_1-metropark-after-search'));
    let reconOk = false;
    if (f) {
      const r = await (await api(`/api/recon/${f}`)).json();
      reconOk = r.fields.some((x) => x.id === 'reason') && !JSON.stringify(r).includes('12345');
    }
    check('recon saved page structure without values', reconOk);
    const seq = reports.filter((r) => r.job_id === 'job_test_1').map((r) => r.status);
    check('reports statuses to the webhook', seq.includes('AWAITING_HUMAN') && seq.includes('FAILED'), `(${[...new Set(seq)].join(' > ')})`);
    ws.close();
  } catch (e) {
    console.error(e); results.push(['exception', false]);
  } finally {
    bot.kill(); mock.close();
    const failed = results.filter((r) => !r[1]).length;
    if (failed) console.log('--- bot log ---\n' + botLog.slice(-3000));
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
