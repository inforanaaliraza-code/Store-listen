import { createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

export function verifyPassword(password, encoded) {
  try {
    const [scheme, roundText, saltHex, hashHex] = String(encoded || '').split('$');
    const rounds = Number.parseInt(roundText, 10);
    if (scheme !== 'pbkdf2' || !Number.isInteger(rounds) || rounds < 1000 || rounds > 1_000_000) return false;
    const expected = Buffer.from(hashHex, 'hex');
    if (!expected.length || expected.length > 128) return false;
    const actual = pbkdf2Sync(String(password), Buffer.from(saltHex, 'hex'), rounds, expected.length, 'sha256');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashDeviceSecret(secret) {
  return createHash('sha256').update(String(secret)).digest('hex');
}

export function verifyDeviceSecret(secret, storedHash) {
  const expected = Buffer.from(String(storedHash || ''), 'hex');
  const actual = Buffer.from(hashDeviceSecret(secret), 'hex');
  return expected.length === actual.length && expected.length > 0 && timingSafeEqual(expected, actual);
}

export function createAccessToken(user, secret, now = Math.floor(Date.now() / 1000)) {
  return jwt.sign({
    sub: user.id,
    role: user.role,
    org: user.organization_id,
    iat: now,
  }, secret, { algorithm: 'HS256', expiresIn: '12h' });
}

export function readToken(token, secret) {
  return jwt.verify(token, secret, { algorithms: ['HS256'] });
}

export function tokenFromRequest(request) {
  const authorization = request.get('authorization') || '';
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return request.cookies?.sl_session || '';
}

export function requireAuth({ UserModel, jwtSecret }) {
  return async (request, response, next) => {
    try {
      const token = tokenFromRequest(request);
      if (!token) return response.status(401).json({ detail: 'Authentication required' });
      const payload = readToken(token, jwtSecret);
      const user = await UserModel.findOne({ id: payload.sub, is_active: { $ne: false } }).lean();
      if (!user) return response.status(401).json({ detail: 'Account is inactive' });
      request.user = user;
      return next();
    } catch {
      return response.status(401).json({ detail: 'Invalid or expired session' });
    }
  };
}