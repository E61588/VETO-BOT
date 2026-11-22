const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('../config');
const { report } = require('../webhook');
const { LiveView } = require('./liveView');
const { pickAdapter } = require('../adapters');

const { NotMappedYet, StopBeforeSubmit, HumanTimeout, pageStructure } = require('./common');

const jobs = new Map();   // jobId -> job
const queue = [];
let running = 0;

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'EXPIRED', 'READY_TO_SUBMIT']);

function publicState(job) {
  return {
    job_id: job.id,
    status: job.status,
    message: job.message,
    adapter: job.adapterId,
    accepting_input: job.acceptingInput,
    updated_at: job.updatedAt,
  };
}

async function setStatus(job, status, message, extra = {}) {
  job.status = status;
  job.message = message;
  job.updatedAt = new Date().toISOString();
  console.log(`[job ${job.id}] ${status} — ${message}`);
  if (job.live) job.live.broadcast({ type: 'status', status, message, accepting_input: job.acceptingInput });
  await report({ job_id: job.id, status, message, ...extra });
}

function reconDir() {
  const d = path.join(config.dataDir, 'recon');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Records the structure of the current page (field names, labels, buttons,
// step headings). No field values are read, so no personal data is stored.
async function saveRecon(job, label) {
  const data = await pageStructure(job.page);
  const file = path.join(reconDir(), `${job.id}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify({ label, at: new Date().toISOString(), ...data }, null, 2));
  return file;
}

function makeCtx(job) {
  return {
    page: job.page,
    job: job.data,
    NotMappedYet,
    status: (status, message) => setStatus(job, status, message),
    log: (message) => setStatus(job, job.status, message),
    recon: (label) => saveRecon(job, label),

    // Waits until a person finishes a step in the live view (e.g. ticks
    // reCAPTCHA). Input from the viewer is accepted only during this wait.
    async needHuman(message, isDone, { timeoutMs = config.humanStepTimeoutMs } = {}) {
      job.acceptingInput = true;
      await setStatus(job, 'AWAITING_HUMAN', message);
      const end = Date.now() + timeoutMs;
      try {
        while (Date.now() < end) {
          if (job.cancelled) throw new Error('המשימה בוטלה');
          if (await isDone().catch(() => false)) return;
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new HumanTimeout('הזמן לפעולה הידנית הסתיים');
      } finally {
        job.acceptingInput = false;
      }
    },

    // Waits for the SMS / email code the authority sent to the vehicle owner.
    async needOtp(message, { timeoutMs = config.humanStepTimeoutMs } = {}) {
      const expires = new Date(Date.now() + timeoutMs).toISOString();
      const code = new Promise((resolve, reject) => {
        job.otpResolve = resolve;
        job.otpTimer = setTimeout(() => reject(new HumanTimeout('קוד האימות לא הוזן בזמן')), timeoutMs);
      });
      await setStatus(job, 'AWAITING_OTP', message, { otp_expires_at: expires });
      try { return await code; } finally { clearTimeout(job.otpTimer); job.otpResolve = null; }
    },

    // Called by an adapter right before pressing the final submit button.
    async beforeSubmit(summary) {
      if (!(config.allowLiveSubmit && job.data.submit_live === true)) {
        await saveRecon(job, 'ready-to-submit').catch(() => {});
        throw new StopBeforeSubmit(summary || 'הטופס מולא. ההגשה לא בוצעה (מצב בדיקה).');
      }
      await setStatus(job, 'SUBMITTING', 'שולח את הבקשה לרשות');
    },
  };
}

async function runJob(job) {
  running++;
  let browser;
  const timer = setTimeout(() => { job.cancelled = true; }, config.jobTimeoutMs);
  try {
    const adapter = pickAdapter(job.data.portal_url);
    if (!adapter) throw new NotMappedYet('אין לבוט תסריט לפורטל הזה');
    job.adapterId = adapter.id;

    browser = await chromium.launch({ headless: true, args: ['--lang=he-IL'] });
    const context = await browser.newContext({
      locale: 'he-IL',
      timezoneId: 'Asia/Jerusalem',
      viewport: { width: 1024, height: 900 },
    });
    job.page = await context.newPage();
    job.live = new LiveView(job.page, () => job.acceptingInput);
    await job.live.start();

    const result = await adapter.run(makeCtx(job));
    await setStatus(job, 'COMPLETED', 'הבקשה הוגשה', {
      confirmation_number: result?.confirmation_number || null,
    });
  } catch (err) {
    if (err instanceof StopBeforeSubmit) {
      await setStatus(job, 'READY_TO_SUBMIT', err.message);
    } else if (err instanceof HumanTimeout) {
      await setStatus(job, 'EXPIRED', err.message);
    } else if (err instanceof NotMappedYet) {
      if (job.page) await saveRecon(job, 'not-mapped').catch(() => {});
      await setStatus(job, 'FAILED', err.message, { error_message: 'NOT_MAPPED' });
    } else {
      console.error(`[job ${job.id}]`, err);
      await setStatus(job, 'FAILED', 'הבוט נעצר בשגיאה. הבקשה לא הוגשה.', { error_message: String(err.message || err).slice(0, 300) });
    }
  } finally {
    clearTimeout(timer);
    job.acceptingInput = false;
    if (job.live) await job.live.stop().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    job.page = null;
    running--;
    // Keep the state briefly for status polling, then forget the job.
    setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000);
    pump();
  }
}

function pump() {
  while (running < config.maxConcurrentJobs && queue.length) {
    const job = queue.shift();
    runJob(job);
  }
}

function startJob(id, data) {
  if (jobs.has(id)) return { error: 'job already exists' };
  const job = { id, data, status: 'QUEUED', message: 'ממתין לבוט', acceptingInput: false, updatedAt: new Date().toISOString() };
  jobs.set(id, job);
  queue.push(job);
  report({ job_id: id, status: 'PENDING', message: 'המשימה התקבלה בבוט' });
  pump();
  return { job: publicState(job) };
}

function submitOtp(id, code) {
  const job = jobs.get(id);
  if (!job) return { error: 'not found', status: 404 };
  if (job.status !== 'AWAITING_OTP' || !job.otpResolve) return { error: 'job is not waiting for a code', status: 409 };
  if (!/^[0-9A-Za-z]{3,10}$/.test(String(code))) return { error: 'bad code', status: 400 };
  job.otpResolve(String(code));
  setStatus(job, 'VERIFYING', 'הקוד התקבל, ממשיך');
  return { ok: true };
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  return true;
}

function getJob(id) { return jobs.get(id) || null; }

function cleanupRecon() {
  try {
    const d = reconDir();
    const cutoff = Date.now() - config.reconRetentionHours * 3600 * 1000;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch { /* ignore */ }
}

module.exports = { startJob, submitOtp, cancel, getJob, publicState, cleanupRecon, TERMINAL };
