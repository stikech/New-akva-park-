/**
 * Раздача статики (фронтенд и админка) без зависимостей:
 * защита от path traversal, ETag/304, gzip для текстовых типов, кеш в памяти.
 */

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { SECURITY_HEADERS, isHttps } from './http.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.webmanifest']);

export function createStaticServer({ trustProxyHops = 0 } = {}) {
  const cache = new Map(); // абсолютный путь → { mtimeMs, size, body, gz, etag }

  async function load(file) {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;

    const body = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    const entry = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      body,
      gz: COMPRESSIBLE.has(ext) && body.length > 1024 ? gzipSync(body) : null,
      etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
      type: MIME[ext] ?? 'application/octet-stream',
      revalidate: ['.html', '.js', '.css', '.json', '.webmanifest'].includes(ext),
    };
    cache.set(file, entry);
    return entry;
  }

  /**
   * Отдаёт файл `relPath` из `root`. Возвращает false, если файла нет
   * (тогда роутер отвечает 404).
   */
  return async function serveFile(req, res, root, relPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(relPath);
    } catch {
      return false;
    }
    // Нулевой байт, обратные слэши и сегменты «..» (в т.ч. из %2f) — сразу 404,
    // иначе /assets/..%2fpackage.json обходил бы allowlist роутера.
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return false;

    const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
    if (file !== root && !file.startsWith(root + path.sep)) return false;
    // Скрытые файлы (.env, .git…) не отдаём никогда.
    if (path.relative(root, file).split(path.sep).some((part) => part.startsWith('.'))) return false;

    let entry;
    try {
      entry = await load(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return false;
      throw error;
    }
    if (!entry) return false;

    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': entry.type,
      ETag: entry.etag,
      // Имена ассетов без хеша: HTML, JS и CSS браузер сверяет с сервером при каждом
      // открытии (ETag → 304, без повторной загрузки). Иначе после деплоя он мог час
      // держать старый модуль рядом с новым — и импорт падал (кабинет «висел»).
      // Картинки и шрифты меняются редко — их кешируем на час.
      'Cache-Control': entry.revalidate ? 'no-cache' : 'public, max-age=3600, must-revalidate',
      Vary: 'Accept-Encoding',
    };
    if (isHttps(req, trustProxyHops)) {
      // Работаем по HTTPS и только по HTTPS: браузер будет запрещать http-подключения.
      headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    }

    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }

    const useGzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const body = useGzip ? entry.gz : entry.body;
    if (useGzip) headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = body.length;

    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
