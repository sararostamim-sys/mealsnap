import './globals.css';
import type { Metadata } from 'next';
import AppHeader from './AppHeader';

export const metadata: Metadata = {
  title: 'MealSnap',
  description:
    'Turn what you already have into great meals—faster, cheaper, with less waste.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white">
        <AppHeader />
        {children}
      </body>
    </html>
  );
}