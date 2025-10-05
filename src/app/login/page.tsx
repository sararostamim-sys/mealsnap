// app/login/page.tsx
import { Suspense } from "react";
import LoginClient from "./LoginClient";

export const dynamic = "force-dynamic"; // safe for auth pages

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6">Loading login…</div>}>
      <LoginClient />
    </Suspense>
  );
}