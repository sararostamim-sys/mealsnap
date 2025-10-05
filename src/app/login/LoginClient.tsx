'use client';

import { useSearchParams } from 'next/navigation';
import { useMemo } from 'react';

export default function LoginClient() {
  const sp = useSearchParams();
  // Example: read ?redirect=/dashboard
  const redirect = useMemo(() => sp.get('redirect') ?? '/', [sp]);

  // ...your login UI here...
  return (
    <div className="mx-auto max-w-sm p-6">
      <h1 className="text-xl font-semibold mb-4">Login</h1>
      {/* Example usage */}
      <p className="text-sm opacity-70 mb-4">You’ll be redirected to: {redirect}</p>

      {/* TODO: your form / OAuth buttons */}
    </div>
  );
}