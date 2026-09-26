import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { executeAutopilotControl } from "@/services/autopilot/control-plane";
import { UnauthorizedError } from "@/lib/auth/workspace";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const settings = await executeAutopilotControl(await request.json());
    return NextResponse.json({ settings });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: "Invalid Autopilot command." }, { status: 400 });
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: "Workspace authorization required." }, { status: 403 });
    if (error instanceof Error && error.message.includes("Clear the emergency")) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "Autopilot control failed." }, { status: 500 });
  }
}