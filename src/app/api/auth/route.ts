import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword, signToken, verifyToken } from '@/lib/auth';

// Rate limiting: max 5 attempts per IP per 5 minutes
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;

function shouldUseSecureCookie(req: NextRequest): boolean {
  if (process.env.ALLOW_INSECURE_COOKIE === 'true') return false;
  const host = (req.headers.get('host') || '').split(':')[0];
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return false;
  if (process.env.NODE_ENV === 'production') return true;
  return req.headers.get('x-forwarded-proto') === 'https';
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for') || 'unknown';

    if (!checkRateLimit(ip)) {
      return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
    }

    const { password } = await req.json();

    if (!password) {
      return NextResponse.json({ error: 'Password required' }, { status: 400 });
    }

    const valid = await verifyPassword(password);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    // Reset attempts on success
    attempts.delete(ip);

    const token = signToken();
    const response = NextResponse.json({ ok: true });

    response.cookies.set('wc-token', token, {
      httpOnly: true,
      secure: shouldUseSecureCookie(req),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60, // 7 days
      path: '/',
    });

    return response;
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// Check if authenticated
export async function GET(req: NextRequest) {
  const token = req.cookies.get('wc-token')?.value;
  if (!token || !verifyToken(token)) {
    const response = NextResponse.json({ authenticated: false }, { status: 401 });
    response.cookies.set('wc-token', '', {
      httpOnly: true,
      secure: shouldUseSecureCookie(req),
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
    return response;
  }
  return NextResponse.json({ authenticated: true, wsToken: token });
}
