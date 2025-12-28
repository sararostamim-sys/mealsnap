'use client';

import { useEffect } from 'react';

const KEY = 'mc_attrib_v1';

export function AttributionCapture() {
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY)) return;

      const url = new URL(window.location.href);
      const sp = url.searchParams;

      const attrib = {
        utm_source: sp.get('utm_source') || '',
        utm_medium: sp.get('utm_medium') || '',
        utm_campaign: sp.get('utm_campaign') || '',
        utm_content: sp.get('utm_content') || '',
        utm_term: sp.get('utm_term') || '',
        referrer: document.referrer || '',
        landing_path: url.pathname,
        landing_qs: url.search,
        first_seen_at: new Date().toISOString(),
      };

      localStorage.setItem(KEY, JSON.stringify(attrib));
    } catch {}
  }, []);

  return null;
}