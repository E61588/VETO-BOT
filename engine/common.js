// Pieces shared by the two run modes (server mode and Cloud Run job mode).

class NotMappedYet extends Error { constructor(m) { super(m); this.code = 'NOT_MAPPED'; } }
class StopBeforeSubmit extends Error { constructor(m) { super(m); this.code = 'READY_TO_SUBMIT'; } }
class HumanTimeout extends Error { constructor(m) { super(m); this.code = 'EXPIRED'; } }
class Cancelled extends Error { constructor(m) { super(m || 'המשימה בוטלה'); this.code = 'CANCELLED'; } }

// Structure of the current page: field names, labels, buttons, step headings.
// Field values are never read, so no personal data is captured.
async function pageStructure(page) {
  return page.evaluate(() => {
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.innerText.trim();
      }
      const wrap = el.closest('label, .form-group, .p-field, .input-wrapper, div');
      return wrap ? (wrap.querySelector('label')?.innerText || '').trim() : '';
    };
    const fields = [...document.querySelectorAll('input, select, textarea')]
      .filter((e) => e.type !== 'hidden')
      .map((e) => ({
        tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '', name: e.name || '',
        placeholder: e.placeholder || '', label: labelFor(e).slice(0, 80),
        required: e.required || e.getAttribute('aria-required') === 'true',
        visible: !!(e.offsetWidth || e.offsetHeight),
        accept: e.accept || undefined,
        options: e.tagName === 'SELECT' ? [...e.options].slice(0, 30).map((o) => o.text.trim()) : undefined,
      }));
    const buttons = [...document.querySelectorAll('button, input[type=submit], a.btn, [role=button]')]
      .map((b) => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 40);
    const headings = [...document.querySelectorAll('h1, h2, h3, .step-title, .step-text, legend')]
      .map((h) => h.innerText.trim()).filter(Boolean).slice(0, 30);
    return {
      url: location.origin + location.pathname,
      title: document.title,
      headings, buttons, fields,
      captcha: {
        recaptcha: !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, re-captcha, [data-sitekey]'),
        hcaptcha: !!document.querySelector('iframe[src*="hcaptcha"]'),
      },
    };
  });
}

module.exports = { NotMappedYet, StopBeforeSubmit, HumanTimeout, Cancelled, pageStructure };
