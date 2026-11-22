// Cloud Run job mode: one container execution runs one submission task.
//
// Flow, all over outbound HTTPS to Base44's botBridge:
//   get_task → run the portal adapter → status updates → screenshots while a
//   person must act → poll for that person's click, SMS code, or final
//   confirmation → result.
//
// Safety rules:
// - The final submit happens only when the task allows it (Base44 live mode),
//   this container allows it (ALLOW_LIVE_SUBMIT=true), AND the person
//   confirmed this specific task after seeing the filled form.
// - Once submission has started, any failure ends as NEEDS_REVIEW (outcome
//   unknown) and is never retried automatically, so an appeal is not sent twice.
// - SMS codes are used once and never logged.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { pickAdapter } = require('../adapters');
const { NotMappedYet, StopBeforeSubmit, HumanTimeout, Cancelled, pageStructure } = require('./common');

const ATTACHMENT_HOSTS = ['base44.app', 'base44.com', 'storage.googleapis.com'];
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// The bot's browser is phone-shaped, so the picture the user sees on a phone
// is nearly life size and boxes like "I'm not a robot" are big enough to tap.
// BOT_VIEWPORT=desktop brings back the wide 1024 px window.
const VIEWPORT = process.env.BOT_VIEWPORT === 'desktop'
  ? { width: 1024, height: 900 }
  : { width: 412, height: 780 };

function hostAllowed(raw) {
  try {
    const u = new URL(raw);
    if (process.env.BOT_TEST_MODE === '1' && u.hostname.startsWith('127.0.0.')) return true; // self-test only
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return ATTACHMENT_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
  } catch { return false; }
}

async function runTask({ bridge, jobId, allowLiveSubmit, timings = {} }) {
  const POLL_MS = timings.pollMs ?? 1000;
  const FRAME_MS = timings.frameMs ?? 1500;
  const HUMAN_TIMEOUT = timings.humanTimeoutMs ?? 5 * 60 * 1000;
  const CONFIRM_TIMEOUT = timings.confirmTimeoutMs ?? 10 * 60 * 1000;
  const TOTAL_TIMEOUT = timings.totalTimeoutMs ?? 20 * 60 * 1000;

  const startedAt = Date.now();
  let submitting = false;
  let browser;
  let page;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `veto-${jobId}-`));

  const status = (s, message, extra = {}) => {
    console.log(`[job ${jobId}] ${s} — ${message}`);
    return bridge.call('status', { status: s, message, ...extra });
  };

  const checkTime = () => {
    if (Date.now() - startedAt > TOTAL_TIMEOUT) throw new HumanTimeout('זמן המשימה הכולל הסתיים');
  };

  // Screenshots are sent scaled down (about 40 KB) so they fit in one Base44
  // record. Taps come back as fractions of the picture, so scale does not
  // change where a tap lands.
  let cdp = null;
  let frameScale = VIEWPORT.width <= 600 ? 1 : 0.6;
  let frameQuality = 45;
  let frameErrors = 0;
  async function capture(fullPage) {
    const vp = page.viewportSize() || VIEWPORT;
    let width = vp.width;
    let height = vp.height;
    if (fullPage) {
      const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })).catch(() => null);
      if (size) { width = Math.min(size.w, 1600); height = Math.min(size.h, 6000); }
    }
    try {
      if (!cdp) cdp = await page.context().newCDPSession(page);
      const r = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: frameQuality,
        captureBeyondViewport: fullPage,
        clip: { x: 0, y: 0, width, height, scale: frameScale },
      });
      return { data: r.data, w: vp.width, h: vp.height };
    } catch {
      const buf = await page.screenshot({ type: 'jpeg', quality: 35, fullPage }).catch(() => null);
      return buf ? { data: buf.toString('base64'), w: vp.width, h: vp.height } : null;
    }
  }

  async function sendFrame(fullPage = false) {
    if (!page) return;
    const shot = await capture(fullPage);
    if (!shot) return;
    try {
      await bridge.call('frame', { data: shot.data, w: shot.w, h: shot.h, full_page: fullPage }, { retries: 1 });
      if (frameErrors) console.log(`[job ${jobId}] צילום מסך נשלח (${Math.round(shot.data.length / 1024)} KB)`);
      frameErrors = 0;
    } catch (err) {
      frameErrors += 1;
      console.log(`[job ${jobId}] צילום מסך לא נשלח (${Math.round(shot.data.length / 1024)} KB): ${String(err.message || err).slice(0, 160)}`);
      // Smaller next time.
      frameScale = Math.max(0.5, frameScale - 0.15);
      frameQuality = Math.max(30, frameQuality - 5);
    }
  }

  async function poll() {
    const r = await bridge.call('poll');
    if (r.cancel) throw new Cancelled();
    return r;
  }

  const task = await bridge.call('get_task');
  const adapter = pickAdapter(task.portal_url);
  try {
    if (!adapter) throw new NotMappedYet('אין לבוט תסריט לפורטל הזה');
    // BROWSER_CHANNEL=chrome uses the computer's installed Google Chrome
    // (local worker on a Mac) instead of Playwright's downloaded Chromium.
    const channel = process.env.BROWSER_CHANNEL === 'chrome' ? { channel: 'chrome' } : {};
    browser = await chromium.launch({ headless: true, args: ['--lang=he-IL'], ...channel });
    const context = await browser.newContext({
      locale: 'he-IL', timezoneId: 'Asia/Jerusalem', viewport: VIEWPORT,
    });
    page = await context.newPage();

    const ctx = {
      page,
      job: task,
      NotMappedYet,
      status: (s, m) => status(s, m),
      log: (m) => status('FILLING_FORM', m),
      recon: async (label) => {
        const data = await pageStructure(page).catch(() => null);
        if (data) await bridge.call('recon', { label, data }).catch(() => {});
      },

      // A person must act in the page (for example tick "I'm not a robot").
      // The bot sends screenshots; the person's taps come back through poll.
      async needHuman(message, isDone) {
        await status('AWAITING_HUMAN', message);
        const end = Date.now() + HUMAN_TIMEOUT;
        let lastFrame = 0;
        while (Date.now() < end) {
          checkTime();
          if (await isDone().catch(() => false)) return;
          if (Date.now() - lastFrame >= FRAME_MS) { await sendFrame(); lastFrame = Date.now(); }
          const r = await poll();
          for (const input of r.inputs || []) {
            if (input.type === 'click') {
              const vp = page.viewportSize();
              const fx = Math.min(Math.max(Number(input.fx) || 0, 0), 1);
              const fy = Math.min(Math.max(Number(input.fy) || 0, 0), 1);
              await page.mouse.click(fx * vp.width, fy * vp.height);
              lastFrame = 0; // show the result of the tap right away
            } else if (input.type === 'scroll') {
              await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(input.dy) || 0)));
              lastFrame = 0;
            }
          }
          await new Promise((res) => setTimeout(res, POLL_MS));
        }
        throw new HumanTimeout('הזמן לפעולה הידנית הסתיים');
      },

      // The authority sent a code to the vehicle owner's phone or email.
      async needOtp(message) {
        const expires = new Date(Date.now() + HUMAN_TIMEOUT).toISOString();
        await status('AWAITING_OTP', message, { otp_expires_at: expires });
        const end = Date.now() + HUMAN_TIMEOUT;
        while (Date.now() < end) {
          checkTime();
          const r = await poll();
          if (r.otp) return String(r.otp);
          await new Promise((res) => setTimeout(res, POLL_MS));
        }
        throw new HumanTimeout('קוד האימות לא הוזן בזמן');
      },

      // Right before the final, irreversible submit click.
      async beforeSubmit(summary) {
        await sendFrame(true);
        const live = task.submit_allowed === true && allowLiveSubmit === true;
        if (!live) throw new StopBeforeSubmit(summary || 'הטופס מולא. ההגשה לא בוצעה (מצב בדיקה).');
        await status('READY_TO_SUBMIT', summary || 'הטופס מולא וממתין לאישורך לשליחה', { awaiting_confirmation: true });
        const end = Date.now() + CONFIRM_TIMEOUT;
        while (Date.now() < end) {
          checkTime();
          const r = await poll();
          if (r.confirm === true) {
            submitting = true;
            await status('SUBMITTING', 'שולח את הבקשה לרשות');
            return;
          }
          await new Promise((res) => setTimeout(res, POLL_MS));
        }
        throw new HumanTimeout('לא התקבל אישור לשליחה. הבקשה לא נשלחה.');
      },

      // Downloads the task's attachments to local files for upload fields.
      async attachments() {
        const out = [];
        for (const [i, a] of (task.attachments || []).entries()) {
          if (!hostAllowed(a.url)) continue;
          const res = await fetch(a.url, { signal: AbortSignal.timeout(20000) }).catch(() => null);
          if (!res || !res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > MAX_ATTACHMENT_BYTES) continue;
          const type = (res.headers.get('content-type') || '').split(';')[0];
          const ext = type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : 'jpg';
          const file = path.join(tmpDir, `attachment-${i + 1}.${ext}`);
          fs.writeFileSync(file, buf);
          out.push({ label: a.label || `קובץ ${i + 1}`, path: file, type });
        }
        return out;
      },
    };

    const result = await adapter.run(ctx);
    if (!result || !result.confirmation_number) {
      // Submitted but no receipt seen: never claim success.
      await status('NEEDS_REVIEW', 'הבקשה נשלחה אך לא התקבל אישור קליטה מהרשות', { error_message: 'NO_RECEIPT' });
      return 'NEEDS_REVIEW';
    }
    await sendFrame(true);
    await status('COMPLETED', 'הבקשה נקלטה ברשות', { confirmation_number: String(result.confirmation_number) });
    return 'COMPLETED';
  } catch (err) {
    if (submitting) {
      await status('NEEDS_REVIEW', 'השליחה התחילה ולא ידוע אם הושלמה. לא תישלח שוב אוטומטית.', { error_message: String(err.message || err).slice(0, 300) }).catch(() => {});
      return 'NEEDS_REVIEW';
    }
    if (err instanceof StopBeforeSubmit) { await status('READY_TO_SUBMIT', err.message).catch(() => {}); return 'READY_TO_SUBMIT'; }
    if (err instanceof HumanTimeout) { await status('EXPIRED', err.message).catch(() => {}); return 'EXPIRED'; }
    if (err instanceof Cancelled) { await status('FAILED', err.message, { error_message: 'CANCELLED' }).catch(() => {}); return 'FAILED'; }
    if (err instanceof NotMappedYet) {
      if (page) { const data = await pageStructure(page).catch(() => null); if (data) await bridge.call('recon', { label: 'not-mapped', data }).catch(() => {}); }
      await status('FAILED', err.message, { error_message: 'NOT_MAPPED' }).catch(() => {});
      return 'FAILED';
    }
    console.error(`[job ${jobId}]`, err);
    await status('FAILED', 'הבוט נעצר בשגיאה. הבקשה לא הוגשה.', { error_message: String(err.message || err).slice(0, 300) }).catch(() => {});
    return 'FAILED';
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { runTask };
