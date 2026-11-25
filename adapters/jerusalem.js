// Jerusalem municipality parking appeal form (jeronlineforms.jerusalem.muni.il).
//
// Mapped so far (checked 2026-11-25 from the public page, nothing submitted):
//   Step 1 "פרטי בעל הרכב/נהג": vehicle number (tel, 8), report number
//   (mask xxxxxxxx-x), first and last name, ID type dropdown (ת.ז. …),
//   ID number, mobile (prefix dropdown 050… + 7 digits, required), landline
//   (optional), email (required), then "המשך".
//   The form has an invisible reCAPTCHA (no box to tick). "המשך" opens a code
//   dialog that can send a 6-digit code by SMS, voice call or email; the
//   email option needs the email field filled.
//   Steps 2-5 (choosing the report, requester, reasons, declaration) are not
//   mapped yet: the adapter records the page structure after the code and
//   stops, so no field is guessed and nothing is sent.

const digits = (v) => String(v || '').replace(/\D/g, '');

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function splitMobile(raw) {
  let d = digits(raw);
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  if (!/^05\d{8}$/.test(d)) return null;
  return { prefix: d.slice(0, 3), rest: d.slice(3) };
}

module.exports = {
  id: 'jerusalem',
  hosts: ['jeronlineforms.jerusalem.muni.il'],

  async run(ctx) {
    const { page, job } = ctx;
    const vehicle = digits(job.vehicle_number);
    const report = digits(job.ticket_number);
    const driver = job.driver_details || {};
    const name = splitName(driver.full_name);
    const id = digits(driver.id_number);
    const mobile = splitMobile(job.contact_phone || driver.phone);
    const email = String(job.contact_email || driver.email || '').trim();

    if (!vehicle || !report) throw new Error('חסרים מספר דוח או מספר רכב');
    if (!name) throw new Error('חסר שם פרטי ושם משפחה של בעל הרכב');
    if (!id) throw new Error('חסר מספר תעודת זהות');
    if (!mobile) throw new Error('חסר מספר טלפון נייד תקין');
    if (!email) throw new Error('חסרה כתובת מייל');

    await ctx.status('BROWSING', 'נכנס לאתר עיריית ירושלים');
    await page.goto(job.portal_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const step = page.locator('app-first-step');
    await step.locator('label', { hasText: "מס' רכב" }).first().waitFor({ timeout: 30000 });

    const field = (label) => step.locator('.p-field').filter({
      has: page.locator('label.field-label', { hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }),
    }).first();
    const pick = async (label, option) => {
      await field(label).locator('.p-dropdown').first().click();
      await page.locator('.p-dropdown-item, .p-dropdown-items li').filter({ hasText: new RegExp(`^\\s*${option.replace(/\./g, '\\.')}\\s*$`) }).first().click();
    };

    await ctx.status('FILLING_FORM', 'ממלא את פרטי הדוח ובעל הרכב');
    await field("מס' רכב").locator('input').fill(vehicle);
    // The report field is a mask (xxxxxxxx-x): typed key by key.
    await field("מס' דוח").locator('input').click();
    await page.keyboard.type(report, { delay: 40 });
    await field('שם פרטי').locator('input').fill(name.first);
    await field('שם משפחה').locator('input').fill(name.last);
    await pick('סוג זיהוי', 'ת.ז.');
    await field("מס' זיהוי").locator('input').fill(id);
    await pick('טלפון נייד', mobile.prefix);
    await page.locator('#cellphone').fill(mobile.rest);
    await field('דוא"ל').locator('input').fill(email);

    // The form checks each field as it is typed; a red message means a value
    // it does not accept (often the report number's check digit).
    await page.waitForTimeout(500);
    const invalid = await step.locator('.p-error, small.p-invalid, .field-error').filter({ hasText: /\S/ }).allInnerTexts().catch(() => []);
    if (invalid.length) {
      await ctx.recon('jerusalem-step1-invalid');
      throw new Error(`הטופס לא קיבל את הפרטים: ${invalid.join(' | ').slice(0, 200)}`);
    }

    await step.locator('button', { hasText: 'המשך' }).first().click();

    // Invisible reCAPTCHA: usually passes on its own. If Google shows a
    // picture challenge, a person solves it (the team, in team mode).
    const challengeVisible = async () => page.locator('iframe[src*="recaptcha/api2/bframe"]').first().isVisible().catch(() => false);
    const dialog = page.locator('otp-dialog .p-dialog, .opt-dialog .p-dialog, p-dialog.opt-dialog .p-dialog').first();
    await Promise.race([
      dialog.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {}),
      page.waitForTimeout(6000).then(async () => {
        if (await challengeVisible()) {
          await ctx.needHuman('Google ביקש לזהות תמונות. יש לפתור את האתגר בחלון', async () => !(await challengeVisible()));
        }
      }),
    ]);
    if (!(await dialog.isVisible().catch(() => false))) {
      await dialog.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    }
    if (!(await dialog.isVisible().catch(() => false))) {
      await ctx.recon('jerusalem-after-step1');
      throw new ctx.NotMappedYet('חלון קוד האימות של ירושלים לא נפתח כצפוי. מבנה העמוד נשמר.');
    }

    // Choose where the code goes: email when the job asks for it.
    const wantEmail = job.otp_channel === 'email';
    const options = dialog.locator('button, [role=button], .option, li').filter({ visible: true });
    const emailOption = options.filter({ hasText: /דוא"ל|דואר אלקטרוני|מייל|mail/i }).first();
    const smsOption = options.filter({ hasText: /SMS|מסרון|הודעה|נייד/i }).first();
    const chosen = wantEmail ? emailOption : smsOption;
    if (await chosen.isVisible().catch(() => false)) {
      await chosen.click();
    } else {
      await ctx.recon('jerusalem-otp-options');
      throw new ctx.NotMappedYet(`לא נמצאה בחלון האפשרות לשלוח קוד ${wantEmail ? 'למייל' : 'ב-SMS'}. מבנה החלון נשמר.`);
    }

    const codeInput = dialog.locator('input[type=tel], input[maxlength="6"]').first();
    await codeInput.waitFor({ state: 'visible', timeout: 20000 });
    const code = await ctx.needOtp(wantEmail
      ? 'עיריית ירושלים שלחה קוד אימות למייל של הצוות'
      : 'עיריית ירושלים שלחה קוד אימות ב-SMS');
    await codeInput.fill(String(code).replace(/\D/g, '').slice(0, 6));
    await dialog.locator('button, [role=button]', { hasText: 'המשך' }).first().click();

    await ctx.status('VERIFYING', 'מאמת את הקוד מול העירייה');
    await dialog.waitFor({ state: 'hidden', timeout: 25000 }).catch(() => {});
    if (await dialog.isVisible().catch(() => false)) {
      const msg = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`העירייה לא אישרה את הקוד: ${msg}`);
    }

    await page.waitForTimeout(1500);
    await ctx.recon('jerusalem-step2');
    throw new ctx.NotMappedYet('האימות עבר. שלב בחירת הדוח והגשת הבקשה בירושלים עוד לא מופה. מבנה העמוד נשמר.');
  },
};
