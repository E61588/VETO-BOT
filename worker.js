// Local worker: runs on a computer in Israel (for example the owner's Mac)
// until the Cloud Run job is set up. It never accepts inbound connections:
// every few seconds it asks Base44's botBridge for the next queued task,
// runs it exactly like a Cloud Run execution would, then asks again.
//
// Required env: BRIDGE_URL, BOT_V2_API_KEY. Optional: WORKER_NAME,
// ALLOW_LIVE_SUBMIT=true (final submit still needs the user's confirmation
// and Base44 live mode).
require('dotenv').config();
const os = require('os');
const { makeBridge } = require('./engine/bridge');
const { runTask } = require('./engine/jobMode');

const BRIDGE_URL = process.env.BRIDGE_URL;
const API_KEY = process.env.BOT_V2_API_KEY || process.env.BOT_API_KEY;
const WORKER = (process.env.WORKER_NAME || os.hostname()).slice(0, 60);
const TEST = process.env.BOT_TEST_MODE === '1';
const IDLE_MS = TEST ? 300 : 3000;
const MAX_TASKS = TEST ? Number(process.env.WORKER_MAX_TASKS) || 0 : 0; // self-test only

if (!BRIDGE_URL || !API_KEY) {
  console.error('חסרים BRIDGE_URL או BOT_V2_API_KEY בקובץ .env');
  process.exit(2);
}

const claimer = makeBridge({ url: BRIDGE_URL, apiKey: API_KEY, retries: 1 });
let stopping = false;
process.on('SIGINT', () => { stopping = true; console.log('\nעוצר אחרי המשימה הנוכחית...'); });
process.on('SIGTERM', () => { stopping = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('he-IL');

(async () => {
  console.log(`[${stamp()}] הבוט של VETO פועל על המחשב הזה (${WORKER}). להפסקה: Ctrl+C או סגירת החלון.`);
  console.log(`[${stamp()}] שליחה סופית: ${process.env.ALLOW_LIVE_SUBMIT === 'true' ? 'מותרת אחרי אישור המשתמש' : 'חסומה (מצב בדיקה)'}`);
  let done = 0;
  let errors = 0;
  while (!stopping) {
    let jobId = null;
    try {
      const r = await claimer.call('claim', { worker: WORKER });
      jobId = r && r.job_id;
      if (errors) console.log(`[${stamp()}] החיבור ל-VETO חזר`);
      errors = 0;
    } catch (err) {
      errors++;
      if (errors === 1 || errors % 20 === 0) console.error(`[${stamp()}] אין חיבור ל-VETO (${err.message}). מנסה שוב...`);
      await sleep(Math.min(30000, IDLE_MS * 2 ** Math.min(errors, 4)));
      continue;
    }
    if (!jobId) { await sleep(IDLE_MS); continue; }

    console.log(`[${stamp()}] משימה חדשה: ${jobId}`);
    const bridge = makeBridge({ url: BRIDGE_URL, apiKey: API_KEY, jobId });
    const timings = TEST ? {
      confirmTimeoutMs: Number(process.env.TEST_CONFIRM_TIMEOUT_MS) || undefined,
      humanTimeoutMs: Number(process.env.TEST_HUMAN_TIMEOUT_MS) || undefined,
      pollMs: 300,
      frameMs: 500,
    } : {};
    try {
      const outcome = await runTask({ bridge, jobId, allowLiveSubmit: process.env.ALLOW_LIVE_SUBMIT === 'true', timings });
      console.log(`[${stamp()}] משימה ${jobId} הסתיימה: ${outcome}`);
    } catch (err) {
      // get_task failed: nothing was submitted. The job is never retried here.
      console.error(`[${stamp()}] משימה ${jobId} לא התחילה: ${err.message}`);
    }
    done++;
    if (MAX_TASKS && done >= MAX_TASKS) break;
  }
  process.exit(0);
})();
