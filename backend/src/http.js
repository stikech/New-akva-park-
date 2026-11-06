/** Мелкие HTTP-помощники: JSON-ответы, чтение тела, заголовки безопасности, IP клиента. */

export class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body ?? { error: message };
  }
}

/**
 * CSP под текущий фронтенд: Google Fonts, Open-Meteo для погоды.
 * 'unsafe-inline' — только для стилей: slides.js задаёт цвет трассы через style="--c: …".
 * TipTop Pay: скрипт шифрования карты (checkout.js) и его запросы; form-action https: —
 * шаг 3-D Secure отправляет форму на страницу банка покупателя (адрес у каждого банка свой).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://checkout.tiptoppay.kz",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://api.open-meteo.com https://*.tiptoppay.kz",
  "frame-src https://*.tiptoppay.kz",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : payload);
}

/** Читает JSON-тело с лимитом размера. Бросает HttpError 413/415/400. */
export async function readJsonBody(req, { limitBytes = 16 * 1024 } = {}) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new HttpError(415, 'Ожидается Content-Type: application/json');
  }

  const declared = Number(req.headers['content-length']);
  if (declared > limitBytes) throw new HttpError(413, 'Слишком большой запрос');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

/** Cookie запроса как объект. Битые значения пропускаются. */
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // некорректное %-кодирование — игнорируем cookie
    }
  }
  return out;
}

/**
 * Запрос пришёл по HTTPS: напрямую или через доверенный прокси (Render, nginx),
 * который сообщает исходный протокол в X-Forwarded-Proto.
 */
export function isHttps(req, trustProxyHops = 0) {
  if (req.socket.encrypted) return true;
  if (!trustProxyHops) return false;
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

/**
 * Защита от CSRF для изменяющих запросов: браузер всегда шлёт Origin у fetch POST/PATCH/DELETE,
 * и он должен совпадать с хостом сайта. Запросы без Origin (curl, тесты) пропускаем —
 * у них нет чужой cookie. Дополнительно readJsonBody требует application/json,
 * а такой кросс-доменный запрос без CORS браузер не отправит.
 */
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Запрос с чужого сайта');
  }
  const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map((h) => String(h).split(',')[0].trim());
  if (!allowed.includes(host)) throw new HttpError(403, 'Запрос с чужого сайта');
}

/**
 * IP клиента. За прокси берём адрес, который дописал последний доверенный прокси
 * (справа налево), — левые значения X-Forwarded-For клиент может подделать.
 */
export function clientIp(req, trustProxyHops = 0) {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxyHops) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return chain[chain.length - trustProxyHops] ?? chain[0] ?? socketIp;
}
