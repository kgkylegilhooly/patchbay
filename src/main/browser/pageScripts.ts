import { LIMITS } from '../../shared/browserPolicy'

/**
 * The only code Patchbay ever runs in a page. It's fixed text written here. What varies travels as JSON arguments, so
 * nothing from an agent or a page can become code. There's no verb that takes a script.
 *
 * It runs in an isolated world: it sees the page's DOM, but has its own JavaScript globals, so a page can't see this
 * code or its element refs, and can't redefine what it calls.
 */
export const WORLD_ID = 4242

/** Whether a field holds something an agent must neither read nor type into. Kept apart so a test can run it directly. */
export const SENSITIVE_SOURCE = String.raw`function sensitive(el) {
  const tag = (el.tagName || '').toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return false;
  const attr = (name) => (el.getAttribute(name) || '').toLowerCase();
  if (attr('type') === 'password') return true;
  if (/(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)(\s|$)/.test(attr('autocomplete'))) return true;
  if (/pass(word|wd|code|phrase)|secret|\bpin\b|\botp\b|\bcvv\b|\bcvc\b|api[-_ ]?key/.test(attr('name') + ' ' + attr('id') + ' ' + attr('aria-label') + ' ' + attr('placeholder'))) return true;
  const masked = typeof getComputedStyle === 'function' ? getComputedStyle(el).webkitTextSecurity : '';
  return !!masked && masked !== 'none';
}`

const RUNTIME = String.raw`(() => {
  if (globalThis.__pb) return;
  const sensitive = ${SENSITIVE_SOURCE};
  const limits = ${JSON.stringify({ name: LIMITS.elementName, value: LIMITS.elementValue, elements: LIMITS.elements })};
  const refs = new Map();
  const ids = new WeakMap();
  let next = 1;
  const refOf = (el) => {
    let ref = ids.get(el);
    if (!ref) {
      ref = 'e' + next++;
      ids.set(el, ref);
      refs.set(ref, new WeakRef(el));
    }
    return ref;
  };
  const byRef = (ref) => {
    const el = refs.get(ref)?.deref();
    return el && el.isConnected ? el : null;
  };
  const clip = (text, most) => {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > most ? s.slice(0, most) + '…' : s;
  };
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[onclick],' +
    '[role=button],[role=link],[role=checkbox],[role=radio],[role=menuitem],[role=tab],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=option]';
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return label;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ').trim();
      if (text) return text;
    }
    if (el.labels?.length) return [...el.labels].map((l) => l.innerText).join(' ');
    return el.innerText || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const item = { ref: refOf(el), tag, name: clip(nameOf(el), limits.name) };
    const role = el.getAttribute('role');
    if (role) item.role = role;
    if (tag === 'a') item.href = clip(el.href, limits.value);
    if (el.disabled) item.disabled = true;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.type) item.type = el.type;
      if (sensitive(el)) item.sensitive = true;
      else if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked;
      else item.value = clip(el.value, limits.value);
    }
    return item;
  };
  const textField = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || el.isContentEditable) return true;
    if (tag !== 'input') return false;
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(el.type);
  };
  globalThis.__pb = {
    read({ maxChars }) {
      const all = [...document.querySelectorAll(INTERACTIVE)].filter(shown);
      const text = (document.body?.innerText ?? '').trim();
      return {
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        elements: all.slice(0, limits.elements).map(describe),
        elementsTotal: all.length,
        framesNotRead: document.querySelectorAll('iframe,frame').length
      };
    },
    locate({ ref }) {
      const el = byRef(ref);
      if (!el) return { problem: 'gone' };
      if (el.disabled) return { problem: 'disabled' };
      if (el.type === 'file') return { problem: 'file-field' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (!(box.width > 0 && box.height > 0) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { problem: 'off-screen' };
      const hit = document.elementFromPoint(x, y);
      const reaches = hit && (hit === el || el.contains(hit) || hit.contains(el) || hit.closest('label')?.control === el);
      if (!reaches) return { problem: 'covered', by: clip(hit ? hit.tagName.toLowerCase() : 'nothing', 40) };
      return { x, y };
    },
    type({ ref, text, clear }) {
      const el = byRef(ref);
      if (!el) return { problem: 'gone' };
      if (el.disabled || el.readOnly) return { problem: 'disabled' };
      if (sensitive(el)) return { problem: 'sensitive' };
      if (el.tagName.toLowerCase() === 'select') {
        const option = [...el.options].find((o) => o.value === text || o.text.trim() === text.trim());
        if (!option) return { problem: 'no-option' };
        el.value = option.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: text.length };
      }
      if (!textField(el)) return { problem: 'not-a-field' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      el.focus();
      if (document.activeElement !== el && !el.contains(document.activeElement)) return { problem: 'no-focus' };
      if (clear) {
        if (el.select) el.select();
        else document.execCommand('selectAll');
        if (!text) document.execCommand('delete');
      }
      if (text && !document.execCommand('insertText', false, text)) return { problem: 'not-typed' };
      return { typed: text.length };
    },
    scroll({ by, to, ref }) {
      if (ref) {
        const el = byRef(ref);
        if (!el) return { problem: 'gone' };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
      } else if (to === 'top') scrollTo({ top: 0, behavior: 'instant' });
      else if (to === 'bottom') scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      else if (by) scrollBy({ top: by, behavior: 'instant' });
      return { scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
    }
  };
})();`

/** The script for one call: the fixed runtime, then one of its fixed methods with its arguments as JSON data. */
export function pageCall(method: 'read' | 'locate' | 'type' | 'scroll', args: Record<string, unknown>): string {
  return `${RUNTIME}\nglobalThis.__pb.${method}(${JSON.stringify(args)});`
}
