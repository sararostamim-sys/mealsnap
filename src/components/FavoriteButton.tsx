'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { supabase } from '@/lib/supabase';

type RecipeLite = {
  id: string;              // your recipe id (API id or internal)
  title: string;
  image_url?: string | null;
  source_url?: string | null;
  data?: any;              // optional extra JSON you want to store
};

export default function FavoriteButton({ recipe }: { recipe: RecipeLite }) {
  const [isFav, setIsFav] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();

  // Load initial favorite state
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setIsFav(false); return; }
      const { data } = await supabase
        .from('favorites')
        .select('id')
        .eq('user_id', user.id)
        .eq('recipe_id', recipe.id)
        .maybeSingle();
      if (alive) setIsFav(Boolean(data));
    })();
    return () => { alive = false; };
  }, [recipe.id]);

  async function toggle() {
    startTransition(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        // send them to login, then back to the recipe list
        window.location.href = `/login?redirect=/favorites`;
        return;
      }

      if (isFav) {
        await supabase
          .from('favorites')
          .delete()
          .eq('user_id', user.id)
          .eq('recipe_id', recipe.id);
        setIsFav(false);
      } else {
        await supabase.from('favorites').insert({
          user_id: user.id,
          recipe_id: recipe.id,
          title: recipe.title,
          image_url: recipe.image_url ?? null,
          source_url: recipe.source_url ?? null,
          data: recipe.data ?? null,
        });
        setIsFav(true);
      }
    });
  }

  // Simple heart UI without extra icon deps
  return (
    <button
      onClick={toggle}
      aria-pressed={!!isFav}
      className="inline-flex items-center gap-1 text-sm"
      title={isFav ? 'Remove from favorites' : 'Save to favorites'}
    >
      <span className={'text-lg leading-none ' + (isFav ? 'text-red-500' : 'text-gray-400')}>
        {isFav ? '♥' : '♡'}
      </span>
      <span className="sr-only">{isFav ? 'Unfavorite' : 'Favorite'}</span>
      {pending && <span className="ml-1 text-xs opacity-60">…</span>}
    </button>
  );
}