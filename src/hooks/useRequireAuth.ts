'use client';
import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter, usePathname } from 'next/navigation';

export function useRequireAuth() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (mounted && !data.user) {
        // send them to login with a redirect back to where they were
        router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
      }
    })();
    return () => { mounted = false; };
  }, [router, pathname]);
}