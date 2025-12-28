// src/app/login/LoginClient.tsx
'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter, useSearchParams } from 'next/navigation';
import { trackEvent } from '@/lib/analytics';

export default function LoginClient() {
  const router = useRouter();
  const params = useSearchParams();

  // Support both ?next=... (new share flow) and existing ?redirect=...
  const rawRedirect = params.get('next') || params.get('redirect') || '/pantry';

  // Convert share → plan modal deep-link after login
  // Example input:  /share/plan/<shareId>?open=<recipeId>
  // Output:         /plan?open=<recipeId>
  const redirect = useMemo(() => {
    try {
      if (typeof window === 'undefined') return rawRedirect;
      if (!rawRedirect.startsWith('/share/plan/')) return rawRedirect;

      const u = new URL(rawRedirect, window.location.origin);
      const open = u.searchParams.get('open');

      return open ? `/plan?open=${encodeURIComponent(open)}` : '/plan';
    } catch {
      return rawRedirect;
    }
  }, [rawRedirect]);

  useEffect(() => {
    trackEvent('login_view', {
      raw_redirect: rawRedirect,
      redirect,
    });
  }, [rawRedirect, redirect]);

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        trackEvent('auth_success', { method: 'session', redirect });
        router.replace(redirect);
      }
    });
  }, [router, redirect]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: new URL(redirect, window.location.origin).toString(),
      },
    });

    if (error) {
      trackEvent('auth_error', { method: 'magic_link', message: error.message });
      setError(error.message);
    } else {
      trackEvent('magic_link_sent', { redirect });
      setSent(true);
    }
  }

  return (
    <div
      className="w-full max-w-md mx-auto mt-16 rounded-xl border
                    border-gray-200 dark:border-gray-800
                    bg-white dark:bg-neutral-900 p-6 shadow-sm"
    >
      <h1 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-gray-100">
        Login
      </h1>

      <form onSubmit={onSubmit} className="space-y-3">
        <input
          className="w-full rounded border px-3 py-2
                     border-gray-300 dark:border-gray-700
                     bg-white dark:bg-neutral-900
                     text-gray-900 dark:text-gray-100
                     placeholder:text-gray-400 dark:placeholder:text-gray-500"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <button
          className="w-full rounded bg-black text-white px-4 py-2
                     dark:bg-white dark:text-black"
        >
          Send magic link
        </button>
      </form>

      {sent && (
        <p className="mt-3 text-green-600 dark:text-green-400">
          Check your email for a sign-in link.
        </p>
      )}
      {error && <p className="mt-3 text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}