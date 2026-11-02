// Runs the site on any Node host, and locally with `npm start`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import qfex from './api/qfex.js';
import risex from './api/risex.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const config = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'));
const securityHeaders = config.headers[0].headers;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  for (const { key, value } of securityHeaders) res.setHeader(key, value);
  const { pathname } = new URL(req.url, 'http://local');
  if (pathname === '/api/qfex') return qfex(req, res);
  if (pathname === '/api/risex') return risex(req, res);
  const path = normalize(pathname === '/' ? '/index.html' : pathname);
  try {
    const body = await readFile(join(root, path));
    res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(process.env.PORT ?? 3000, () => {
  console.log(`Perp Ledger on http://localhost:${process.env.PORT ?? 3000}`);
});
