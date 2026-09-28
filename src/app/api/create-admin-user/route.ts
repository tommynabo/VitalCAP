import { NextResponse } from 'next/server';
import { getAuth } from '@/lib/auth/server';

export async function GET(req: Request) {
  try {
    const res = await getAuth().api.signUpEmail({
      body: {
        email: "tomasnivraone@gmail.com",
        password: "tmns2007",
        name: "Tomas",
      }
    });
    return NextResponse.json({ success: true, res });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: String(error), stack: error.stack }, { status: 500 });
  }
}
