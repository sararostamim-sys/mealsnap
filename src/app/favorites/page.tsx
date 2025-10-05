'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Fav = {
  id: string;
  recipe_id: string;
  title: string | null;
  image_url: string | null;
  source_url: string | null;
  created_at: string;
};

export default function FavoritesPage() {
  const [favs, setFavs] = useState<Fav[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        window.location.href = '/login?redirect=/favorites';
        return;
      }
      const { data, error } = await supabase
        .from('favorites')
        .select('id,recipe_id,title,image_url,source_url,created_at')
        .order('created_at', { ascending: false });
      if (error) console.error(error);
      if (alive) {
        setFavs(data ?? []);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) return <div className="p-6">Loading…</div>;
  if (!favs || favs.length === 0) return <div className="p-6">No favorites yet.</div>;

  return (
    <main className="mx-auto max-w-5xl p-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {favs.map((f) => (
        <article key={f.id} className="border rounded-xl p-4 flex flex-col">
          {f.image_url && (
            <img
              src={f.image_url}
              alt=""
              className="rounded-md mb-3 aspect-video object-cover"
            />
          )}
          <h3 className="font-semibold">{f.title ?? 'Untitled recipe'}</h3>
          <div className="mt-auto flex gap-3 pt-3">
            {f.source_url && (
              <a
                href={f.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline"
              >
                Open source
              </a>
            )}
          </div>
        </article>
      ))}
    </main>
  );
}