// Tiny static HTTP server for plugin-integration fixtures.
// Bound to 0.0.0.0 so the headed Chromium running inside xvfb can reach it
// from the same host (chrome connects to http://localhost:PORT).

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.txt':  'text/plain; charset=utf-8',
};

function start({ root, port = 0 }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let url = req.url.split('?')[0];
      if (url === '/' || url === '') url = '/form.html';
      const fp = path.join(root, url.replace(/^\/+/, ''));
      if (!fp.startsWith(root)) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      fs.readFile(fp, (err, data) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found: ' + url);
          return;
        }
        const ext = path.extname(fp).toLowerCase();
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(port, '0.0.0.0', (err) => {
      if (err) return reject(err);
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://localhost:${actual}` });
    });
  });
}

function stop(state) {
  return new Promise((r) => state?.server ? state.server.close(() => r()) : r());
}

module.exports = { start, stop };
