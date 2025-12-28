// src/app/share/layout.tsx
import type { ReactNode } from 'react';
import ShareAuthLink from './ShareAuthLink';

export default function ShareLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <header className="border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="font-semibold text-gray-900 dark:text-gray-100">
            MealCue
          </div>

          <ShareAuthLink />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}