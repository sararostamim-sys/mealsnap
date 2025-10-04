'use client';

export const dynamic = 'force-dynamic'; // avoid prerendering

import React, { FormEvent, useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') || '/pantry';

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If already signed in, go to redirect target
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) router.replace(redirect);
    });
  }, [router, redirect]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}${redirect}` },
      });
      if (error) setError(error.message);
      else setSent(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err ?? 'Network request failed');
      setError(message);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-10">
      <h1 className="text-2xl font-semibold mb-4">Sign in</h1>
      <form onSubmit={onSubmit} className="space-y-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full rounded border px-3 py-2"
        />
        <button className="rounded bg-black text-white px-4 py-2">Send magic link</button>
      </form>
      {sent && <p className="mt-3 text-green-600">Check your email for a sign-in link.</p>}
      {error && <p className="mt-3 text-red-600">{error}</p>}
    </div>
  );
}

export default function LoginPage() {
  // Wrap the hook user in Suspense per Next 15 requirement
  return (
    <Suspense fallback={<div className="p-4">Loading…</div>}>
      <LoginInner />
    </Suspense>
  );
}