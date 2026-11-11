// Local preview: serves index.html and runs api/data.js at /data.json (like Vercel).
// Usage: node dev.js   then open http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path');
const SITE = __dirname;
const PORT = +process.env.PORT || 3000;
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/data.json' || url === '/api/data') {
    delete require.cache[require.resolve(path.join(SITE, 'api/data.js'))];
    const fn = require(path.join(SITE, 'api/data.js'));
    return fn(req, { setHeader: (k, v) => res.setHeader(k, v), status(c) { res.statusCode = c; return this; }, send: (b) => res.end(b) })
      .catch((e) => { res.statusCode = 500; res.end(String(e)); });
  }
  const file = path.join(SITE, url === '/' ? 'index.html' : url);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`AnkSetu preview: http://localhost:${PORT}`));
