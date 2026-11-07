'use strict'
// A tiny site on loopback for browser.cjs, so the run needs no outside network. Every page is written here.
const http = require('node:http')

const PROBE = `
<pre id="probe">probe: pending</pre>
<script>
  (async () => {
    const kinds = ['patchbay', 'bridge', 'require', 'process', 'electron', 'ipcRenderer'].map((k) => k + '=' + typeof window[k]).join(' ');
    let rpc = 'not tried';
    const port = new URLSearchParams(location.search).get('control');
    if (port) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"verb":"list"}' });
        rpc = 'status ' + r.status;
      } catch (e) {
        rpc = 'failed';
      }
    }
    const top = window.top === window ? 'self' : 'framed';
    const line = 'probe: ' + kinds + ' top=' + top + ' rpc=' + rpc;
    document.getElementById('probe').textContent = line;
    navigator.sendBeacon('/report', line);
  })();
</script>`

const PAGE = (q) => `<!doctype html><title>Test page</title>
<style>
  body { font: 16px sans-serif; margin: 0; padding: 80px 20px 20px; }
  #add { position: fixed; left: 20px; top: 20px; width: 120px; height: 40px; }
  .tall { height: 3000px; }
</style>
<button id="add" onclick="count.textContent = 'count=' + (++window.n)">Add one</button>
<script>window.n = 0</script>
<p id="count">count=0</p>
<label>Your name <input id="name" name="who"></label>
<label>Password <input id="pw" type="password"></label>
<a href="/two">Go to page two</a>
${q.includes('probe') ? PROBE : ''}
<div class="tall">Long content</div>
<p>Bottom of the page</p>`

const ROUTES = {
  '/page': (q) => PAGE(q),
  '/two': () => '<!doctype html><title>Page two</title><p>Second page here</p>',
  '/store': (q) => `<!doctype html><title>Store</title><script>localStorage.k = new URLSearchParams(location.search).get('v')</script><p>stored</p>`,
  '/show': () => `<!doctype html><title>Show</title><p id="v"></p><script>v.textContent = 'ls=' + (localStorage.k ?? 'none')</script>`,
  '/escape': () => `<!doctype html><title>Escape</title><p>escaping</p><script>
    setTimeout(() => { location.href = 'mycustom-pb://launch' }, 50);
    setTimeout(() => { location.href = 'file:///C:/Windows/win.ini' }, 250);
    setTimeout(() => { window.open('/two') }, 500);
  </script>`
}

function startSite() {
  const reports = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'POST' && url.pathname === '/report') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        reports.push(body)
        res.end()
      })
      return
    }
    const route = ROUTES[url.pathname]
    res.writeHead(route ? 200 : 404, { 'content-type': 'text/html' })
    res.end(route ? route(url.search) : 'not here')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, reports, close: () => server.close() })))
}

module.exports = { startSite }
