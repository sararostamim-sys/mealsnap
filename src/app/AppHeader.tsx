'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/pantry', label: 'Pantry' },
  { href: '/plan', label: 'Plan' },
  { href: '/preferences', label: 'Preferences' },
];

export default function AppHeader() {
  const pathname = usePathname();

  // Hide header on homepage and login
  const hide =
    pathname === '/' ||
    pathname === '/login' ||
    pathname?.startsWith('/login');

  if (hide) return null;

  return (
    <header className="sticky top-0 z-40 border-b bg-white/80 backdrop-blur">
      <nav className="mx-auto max-w-5xl h-12 px-4 flex items-center gap-4">
        <div className="flex gap-4 text-sm">
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
      </nav>
    </header>
  );
}