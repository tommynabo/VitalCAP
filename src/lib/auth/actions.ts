"use server";

import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/server";
import { isDevSeedMode } from "@/lib/config/env";

export async function signInWithEmailAction(
  _prevState: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email and password are required." };

  const { error } = await getAuth().signIn.email({ email, password });
  if (error) return { error: error.message ?? "Sign-in failed." };
  redirect("/");
}

export async function signOutAction(): Promise<void> {
  if (!isDevSeedMode()) await getAuth().signOut();
  redirect("/sign-in");
}
