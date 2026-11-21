const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const tokens = require('./engine/tokens');
const runner = require('./engine/jobRunner');
const { pickAdapter } = require('./adapters');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

function requireApiKey(req, res, next) {
  if (!config.apiKey || !tokens.safeEqual(req.get('x-api-key'), config.apiKey)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', live_submit: config.allowLiveSubmit, uptime: Math.round(process.uptime()) });
});

const JOB_ID = /^[A-Za-z0-9_-]{6,64}$/;

function startFromBody(body) {
  const jobId = body.job_id;
  const portalUrl = body.portal_url || body.municipality_url;
  if (!JOB_ID.test(String(jobId || ''))) return { status: 400, error: 'bad job_id' };
  let parsed;
  try { parsed = new URL(portalUrl); } catch { return { status: 400, error: 'bad portal_url' }; }
  const testHttp = process.env.BOT_TEST_MODE === '1' && parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !testHttp) return { status: 400, error: 'portal_url must be https' };
  if (!pickAdapter(portalUrl)) return { status: 422, error: 'no adapter for this portal', code: 'NOT_MAPPED' };

  const dd = body.driver_details || {};
  const data = {
    portal_url: portalUrl,
    ticket_number: body.ticket_number || dd.ticket_number || '',
    vehicle_number: body.vehicle_number || dd.vehicle_number || '',
    driver: {
      full_name: dd.full_name || '', id_number: dd.id_number || '', phone: dd.phone || '',
      email: dd.email || '', address: dd.address || '',
    },
    appeal_letter: String(body.appeal_letter || '').slice(0, 20000),
    attachment_urls: Array.isArray(body.attachment_urls) ? body.attachment_urls.slice(0, 10) : [],
    submit_live: body.submit_live === true,
  };
  const out = runner.startJob(jobId, data);
  if (out.error) return { status: 409, error: out.error };
  return { status: 202, body: out.job };
}

app.post('/api/jobs', requireApiKey, (req, res) => {
  const r = startFromBody(req.body || {});
  res.status(r.status).json(r.body || { error: r.error, code: r.code });
});
// Same contract as the original bot, used by Base44's submitAutomationJob.
app.post('/api/submit-appeal', requireApiKey, (req, res) => {
  const r = startFromBody(req.body || {});
  res.status(r.status).json(r.body || { error: r.error, code: r.code });
});

app.get('/api/jobs/:id', requireApiKey, (req, res) => {
  const job = runner.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(runner.publicState(job));
});

app.post('/api/verify-otp', requireApiKey, (req, res) => {
  const { job_id, otp_code } = req.body || {};
  const r = runner.submitOtp(String(job_id || ''), otp_code);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.status(202).json({ job_id, status: 'VERIFYING' });
});

app.post('/api/jobs/:id/cancel', requireApiKey, (req, res) => {
  res.json({ cancelled: runner.cancel(req.params.id) });
});

// Recon files: page structure captured where an adapter stopped (no values).
const reconDir = path.join(config.dataDir, 'recon');
app.get('/api/recon', requireApiKey, (req, res) => {
  const files = fs.existsSync(reconDir) ? fs.readdirSync(reconDir).sort().slice(-100) : [];
  res.json({ files });
});
app.get('/api/recon/:file', requireApiKey, (req, res) => {
  const name = path.basename(req.params.file);
  const p = path.join(reconDir, name);
  if (!name.endsWith('.json') || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  res.type('application/json').send(fs.readFileSync(p, 'utf8'));
});

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal error' });
});

const server = http.createServer(app);

// Live view: wss://<host>/live?token=<viewer token minted by Base44>
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/live') return socket.destroy();
  const claim = tokens.verify(url.searchParams.get('token'));
  const job = claim && runner.getJob(claim.jobId);
  if (!job || !job.live) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: 'status', status: job.status, message: job.message, accepting_input: job.acceptingInput }));
    job.live.attach(ws);
  });
});

setInterval(() => runner.cleanupRecon(), 60 * 60 * 1000).unref();

server.listen(config.port, '127.0.0.1', () => {
  console.log(`VETO bot listening on 127.0.0.1:${config.port} (live submit: ${config.allowLiveSubmit})`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
