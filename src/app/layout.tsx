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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white">
        <AppHeader />
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}