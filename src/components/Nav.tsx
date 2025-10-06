'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter, usePathname } from 'next/navigation';

export default function Nav() {
  const router = useRouter();
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, [pathname]);

  async function logout() {
    await supabase.auth.signOut();
    router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
  }

  return (
    <nav className="w-full border-b bg-white">
      <div className="mx-auto max-w-4xl flex items-center justify-between p-4">
        <div className="flex items-center gap-4">
          <Link className="font-semibold" href="/">MealCue</Link>
          {email && (
            <>
              <Link className="text-sm hover:underline" href="/preferences">Preferences</Link>
              <Link className="text-sm hover:underline" href="/pantry">Pantry</Link>
              <Link className="text-sm hover:underline" href="/plan">Plan</Link>
            </>
          )}
        </div>
        <div className="text-sm">
          {email ? (
            <button onClick={logout} className="rounded px-3 py-1 border hover:bg-gray-50">Sign out</button>
          ) : (
            <Link href="/login" className="rounded px-3 py-1 border hover:bg-gray-50">Sign in</Link>
          )}
        </div>
      </div>
    </nav>
  );
}