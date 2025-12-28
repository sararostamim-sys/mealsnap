// src/app/layout.tsx
import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { AttributionCapture } from '@/components/AttributionCapture';

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  colorScheme: 'light dark',
};

export const metadata: Metadata = {
  metadataBase: new URL('https://mealcue.app'),
  title: { default: 'MealCue', template: '%s • MealCue' },
  description:
    'Turn what you already have into great meals—faster, cheaper, with less waste.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: 'https://mealcue.app',
    siteName: 'MealCue',
    title: 'MealCue',
    description:
      'Turn what you already have into great meals—faster, cheaper, with less waste.',
    images: [
      {
        url: '/og.jpg',
        width: 1200,
        height: 630,
        alt: 'MealCue — Cook smarter. Waste less.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'MealCue',
    description:
      'Turn what you already have into great meals—faster, cheaper, with less waste.',
    images: ['/og.jpg'],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 dark:bg-neutral-950 dark:text-gray-100">
        {children}
        <AttributionCapture />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}