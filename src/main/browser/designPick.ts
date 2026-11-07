import { SENSITIVE_SOURCE } from './pageScripts'

/** The computed styles a design change usually needs. */
export const DESIGN_STYLES = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'gap',
  'flex-direction',
  'justify-content',
  'align-items',
  'grid-template-columns',
  'color',
  'background-color',
  'background-image',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'border',
  'border-radius',
  'box-shadow',
  'opacity'
]

/**
 * Lets the person pick one element: it outlines what's under the pointer, and a click picks it, without reaching the
 * page. Escape, or cancel from Patchbay, stops with nothing. Fixed code, run in Patchbay's isolated world like every
 * other page script, so the page can't see it or what it picked.
 */
export const PICK_SOURCE = String.raw`new Promise((resolve) => {
  if (globalThis.__pbPick) globalThis.__pbPick.cancel();
  const sensitive = ${SENSITIVE_SOURCE};
  const STYLES = ${JSON.stringify(DESIGN_STYLES)};
  const box = document.createElement('div');
  const label = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;outline:2px solid #3d8bfd;background:rgba(61,139,253,.14);border-radius:2px;display:none';
  label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#3d8bfd;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:1px 6px;border-radius:3px;display:none;white-space:nowrap';
  document.documentElement.append(box, label);
  let current = null;
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const selectorOf = (el) => {
    if (el.id) return '#' + esc(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + esc(n.id)); break; }
      let part = n.tagName.toLowerCase();
      const classes = [...n.classList].slice(0, 2).map((c) => '.' + esc(c)).join('');
      part += classes;
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const htmlOf = (el) => {
    const copy = el.cloneNode(true);
    const all = [copy, ...copy.querySelectorAll('*')];
    const originals = [el, ...el.querySelectorAll('*')];
    all.forEach((c, i) => { if (sensitive(originals[i])) { c.removeAttribute('value'); c.textContent = ''; } });
    const html = copy.outerHTML;
    return html.length > 4000 ? html.slice(0, 4000) + '…' : html;
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const styles = {};
    for (const k of STYLES) {
      const v = cs.getPropertyValue(k);
      if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') styles[k] = v;
    }
    return {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      html: htmlOf(el),
      text: sensitive(el) ? '' : (el.innerText || '').trim().slice(0, 300),
      width: r.width,
      height: r.height,
      styles,
      url: location.href,
      title: document.title
    };
  };
  const show = (el) => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    label.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.classList[0] ? '.' + el.classList[0] : '') + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    Object.assign(label.style, { display: 'block', left: Math.max(0, r.left) + 'px', top: Math.max(0, r.top - 20) + 'px' });
  };
  const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label) return;
    current = el;
    show(el);
  };
  const onClick = (e) => { block(e); if (current) done(describe(current)); };
  const onKey = (e) => { if (e.key === 'Escape') { block(e); done(null); } };
  const events = [['mousemove', onMove], ['click', onClick], ['mousedown', block], ['mouseup', block], ['pointerdown', block], ['pointerup', block], ['keydown', onKey]];
  const done = (result) => {
    for (const [name, fn] of events) window.removeEventListener(name, fn, true);
    box.remove();
    label.remove();
    globalThis.__pbPick = null;
    resolve(result);
  };
  for (const [name, fn] of events) window.addEventListener(name, fn, true);
  globalThis.__pbPick = { cancel: () => done(null) };
})`

export const CANCEL_SOURCE = 'globalThis.__pbPick ? (globalThis.__pbPick.cancel(), true) : false'
