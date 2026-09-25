"use client";

import { useActionState } from "react";
import { signInWithEmailAction } from "@/lib/auth/actions";

export default function SignInPage() {
  const [state, formAction, pending] = useActionState(signInWithEmailAction, { error: null });

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted p-6">
      <form action={formAction} className="w-full max-w-sm space-y-4 rounded-[10px] border border-border bg-surface p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold text-text">Sign in to VitalCap</h1>
          <p className="text-sm text-text-muted">Neon Auth-backed workspace access.</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-xs font-medium text-text-muted">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className="w-full rounded-[10px] border border-border bg-surface-muted px-3 py-2 text-sm text-text"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-xs font-medium text-text-muted">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            className="w-full rounded-[10px] border border-border bg-surface-muted px-3 py-2 text-sm text-text"
          />
        </div>
        {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-[10px] bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
