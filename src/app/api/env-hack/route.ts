import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    db: process.env.DATABASE_URL,
    unpooled: process.env.DATABASE_URL_UNPOOLED,
    vitalcap_db: process.env.Vitalcap_DATABASE_URL,
    vitalcap_unpooled: process.env.Vitalcap_DATABASE_URL_UNPOOLED
  });
}
