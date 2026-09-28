import { NextResponse } from 'next/server';
import { getAuthEnv } from '@/lib/config/auth-env';

export async function GET(req: Request) {
  const env = getAuthEnv();
  return NextResponse.json({
    neonAuthBaseUrl: env.NEON_AUTH_BASE_URL,
    nextPublicAppUrl: process.env.NEXT_PUBLIC_APP_URL,
    vercelUrl: process.env.VERCEL_URL
  });
}
