'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

export default function ShareAuthLink() {
  const pathname = usePathname();
  const sp = useSearchParams();

  const qs = sp?.toString();
  const next = `${pathname}${qs ? `?${qs}` : ''}`;

  return (
    <Link
      href={`/login?next=${encodeURIComponent(next)}`}
      className="text-sm text-gray-700 dark:text-gray-200 hover:underline"
    >
      Sign in
    </Link>
  );
}