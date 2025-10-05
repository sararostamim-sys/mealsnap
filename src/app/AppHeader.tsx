'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const LINKS = [
  { href: '/pantry', label: 'Pantry' },
  { href: '/preferences', label: 'Preferences' },
  { href: '/plan', label: 'Plan' },
  { href: '/favorites', label: 'Favorites' }, 
];

export default function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();

  // Hide header on home and login
  const hide =
    pathname === '/' ||
    pathname === '/login' ||
    pathname?.startsWith('/login');

  const [loading, setLoading] = useState(true);
  const [isAuthed, setIsAuthed] = useState(false);

  useEffect(() => {
    let unsub: (() => void) | undefined;

    (async () => {
      const { data } = await supabase.auth.getUser();
      setIsAuthed(Boolean(data.user));
      setLoading(false);

      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        setIsAuthed(Boolean(session?.user));
      });
      unsub = () => sub.subscription.unsubscribe();
    })();

    return () => { unsub?.(); };
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace('/');     // back to landing
    router.refresh();
  }

  if (hide) return null;

  return (
    <header className="sticky top-0 z-40 border-b bg-white/80 backdrop-blur">
      <nav className="mx-auto max-w-5xl h-12 px-4 flex items-center justify-between">
        {/* Left: Brand */}
        <Link href="/pantry" className="font-semibold tracking-tight">
          MealSnap
        </Link>

        {/* Middle: Primary links */}
        <div className="hidden sm:flex gap-4 text-sm">
          {LINKS.map(({ href, label }) => {
            const active =
              pathname === href || pathname?.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                className={
                  'px-2 py-1 transition ' +
                  (active ? 'font-semibold' : 'opacity-70 hover:opacity-100')
                }
              >
                {label}
              </Link>
            );
          })}
        </div>

        {/* Right: Auth action */}
        <div>
          {loading ? (
            <span className="text-sm opacity-60">…</span>
          ) : isAuthed ? (
            <button
              onClick={handleSignOut}
              className="text-sm rounded px-3 py-1.5 border border-black/10 hover:bg-black/5 transition"
            >
              Sign out
            </button>
          ) : (
            <Link
              href="/login"
              className="text-sm rounded px-3 py-1.5 bg-black text-white hover:opacity-90 transition"
            >
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}