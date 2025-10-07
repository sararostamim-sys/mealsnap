// app/login/page.tsx
import { Suspense } from "react";
import LoginClient from "./LoginClient";

export const dynamic = "force-dynamic"; // safe for auth pages

export default function Page() {
  return (
    <main className="min-h-[60vh] grid place-items-center px-4">
      <Suspense
        fallback={
          <div className="p-6 rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 text-gray-700 dark:text-gray-300">
            Loading login…
          </div>
        }
      >
        <LoginClient />
      </Suspense>
    </main>
  );
}