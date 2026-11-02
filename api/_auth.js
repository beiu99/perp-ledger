import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'session';
const DAYS = 30;

const sign = (expires, password) =>
  createHmac('sha256', password).update(`session:${expires}`).digest('hex');

const same = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function passwordMatches(entered, password = process.env.SITE_PASSWORD) {
  if (!password || typeof entered !== 'string') return false;
  const key = 'compare';
  return same(createHmac('sha256', key).update(entered).digest('hex'), createHmac('sha256', key).update(password).digest('hex'));
}

export function sessionCookie(password = process.env.SITE_PASSWORD, now = Date.now()) {
  const expires = now + DAYS * 86_400_000;
  const value = `${expires}.${sign(expires, password)}`;
  const secure = process.env.NODE_ENV === 'development' ? '' : ' Secure;';
  return `${COOKIE}=${value}; Path=/;${secure} HttpOnly; SameSite=Strict; Max-Age=${DAYS * 86_400}`;
}

export function isSignedIn(req, password = process.env.SITE_PASSWORD, now = Date.now()) {
  if (!password) return false;
  const match = (req.headers.cookie ?? '').match(/(?:^|;\s*)session=(\d+)\.([0-9a-f]+)/);
  if (!match) return false;
  const [, expires, signature] = match;
  return Number(expires) > now && same(signature, sign(expires, password));
}

// Returns true when the request may continue. Otherwise it has already answered.
export function requireSession(req, res) {
  if (isSignedIn(req)) return true;
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: 'Sign in again.' }));
  return false;
}
