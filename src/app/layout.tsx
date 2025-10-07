import './globals.css';
import type { Metadata } from 'next';
import AppHeader from './AppHeader';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';

export const metadata: Metadata = {
  metadataBase: new URL('https://mealcue.app'),
  title: 'MealCue',
  description:
    'Turn what you already have into great meals—faster, cheaper, with less waste.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'MealCue',
    description:
      'Turn what you already have into great meals—faster, cheaper, with less waste.',
    url: 'https://mealcue.app',
    siteName: 'MealCue',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'MealCue',
    description:
      'Turn what you already have into great meals—faster, cheaper, with less waste.',
  },
  // Address bar / OS theme color for both schemes
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  // Hint to browsers that both color schemes are supported
  other: {
    'color-scheme': 'light dark',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* System dark mode support via Tailwind's `dark:` variants */}
      <body className="min-h-screen bg-white text-gray-900 dark:bg-neutral-950 dark:text-gray-100">
        <AppHeader />
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}