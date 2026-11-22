// Entry point for Cloud Run job mode: runs one submission task, then exits.
// Required env: JOB_ID (set per execution), BRIDGE_URL, BOT_V2_API_KEY.
// Optional: ALLOW_LIVE_SUBMIT=true to permit the final submit click.
require('dotenv').config();
const { makeBridge } = require('./engine/bridge');
const { runTask } = require('./engine/jobMode');

(async () => {
  const jobId = process.env.JOB_ID || '';
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(jobId)) {
    console.error('JOB_ID is missing or malformed');
    process.exit(2);
  }
  const bridge = makeBridge({
    url: process.env.BRIDGE_URL,
    apiKey: process.env.BOT_V2_API_KEY || process.env.BOT_API_KEY,
    jobId,
  });
  try {
    // Shorter waits for the local self-test only.
    const t = process.env.BOT_TEST_MODE === '1' ? {
      confirmTimeoutMs: Number(process.env.TEST_CONFIRM_TIMEOUT_MS) || undefined,
      humanTimeoutMs: Number(process.env.TEST_HUMAN_TIMEOUT_MS) || undefined,
      pollMs: 300,
      frameMs: 500,
    } : {};
    const outcome = await runTask({ bridge, jobId, allowLiveSubmit: process.env.ALLOW_LIVE_SUBMIT === 'true', timings: t });
    console.log(`[job ${jobId}] finished: ${outcome}`);
    // Exit 0 for every handled outcome, so Cloud Run never re-runs a task
    // that may have reached the authority.
    process.exit(0);
  } catch (err) {
    // Only reached if the task could not even be fetched; nothing was submitted.
    console.error(`[job ${jobId}] could not start:`, err.message);
    process.exit(0);
  }
})();
