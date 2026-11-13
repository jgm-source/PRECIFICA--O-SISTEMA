export const SESSION_COOKIE = 'precocerto_session';

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function sessionCookie(token, { maxAge, secure }) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function cookieSecure(request) {
  const setting = process.env.COOKIE_SECURE;
  if (setting === 'true') return true;
  if (setting === 'false') return false;
  const forwarded = request.headers['x-forwarded-proto'];
  if (forwarded) return String(forwarded).split(',')[0].trim() === 'https';
  return process.env.NODE_ENV === 'production';
}

export function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
  return Boolean(host) && url.host === host;
}
