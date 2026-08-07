import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

createServer(async (request, response) => {
  try {
    const file = join(import.meta.dirname, request.url === '/' ? 'index.html' : request.url.split('?')[0]);
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end('Arquivo não encontrado');
  }
}).listen(4173, '127.0.0.1');

console.log('PreçoCerto disponível em http://127.0.0.1:4173');
