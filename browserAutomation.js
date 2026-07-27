const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Best-effort generic selectors for municipality appeal forms.
 * Every municipality site is different, so this tries several common
 * patterns (name/id/placeholder/label heuristics) before giving up.
 * Swap these out for site-specific selectors as you onboard each
 * municipality, e.g. via a per-domain selector config/lookup table.
 */
const SELECTORS = {
  idNumber: [
    '#id_number',
    'input[name="id_number"]',
    'input[name*="teudat" i]',
    'input[placeholder*="ID" i]',
  ],
  phone: [
    '#phone',
    'input[name="phone"]',
    'input[name*="mobile" i]',
    'input[type="tel"]',
  ],
  vehicleNumber: [
    '#vehicle_number',
    'input[name="vehicle_number"]',
    'input[name*="vehicle" i]',
    'input[name*="license_plate" i]',
  ],
  ticketNumber: [
    '#ticket_number',
    'input[name="ticket_number"]',
    'input[name*="ticket" i]',
    'input[name*="report_number" i]',
  ],
  appealLetter: [
    '#appeal_letter',
    'textarea[name="appeal_letter"]',
    'textarea[name*="appeal" i]',
    'textarea[name*="reason" i]',
    'textarea',
  ],
  sendOtpButton: [
    'button:has-text("Send OTP")',
    'button:has-text("Send SMS")',
    'button:has-text("Send code")',
    'button:has-text("Verify phone")',
    'text=/send.*(otp|sms|code)/i',
  ],
  otpInput: [
    '#otp',
    '#otp_code',
    'input[name="otp"]',
    'input[name*="otp" i]',
    'input[name*="verification" i]',
    'input[autocomplete="one-time-code"]',
  ],
  otpSubmitButton: [
    'button:has-text("Verify")',
    'button:has-text("Confirm")',
    'button:has-text("Submit")',
    'button[type="submit"]',
  ],
  confirmationNumber: [
    '[data-testid="confirmation-number"]',
    '.confirmation-number',
    'text=/confirmation\\s*(number|#|id)/i',
    'text=/reference\\s*(number|#|id)/i',
  ],
};

/**
 * Try each selector in order until one is found in the DOM (with a short
 * timeout per attempt). Returns the first Locator that resolves, or throws
 * if none of the candidates are found within the overall budget.
 */
async function findFirst(page, candidates, { timeout = 5000 } = {}) {
  const perTry = Math.max(500, Math.floor(timeout / candidates.length));
  for (const selector of candidates) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: perTry });
      return locator;
    } catch (_) {
      // try the next candidate selector
    }
  }
  throw new Error(`Could not locate any element matching candidates: ${candidates.join(', ')}`);
}

async function fillIfPresent(page, candidates, value, fieldLabel) {
  if (value === undefined || value === null || value === '') return;
  try {
    const locator = await findFirst(page, candidates, { timeout: 6000 });
    await locator.fill(String(value));
  } catch (err) {
    throw new Error(`Failed to fill "${fieldLabel}": ${err.message}`);
  }
}

/**
 * Launches a browser, navigates to the municipality form, fills in the
 * driver + appeal details, and clicks the "Send OTP" button. Returns the
 * live browser/context/page objects so they can be stashed in the session
 * store while we wait for the user to supply the OTP.
 */
async function startAppealSession({ municipalityUrl, appealLetter, driverDetails }) {
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(municipalityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await fillIfPresent(page, SELECTORS.idNumber, driverDetails.id_number, 'ID number');
    await fillIfPresent(page, SELECTORS.phone, driverDetails.phone, 'phone');
    await fillIfPresent(
      page,
      SELECTORS.vehicleNumber,
      driverDetails.vehicle_number,
      'vehicle number'
    );
    await fillIfPresent(
      page,
      SELECTORS.ticketNumber,
      driverDetails.ticket_number,
      'ticket number'
    );
    await fillIfPresent(page, SELECTORS.appealLetter, appealLetter, 'appeal letter');

    const sendOtpButton = await findFirst(page, SELECTORS.sendOtpButton, { timeout: 8000 });
    await sendOtpButton.click();

    // Give the site a moment to render the OTP input before we hand control
    // back and wait for the human to supply the code.
    await page
      .waitForSelector(SELECTORS.otpInput.join(', '), { timeout: 8000 })
      .catch(() => {
        // Not fatal - some sites render the OTP field slightly later or
        // via a modal that takes a moment to animate in. verify-otp will
        // re-attempt to locate it.
      });

    return { browser, context, page };
  } catch (err) {
    // Clean up on failure so we never leak a browser process.
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Fills in the OTP code on an already-paused page, submits it, waits for
 * the confirmation screen, extracts a confirmation/reference number, and
 * takes a screenshot for auditing purposes.
 */
async function submitOtp({ page, jobId, otpCode }) {
  const otpInput = await findFirst(page, SELECTORS.otpInput, { timeout: 8000 });
  await otpInput.fill(String(otpCode));

  const submitButton = await findFirst(page, SELECTORS.otpSubmitButton, { timeout: 8000 });
  await submitButton.click();

  // Wait for some kind of navigation/confirmation content to show up.
  await page
    .waitForLoadState('networkidle', { timeout: 15000 })
    .catch(() => {
      // Some sites update via SPA without a full navigation - non-fatal.
    });

  let confirmationNumber = null;
  try {
    const confirmationLocator = await findFirst(page, SELECTORS.confirmationNumber, {
      timeout: 10000,
    });
    const rawText = (await confirmationLocator.textContent())?.trim() || '';
    // Try to pull a number/alphanumeric token out of the matched text.
    const match = rawText.match(/[A-Z0-9-]{5,}/i);
    confirmationNumber = match ? match[0] : rawText || null;
  } catch (err) {
    console.warn(
      `[browserAutomation] job ${jobId}: could not locate confirmation number element: ${err.message}`
    );
  }

  const screenshotPath = path.join(SCREENSHOTS_DIR, `${jobId}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return { confirmationNumber, screenshotPath };
}

module.exports = {
  startAppealSession,
  submitOtp,
};
