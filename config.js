require('dotenv').config();

const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const config = {
  port: toInt(process.env.PORT, 3000),
  // Shared secret with the Base44 app (same value as its BOT_API_KEY secret).
  apiKey: process.env.BOT_API_KEY || '',
  // Base44 webhook that receives job status: https://<app>/functions/automationWebhook
  webhookUrl: process.env.WEBHOOK_URL || '',
  // Final submission is allowed only when this is exactly "true".
  // Otherwise every job stops at READY_TO_SUBMIT, after the last screen is
  // filled and before the submit button is pressed.
  allowLiveSubmit: process.env.ALLOW_LIVE_SUBMIT === 'true',
  maxConcurrentJobs: toInt(process.env.MAX_CONCURRENT_JOBS, 2),
  humanStepTimeoutMs: toInt(process.env.HUMAN_STEP_TIMEOUT_MS, 5 * 60 * 1000),
  jobTimeoutMs: toInt(process.env.JOB_TIMEOUT_MS, 15 * 60 * 1000),
  webhookTimeoutMs: toInt(process.env.WEBHOOK_TIMEOUT_MS, 10000),
  dataDir: process.env.DATA_DIR || '/var/lib/veto-bot',
  // Hours to keep recon files (form structure only, no values).
  reconRetentionHours: toInt(process.env.RECON_RETENTION_HOURS, 72),
};

if (!config.apiKey) {
  console.warn('[config] BOT_API_KEY is not set. Every protected request will be rejected.');
}
if (!config.webhookUrl) {
  console.warn('[config] WEBHOOK_URL is not set. Job status will not reach Base44.');
}

module.exports = config;
