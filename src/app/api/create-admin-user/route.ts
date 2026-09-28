import { NextResponse } from 'next/server';
import { getAuthEnv } from '@/lib/config/auth-env';

export async function GET(req: Request) {
  try {
    const env = getAuthEnv();
    const authUrl = `${env.NEON_AUTH_BASE_URL}/api/auth/sign-up/email`;
    
    const fetchRes = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": process.env.NEXT_PUBLIC_APP_URL || "https://vitalcapproject.vercel.app"
      },
      body: JSON.stringify({
        email: "tomasnivraone@gmail.com",
        password: "tmns2007",
        name: "Tomas",
      })
    });
    
    const text = await fetchRes.text();
    return NextResponse.json({ success: fetchRes.ok, status: fetchRes.status, text });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
