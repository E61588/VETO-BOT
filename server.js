const express = require('express');
const cors = require('cors');

const config = require('./config');
const { requireApiKey } = require('./authMiddleware');
const sessionStore = require('./sessionStore');
const { sendWebhook } = require('./webhook');
const { startAppealSession, submitOtp } = require('./browserAutomation');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// -----------------------------------------------------------------------
// Health check (unauthenticated, useful for container orchestrators)
// -----------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// -----------------------------------------------------------------------
// POST /api/submit-appeal
// -----------------------------------------------------------------------
app.post('/api/submit-appeal', requireApiKey, async (req, res) => {
  const { job_id, municipality_url, appeal_letter, driver_details, webhook_url } = req.body || {};

  const missing = [];
  if (!job_id) missing.push('job_id');
  if (!municipality_url) missing.push('municipality_url');
  if (!driver_details) missing.push('driver_details');
  if (missing.length) {
    return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });
  }

  if (sessionStore.hasSession(job_id)) {
    return res.status(409).json({ error: `A session for job_id "${job_id}" is already in progress` });
  }

  // Respond immediately that the job has been accepted; the heavy lifting
  // (browser automation + webhook) happens asynchronously.
  res.status(202).json({ job_id, status: 'PROCESSING' });

  try {
    const { browser, context, page } = await startAppealSession({
      municipalityUrl: municipality_url,
      appealLetter: appeal_letter,
      driverDetails: driver_details || {},
    });

    sessionStore.createSession(
      job_id,
      { browser, context, page, webhookUrl: webhook_url, municipalityUrl: municipality_url },
      async (expiredJobId) => {
        console.log(`[submit-appeal] job ${expiredJobId} expired waiting for OTP`);
        await sendWebhook(webhook_url, {
          job_id: expiredJobId,
          status: 'EXPIRED',
          message: 'OTP was not submitted within the allotted time window.',
        });
      }
    );

    await sendWebhook(webhook_url, {
      job_id,
      status: 'AWAITING_OTP',
      message: 'OTP has been sent to the driver. Awaiting code submission.',
    });
  } catch (err) {
    console.error(`[submit-appeal] job ${job_id} failed:`, err);
    sessionStore.removeSession(job_id);
    await sendWebhook(webhook_url, {
      job_id,
      status: 'FAILED',
      message: err.message,
    });
  }
});

// -----------------------------------------------------------------------
// POST /api/verify-otp
// -----------------------------------------------------------------------
app.post('/api/verify-otp', requireApiKey, async (req, res) => {
  const { job_id, otp_code } = req.body || {};

  if (!job_id || !otp_code) {
    return res.status(400).json({ error: 'job_id and otp_code are required' });
  }

  const session = sessionStore.getSession(job_id);
  if (!session) {
    return res.status(404).json({
      error: `No active session found for job_id "${job_id}" (it may have expired or already completed)`,
    });
  }

  // Prevent the expiry timer from firing while we're mid-verification.
  sessionStore.removeSession(job_id);

  res.status(202).json({ job_id, status: 'VERIFYING' });

  const { webhookUrl } = session;

  try {
    const { confirmationNumber, screenshotPath } = await submitOtp({
      page: session.page,
      jobId: job_id,
      otpCode: otp_code,
    });

    await sendWebhook(webhookUrl, {
      job_id,
      status: 'COMPLETED',
      confirmation_number: confirmationNumber,
      screenshot_path: screenshotPath,
    });
  } catch (err) {
    console.error(`[verify-otp] job ${job_id} failed:`, err);
    await sendWebhook(webhookUrl, {
      job_id,
      status: 'FAILED',
      message: err.message,
    });
  } finally {
    await sessionStore.closeBrowserSafely(session);
  }
});

// -----------------------------------------------------------------------
// Fallback error handler
// -----------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`VETO bot server listening on port ${config.port}`);
});

// Graceful shutdown: close any lingering browser sessions.
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  console.log('Shutting down, closing any active browser sessions...');
  process.exit(0);
}
