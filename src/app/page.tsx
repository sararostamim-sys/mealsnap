import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen grid place-items-center bg-white">
      <section className="text-center px-6">
        <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight">MealCue</h1>
        <p className="mt-2 text-sm md:text-base opacity-70">Cook smarter. Waste less.</p>

        <p className="mt-6 max-w-2xl mx-auto text-base md:text-lg opacity-80 leading-relaxed">
          <strong>Our mission:</strong> make everyday cooking effortless by turning what’s already in your pantry
          into delicious, practical meals. We help you track ingredients, discover smart recipes, and cut food waste—
          so you save time, money, and headspace.
        </p>

        <div className="mt-8 flex items-center justify-center">
          <Link
            href="/login"
            className="rounded-2xl px-6 py-3 bg-black text-white hover:opacity-90 transition"
          >
            Sign in
          </Link>
        </div>
      </section>
    </main>
  );
}