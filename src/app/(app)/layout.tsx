// src/app/(app)/layout.tsx
import type { ReactNode } from 'react';
import AppHeader from '../AppHeader';

export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AppHeader />
      {children}
    </>
  );
}