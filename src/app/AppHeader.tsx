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

  // Hide header on home, login, and share pages
  const hide =
    pathname === '/' ||
    pathname === '/login' ||
    pathname?.startsWith('/login') ||
    pathname?.startsWith('/share');

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

    return () => {
      unsub?.();
    };
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace('/');
    router.refresh();
  }

  if (hide) return null;

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-neutral-950/80 backdrop-blur">
      {/* Top row */}
      <nav className="mx-auto max-w-5xl h-14 px-4 flex items-center justify-between">
        {/* Left: Brand */}
        <Link
          href="/pantry"
          className="font-semibold tracking-tight text-gray-900 dark:text-gray-100"
        >
          MealCue
        </Link>

        {/* Middle: Desktop primary links */}
        <div className="hidden sm:flex gap-1 text-sm">
          {LINKS.map(({ href, label }) => {
            const active = pathname === href || pathname?.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'px-2 py-1 rounded-md transition',
                  'text-gray-800 dark:text-gray-200',
                  active
                    ? 'font-semibold bg-gray-100 dark:bg-neutral-800'
                    : 'opacity-80 hover:opacity-100 hover:bg-gray-50 dark:hover:bg-neutral-800',
                ].join(' ')}
              >
                {label}
              </Link>
            );
          })}
        </div>

        {/* Right: Auth action */}
        <div className="flex-shrink-0">
          {loading ? (
            <span className="text-sm opacity-60">…</span>
          ) : isAuthed ? (
            <button
              onClick={handleSignOut}
              className="text-sm rounded px-3 py-1.5 border transition
                         border-gray-200 dark:border-gray-700
                         text-gray-900 dark:text-gray-100
                         hover:bg-gray-50 dark:hover:bg-neutral-800"
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

      {/* Mobile nav row */}
      <div className="sm:hidden border-t border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-5xl px-4 py-2 overflow-x-auto">
          <div className="flex gap-2 min-w-max">
            {LINKS.map(({ href, label }) => {
              const active = pathname === href || pathname?.startsWith(href + '/');
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'px-3 py-1.5 rounded-md text-sm whitespace-nowrap transition',
                    'text-gray-800 dark:text-gray-200',
                    active
                      ? 'font-semibold bg-gray-100 dark:bg-neutral-800'
                      : 'opacity-80 hover:opacity-100 hover:bg-gray-50 dark:hover:bg-neutral-800',
                  ].join(' ')}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </header>
  );
}