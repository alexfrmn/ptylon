import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword, signToken, verifyToken } from '@/lib/auth';

function shouldUseSecureCookie(req: NextRequest): boolean {
  if (process.env.ALLOW_INSECURE_COOKIE === 'true') return false;
  if (process.env.NODE_ENV === 'production') return true;
  const proto = req.headers.get('x-forwarded-proto');
  return proto === 'https';
}

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();

    if (!password) {
      return NextResponse.json({ error: 'Password required' }, { status: 400 });
    }

    const valid = await verifyPassword(password);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    const token = signToken();
    const response = NextResponse.json({ ok: true });

    // Set httpOnly cookie
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
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({ authenticated: true, wsToken: token });
}
