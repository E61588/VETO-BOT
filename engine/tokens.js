const crypto = require('crypto');
const config = require('../config');

// Viewer tokens let one job's owner open that job's live view.
// Format: <jobId>.<expEpochSec>.<hmac>. Base44 mints them with the same
// shared secret (BOT_API_KEY) after checking that the caller owns the job.

function sign(jobId, exp) {
  return crypto
    .createHmac('sha256', `viewer:${config.apiKey}`)
    .update(`${jobId}.${exp}`)
    .digest('base64url');
}

function mint(jobId, ttlSec = 15 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${jobId}.${exp}.${sign(jobId, exp)}`;
}

function verify(token) {
  if (!config.apiKey || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [jobId, expStr, mac] = parts;
  const exp = parseInt(expStr, 10);
  if (!jobId || !Number.isFinite(exp) || exp < Date.now() / 1000) return null;
  const expected = sign(jobId, exp);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { jobId, exp };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = { mint, verify, safeEqual };
