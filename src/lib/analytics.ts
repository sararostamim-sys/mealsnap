'use client';

import { track } from '@vercel/analytics';

const ATTR_KEY = 'mc_attrib_v1';

export type AnalyticsProps = Record<string, string | number | boolean | null>;

function getAttrib(): AnalyticsProps {
  try {
    const raw = localStorage.getItem(ATTR_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};

    // only keep string values (utm, ref, etc.)
    const out: AnalyticsProps = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function trackEvent(name: string, props: AnalyticsProps = {}) {
  track(name, { ...getAttrib(), ...props });
}