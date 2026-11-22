const metropark = require('../adapters/metropark');

// The real Metropark adapter, pointed at the local mock of its search page.
const mockMetropark = { ...metropark, id: 'metropark-mock', hosts: ['127.0.0.1'] };

// A full mock portal used to test the job-mode state machine end to end:
// search + human check, SMS code, form with file upload, user approval,
// submit, and the receipt page. Test only.
const fullMock = {
  id: 'full-mock',
  hosts: ['127.0.0.2'],
  async run(ctx) {
    const { page, job } = ctx;
    await ctx.status('BROWSING', 'נכנס לפורטל הבדיקה');
    await page.goto(job.portal_url, { waitUntil: 'domcontentloaded' });
    await ctx.status('FILLING_FORM', 'ממלא מספר דוח ורכב');
    await page.fill('#ticket', job.ticket_number);
    await page.fill('#plate', job.vehicle_number);
    await ctx.needHuman('סמן אימות', async () => ((await page.inputValue('#captcha-token')) || '').length > 10);
    await Promise.all([page.waitForURL(/\/otp/), page.click('#search')]);
    const code = await ctx.needOtp('הזן קוד');
    await page.fill('#otp', code);
    await Promise.all([page.waitForURL(/\/form/), page.click('#verify')]);
    await page.fill('#reason', String(job.appeal_letter || '').slice(0, 500));
    const files = await ctx.attachments();
    if (files.length) await page.setInputFiles('#docs', files.map((f) => f.path));
    await ctx.beforeSubmit('בדיקה: הטופס מולא');
    await Promise.all([page.waitForURL(/\/done/, { timeout: 10000 }), page.click('#submit')]);
    const conf = (await page.textContent('#confirmation').catch(() => '')) || '';
    return { confirmation_number: conf.trim() || null };
  },
};

module.exports = [mockMetropark, fullMock];
