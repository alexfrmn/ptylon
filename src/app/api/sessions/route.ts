import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';

// Proxy to WS server for session list / stats
// The actual PTY management is in the WS server

export async function GET(req: NextRequest) {
  const token = req.cookies.get('wc-token')?.value;
  if (!token || !verifyToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Return ws connection info
  const wsPort = process.env.WS_PORT || '8791';
  return NextResponse.json({
    wsUrl: `/ws`,
    wsToken: token,
  });
}
