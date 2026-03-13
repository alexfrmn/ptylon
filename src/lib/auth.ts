import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'web-console-jwt-secret-2026';
const JWT_EXPIRY = '7d';

// Password hash stored in .env
const PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH || '';

export async function verifyPassword(password: string): Promise<boolean> {
  if (!PASSWORD_HASH) return false;
  return bcrypt.compare(password, PASSWORD_HASH);
}

export function signToken(): string {
  return jwt.sign({ user: 'admin', iat: Date.now() }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function generatePasswordHash(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}
