// Job-mode tests: a mock Base44 bridge (playing the user) + mock portals.
// Runs real `node job.js` processes, the way Cloud Run will.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const API_KEY = 'job-test-key-0123456789';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

// ── mock portals ───────────────────────────────────────────────────────────
const portalState = { submits: 0, uploads: [], crashOnSubmit: false, noReceipt: false };
const captchaBox = `<div id="captcha" style="position:absolute;left:100px;top:300px;width:300px;height:80px;background:#eee"
 onclick="document.getElementById('captcha-token').value='t'.repeat(40);this.textContent='✓'">אני לא רובוט</div>
<input id="captcha-token" type="hidden">`;
const pages = {
  '/full': `<!doctype html><html dir="rtl"><body><h1>חיפוש דוח</h1>
    <input id="ticket"><input id="plate">${captchaBox}
    <button id="search" style="position:absolute;top:420px" onclick="if(document.getElementById('captcha-token').value)location.href='/otp'">חיפוש</button></body></html>`,
  '/otp': `<!doctype html><html dir="rtl"><body><h1>קוד אימות</h1><input id="otp">
    <button id="verify" onclick="if(document.getElementById('otp').value==='4321')location.href='/form';else document.body.append('קוד שגוי')">אמת</button></body></html>`,
  '/form': `<!doctype html><html dir="rtl"><body><h1>פרטי הבקשה</h1>
    <form method="post" action="/submit" enctype="multipart/form-data">
    <textarea id="reason" name="reason"></textarea><input id="docs" name="docs" type="file" multiple>
    <button id="submit" type="submit">שלח</button></form></body></html>`,
};
const mockMetroparkHtml = `<!doctype html><html dir="rtl"><body>
<form method="post" action="/results"><input id="txtReportId" type="number"><input id="txtLicenseNumber" type="number">
<div id="captcha" style="position:absolute;left:100px;top:300px;width:300px;height:80px;background:#eee"
 onclick="document.getElementById('g-recaptcha-response').value='x'.repeat(40)">אני לא רובוט</div>
<textarea id="g-recaptcha-response" style="display:none"></textarea>
<button type="submit" style="position:absolute;top:420px">חיפוש</button></form></body></html>`;

function portalHandler(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = req.url.split('?')[0];
    if (url === '/files/doc.pdf') { res.setHeader('content-type', 'application/pdf'); return res.end(PDF); }
    if (url === '/files/photo.jpg') { res.setHeader('content-type', 'image/jpeg'); return res.end(JPG); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url === '/submit' && req.method === 'POST') {
      portalState.submits++;
      portalState.uploads.push({ pdf: body.includes(Buffer.from('%PDF-1.4')), jpg: body.includes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) });
      if (portalState.crashOnSubmit) return req.socket.destroy();
      res.statusCode = 302;
      res.setHeader('location', '/done');
      return res.end();
    }
    if (url === '/done') {
      return res.end(portalState.noReceipt ? '<html><body>תודה</body></html>'
        : `<html><body><h1>הבקשה התקבלה</h1><span id="confirmation">REF-${portalState.submits}-778</span></body></html>`);
    }
    if (url === '/results') return res.end('<html><body><h2>אישור הגשה</h2><textarea id="reason"></textarea><button>שלח</button></body></html>');
    if (url === '/appeal') return res.end(mockMetroparkHtml);
    res.end(pages[url] || 'not found');
  });
}

// ── mock bridge (Base44 + the user) ────────────────────────────────────────
const jobs = new Map(); // job_id -> { task, behavior, statuses, inputs, otp, confirm, cancel, frames, recon, failPolls }
function bridgeHandler(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-api-key'] !== API_KEY) { res.statusCode = 401; return res.end('{}'); }
    const b = JSON.parse(raw || '{}');
    const j = jobs.get(b.job_id);
    if (!j) { res.statusCode = 404; return res.end('{}'); }
    switch (b.action) {
      case 'get_task': return res.end(JSON.stringify(j.task));
      case 'status': {
        j.statuses.push(b.status);
        if (b.confirmation_number) j.confirmation = b.confirmation_number;
        if (b.error_message) j.error = b.error_message;
        const bh = j.behavior;
        if (b.status === 'AWAITING_HUMAN' && bh.click !== false) setTimeout(() => j.inputs.push({ type: 'click', fx: 250 / 1024, fy: 340 / 900 }), 300);
        if (b.status === 'AWAITING_OTP' && bh.otp) setTimeout(() => { j.otp = bh.otp; }, 300);
        if (b.status === 'READY_TO_SUBMIT' && b.awaiting_confirmation && bh.confirm) setTimeout(() => { j.confirm = true; }, 300);
        return res.end('{"ok":true}');
      }
      case 'frame': j.frames++; return res.end('{"ok":true}');
      case 'recon': j.recon.push(b.label); return res.end('{"ok":true}');
      case 'poll': {
        if (j.failPolls > 0) { j.failPolls--; res.statusCode = 503; return res.end('{}'); }
        const out = { inputs: j.inputs.splice(0), otp: j.otp || null, confirm: j.confirm === true, cancel: j.cancel === true };
        j.otp = null; j.confirm = false; // consumed once, like the real bridge
        return res.end(JSON.stringify(out));
      }
      default: res.statusCode = 400; return res.end('{}');
    }
  });
}

function listen(server, host) { return new Promise((r) => server.listen(0, host, () => r(server.address().port))); }

function runJob(jobId, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['job.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, BOT_TEST_MODE: '1', JOB_ID: jobId, BOT_V2_API_KEY: API_KEY, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('exit', (code) => resolve({ code, log }));
  });
}

(async () => {
  const portal1 = http.createServer(portalHandler);
  const portal2 = http.createServer(portalHandler);
  const bridge = http.createServer(bridgeHandler);
  const p1 = await listen(portal1, '127.0.0.1');
  const p2 = await listen(portal2, '127.0.0.2');
  const bp = await listen(bridge, '127.0.0.1');
  const BRIDGE_URL = `http://127.0.0.1:${bp}/bridge`;
  const results = [];
  const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

  const fullTask = (over = {}) => ({
    portal_url: `http://127.0.0.2:${p2}/full`, ticket_number: '5512345', vehicle_number: '12345678',
    appeal_letter: 'נימוק לבדיקה', submit_allowed: false,
    attachments: [{ label: 'דוח', url: `http://127.0.0.2:${p2}/files/doc.pdf` }, { label: 'תמונה', url: `http://127.0.0.2:${p2}/files/photo.jpg` }],
    ...over,
  });
  const addJob = (id, task, behavior, extra = {}) => jobs.set(id, { task, behavior, statuses: [], inputs: [], frames: 0, recon: [], failPolls: 0, ...extra });
  const env = (live) => ({ BRIDGE_URL, ALLOW_LIVE_SUBMIT: live ? 'true' : 'false' });

  try {
    // 1. Real Metropark adapter on its mock: human step via screenshots, stops at unmapped step.
    addJob('job_mp_01', { portal_url: `http://127.0.0.1:${p1}/appeal`, ticket_number: '12-345', vehicle_number: '123-45-678' }, {});
    await runJob('job_mp_01', env(false));
    let j = jobs.get('job_mp_01');
    check('Metropark mock: pauses for human, continues after tap, stops NOT_MAPPED',
      j.statuses.includes('AWAITING_HUMAN') && j.statuses.at(-1) === 'FAILED' && j.error === 'NOT_MAPPED', `(${j.statuses.join('>')})`);
    check('Metropark mock: screenshots sent while waiting for the human', j.frames > 0, `(${j.frames})`);
    check('Metropark mock: page structure recorded', j.recon.includes('metropark-after-search'));

    // 2. Test mode: full flow stops before submit, nothing sent.
    const before = portalState.submits;
    addJob('job_test_02', fullTask(), { otp: '4321', confirm: true });
    await runJob('job_test_02', env(true));
    j = jobs.get('job_test_02');
    check('Test mode: CAPTCHA → SMS → upload → stops at READY_TO_SUBMIT', j.statuses.at(-1) === 'READY_TO_SUBMIT' && j.statuses.includes('AWAITING_OTP'), `(${j.statuses.join('>')})`);
    check('Test mode: nothing submitted', portalState.submits === before);

    // 3. Live + user confirms: submitted once, receipt saved, PDF and image uploaded.
    addJob('job_live_03', fullTask({ submit_allowed: true }), { otp: '4321', confirm: true });
    await runJob('job_live_03', env(true));
    j = jobs.get('job_live_03');
    check('Live: COMPLETED with the portal receipt', j.statuses.at(-1) === 'COMPLETED' && /^REF-\d+-778$/.test(j.confirmation || ''), `(${j.confirmation})`);
    check('Live: submitted exactly once', portalState.submits === before + 1);
    const up = portalState.uploads.at(-1) || {};
    check('Live: PDF and image uploaded', up.pdf === true && up.jpg === true);

    // 4. Live but the container is not allowed to submit: stops before submit.
    addJob('job_lock_04', fullTask({ submit_allowed: true }), { otp: '4321', confirm: true });
    const s4 = portalState.submits;
    await runJob('job_lock_04', env(false));
    check('Server lock: no submit without ALLOW_LIVE_SUBMIT', jobs.get('job_lock_04').statuses.at(-1) === 'READY_TO_SUBMIT' && portalState.submits === s4);

    // 5. Live, user never confirms: expires, nothing sent.
    addJob('job_noconf_05', fullTask({ submit_allowed: true }), { otp: '4321', confirm: false });
    const s5 = portalState.submits;
    const t5 = Date.now();
    await runJob('job_noconf_05', { ...env(true), TEST_CONFIRM_TIMEOUT_MS: '3000' });
    check('No approval: EXPIRED and nothing sent', jobs.get('job_noconf_05').statuses.at(-1) === 'EXPIRED' && portalState.submits === s5, `(${Math.round((Date.now() - t5) / 1000)}s)`);

    // 6. Crash during submit: NEEDS_REVIEW, process exits 0 (no automatic re-run).
    portalState.crashOnSubmit = true;
    addJob('job_crash_06', fullTask({ submit_allowed: true }), { otp: '4321', confirm: true });
    const r6 = await runJob('job_crash_06', { ...env(true) });
    portalState.crashOnSubmit = false;
    check('Crash after submit: NEEDS_REVIEW, exit 0 (never retried)', jobs.get('job_crash_06').statuses.at(-1) === 'NEEDS_REVIEW' && r6.code === 0, `(${jobs.get('job_crash_06').statuses.at(-1)}, exit ${r6.code})`);

    // 7. Submitted but no receipt on the page: NEEDS_REVIEW, never "submitted".
    portalState.noReceipt = true;
    addJob('job_norec_07', fullTask({ submit_allowed: true }), { otp: '4321', confirm: true });
    await runJob('job_norec_07', env(true));
    portalState.noReceipt = false;
    check('No receipt: NEEDS_REVIEW, not marked as submitted', jobs.get('job_norec_07').statuses.at(-1) === 'NEEDS_REVIEW');

    // 8. Network drops: the first polls fail with 503, the job still completes.
    addJob('job_net_08', fullTask(), { otp: '4321', confirm: true }, { failPolls: 3 });
    await runJob('job_net_08', env(false));
    check('Bridge drops: recovers and finishes', jobs.get('job_net_08').statuses.at(-1) === 'READY_TO_SUBMIT');

    // 9. Two users in parallel: each job gets only its own code.
    addJob('job_par_A9', fullTask(), { otp: '4321', confirm: true });
    addJob('job_par_B9', fullTask(), { otp: '9999', confirm: true }); // wrong code for this portal
    await Promise.all([runJob('job_par_A9', env(false)), runJob('job_par_B9', { ...env(false), TEST_HUMAN_TIMEOUT_MS: '6000' })]);
    const a = jobs.get('job_par_A9').statuses.at(-1);
    const bS = jobs.get('job_par_B9').statuses.at(-1);
    check('Parallel: A finishes, B does not get A\'s code', a === 'READY_TO_SUBMIT' && bS !== 'READY_TO_SUBMIT', `(A ${a}, B ${bS})`);

    // 10. Cancel while waiting for the human.
    addJob('job_cancel_10', fullTask(), { click: false });
    setTimeout(() => { jobs.get('job_cancel_10').cancel = true; }, 4000);
    await runJob('job_cancel_10', env(false));
    check('Cancel: stops with CANCELLED', jobs.get('job_cancel_10').error === 'CANCELLED');
  } catch (e) {
    console.error(e);
    results.push(false);
  } finally {
    portal1.close(); portal2.close(); bridge.close();
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
