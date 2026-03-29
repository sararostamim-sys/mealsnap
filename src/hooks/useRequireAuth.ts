'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter, usePathname } from 'next/navigation';

export function useRequireAuth() {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getUser();

      if (!mounted) return;

      if (!data.user) {
        // send them to login with a redirect back to where they were
        router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        return;
      }

      setChecking(false);
    })();

    return () => {
      mounted = false;
    };
  }, [router, pathname]);

  return { checking };
}