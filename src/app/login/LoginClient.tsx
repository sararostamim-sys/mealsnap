// app/login/LoginClient.tsx
"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function LoginClient() {
  const router = useRouter();
  const params = useSearchParams();

  // default to /pantry if no ?redirect=
  const redirect = useMemo(() => params.get("redirect") || "/pantry", [params]);

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If already signed in, go straight to redirect target
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) router.replace(redirect);
    });
  }, [router, redirect]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}${redirect}` },
    });

    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="min-h-[70vh] grid place-items-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold mb-1">Login</h1>
        <p className="text-sm opacity-70 mb-4">You’ll be redirected to: {redirect}</p>

        <form onSubmit={onSubmit} className="space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded border px-3 py-2"
          />
          <button className="w-full rounded bg-black text-white px-4 py-2">
            Send magic link
          </button>
        </form>

        {sent && (
          <p className="mt-3 text-green-600">
            Check your email for a sign-in link.
          </p>
        )}
        {error && <p className="mt-3 text-red-600">{error}</p>}
      </div>
    </div>
  );
}