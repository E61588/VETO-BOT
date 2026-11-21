// Metropark (מטרופארק) appeal flow. Serves many authorities; the authority is
// chosen by the AuthorityID query parameter in the portal URL.
//
// Mapped so far (checked 2026-11-22 from an Israeli browser):
//   Step 1 "בקשה לעירעור": #txtReportId (report/case number),
//   #txtLicenseNumber (vehicle number), a visible reCAPTCHA v2 checkbox,
//   and a "חיפוש" (search) button. The checkbox must be ticked by the person
//   in the live view; the bot never solves it.
//   Step 2 "אישור הגשה": not mapped yet. The adapter records the page
//   structure and stops, so no field is guessed.

const digits = (v) => String(v || '').replace(/\D/g, '');

module.exports = {
  id: 'metropark',
  hosts: ['metropark.co.il'],

  async run(ctx) {
    const { page, job } = ctx;
    const ticket = digits(job.ticket_number);
    const vehicle = digits(job.vehicle_number);
    if (!ticket || !vehicle) throw new Error('חסרים מספר דוח או מספר רכב');

    await ctx.status('BROWSING', 'נכנס לאתר מטרופארק');
    await page.goto(job.portal_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#txtReportId', { timeout: 20000 });

    await ctx.status('FILLING_FORM', 'ממלא מספר דוח ומספר רכב');
    await page.fill('#txtReportId', ticket);
    await page.fill('#txtLicenseNumber', vehicle);

    await ctx.needHuman('סמן בחלון את "אני לא רובוט" כדי להמשיך', async () => {
      const token = await page.evaluate(() => document.getElementById('g-recaptcha-response')?.value || '');
      return token.length > 20;
    });

    await ctx.status('FILLING_FORM', 'מחפש את הדוח במערכת');
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      page.locator('button:has-text("חיפוש")').first().click(),
    ]);

    // Search failed: Metropark shows a validation message on the same page.
    const notFound = await page.locator('text=/לא נמצא|לא נמצאו|שגיאה/').first().isVisible().catch(() => false);
    if (notFound) throw new Error('מטרופארק לא מצאה את הדוח לפי מספר הדוח ומספר הרכב');

    await ctx.recon('metropark-after-search');
    throw new ctx.NotMappedYet('שלב הגשת הערעור במטרופארק עוד לא מופה. מבנה העמוד נשמר למיפוי.');
  },
};
