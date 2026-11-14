// Read-only CDN probes: reproduce the console 404s and fingerprint the requester.
const https = require('https');

function get(url, maxRedirects = 5) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'krisha-audit/1.0' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, loc: res.headers.location, ct: res.headers['content-type'], body: body.slice(0, 220) }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout' });
    });
  });
}

(async () => {
  const urls = [
    'https://data.jsdelivr.com/v1/package/resolve/npm/@types/es2020@latest',
    'https://data.jsdelivr.com/v1/package/resolve/npm/@types/readline@latest',
    'https://data.jsdelivr.com/v1/package/resolve/npm/@types/stream@latest',
    'https://data.jsdelivr.com/v1/package/resolve/npm/@types/node@latest',
    'https://data.jsdelivr.com/v1/package/resolve/npm/react@latest',
  ];
  for (const u of urls) {
    const r = await get(u);
    console.log(r.status + '  ' + u.replace('https://data.jsdelivr.com', '') + (r.error ? ' ERR:' + r.error : '  ' + (r.body || '').slice(0, 100).replace(/\n/g, ' ')));
  }
  console.log('--- esm.sh behavior for the same specifiers ---');
  for (const u of ['https://esm.sh/@types/readline', 'https://esm.sh/@types/es2020', 'https://esm.sh/readline', 'https://esm.sh/stream']) {
    const r = await get(u);
    console.log(r.status + '  ' + u.replace('https://esm.sh', '') + '  loc=' + (r.loc || '-') + '  ' + (r.body || '').slice(0, 120).replace(/\n/g, ' '));
  }
  process.exit(0);
})();
