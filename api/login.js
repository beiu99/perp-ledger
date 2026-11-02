import { isSignedIn, passwordMatches, sessionCookie } from './_auth.js';

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.SITE_PASSWORD) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'Add SITE_PASSWORD in Vercel, then redeploy.' }));
    return;
  }
  if (req.method !== 'POST') {
    res.end(JSON.stringify({ signedIn: isSignedIn(req) }));
    return;
  }
  const body = await readBody(req).catch(() => ({}));
  if (!passwordMatches(body.password)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'That password is not correct.' }));
    return;
  }
  res.setHeader('Set-Cookie', sessionCookie());
  res.end(JSON.stringify({ signedIn: true }));
}
