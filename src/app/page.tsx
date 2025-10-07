// src/app/page.tsx
import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-[70vh] grid place-items-center px-6">
      <div className="text-center max-w-3xl">
        <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tight
                       text-gray-900 dark:text-gray-100">
          MealCue
        </h1>

        <p className="mt-3 text-xl text-gray-700 dark:text-gray-300">
          Cook smarter. Waste less.
        </p>

        <p className="mt-8 text-lg leading-relaxed
                      text-gray-600 dark:text-gray-400">
          <span className="font-semibold">Our mission:</span> make everyday
          cooking effortless by turning what’s already in your pantry into
          delicious, practical meals. We help you track ingredients, discover
          smart recipes, and cut food waste—so you save time, money, and
          headspace.
        </p>

        <div className="mt-10">
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-2xl
                       px-6 py-3 text-base font-medium
                       bg-black text-white hover:opacity-90
                       dark:bg-white dark:text-black"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}