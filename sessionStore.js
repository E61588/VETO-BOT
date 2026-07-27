const config = require('./config');

/**
 * In-memory registry of "paused" Playwright sessions, keyed by job_id.
 *
 * Each entry looks like:
 * {
 *   browser,        // Playwright Browser instance
 *   context,        // Playwright BrowserContext instance
 *   page,           // Playwright Page instance
 *   webhookUrl,     // where to POST status updates for this job
 *   municipalityUrl,
 *   createdAt,      // epoch ms
 *   timeoutHandle,  // setTimeout handle for auto-expiry
 * }
 */
const sessions = new Map();

/**
 * Register a new paused session and arm its expiry timer.
 * If the timer fires before verify-otp is called, the session is closed
 * and removed, and onExpire(jobId) is invoked so the caller can notify
 * the webhook / mark the job as EXPIRED.
 */
function createSession(jobId, sessionData, onExpire) {
  if (sessions.has(jobId)) {
    throw new Error(`A session already exists for job_id "${jobId}"`);
  }

  const timeoutHandle = setTimeout(async () => {
    const existing = sessions.get(jobId);
    if (!existing) return;

    sessions.delete(jobId);

    try {
      await closeBrowserSafely(existing);
    } finally {
      if (typeof onExpire === 'function') {
        onExpire(jobId);
      }
    }
  }, config.otpSessionTimeoutMs);

  sessions.set(jobId, {
    ...sessionData,
    createdAt: Date.now(),
    timeoutHandle,
  });
}

function getSession(jobId) {
  return sessions.get(jobId);
}

function hasSession(jobId) {
  return sessions.has(jobId);
}

/**
 * Remove a session from the map and clear its expiry timer.
 * Does NOT close the browser - call closeBrowserSafely separately if needed.
 */
function removeSession(jobId) {
  const session = sessions.get(jobId);
  if (session) {
    clearTimeout(session.timeoutHandle);
    sessions.delete(jobId);
  }
  return session;
}

async function closeBrowserSafely(session) {
  if (!session) return;
  try {
    if (session.page && !session.page.isClosed()) {
      await session.page.close({ runBeforeUnload: false }).catch(() => {});
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (session.context) {
      await session.context.close().catch(() => {});
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (session.browser) {
      await session.browser.close().catch(() => {});
    }
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  createSession,
  getSession,
  hasSession,
  removeSession,
  closeBrowserSafely,
};
