'use client';

import { useEffect, useState, useTransition } from 'react';
import { supabase } from '@/lib/supabase';
import { getDevUserId } from '@/lib/user';

type RecipeLite = {
  id: string;
  title: string;
  image_url?: string | null;
  source_url?: string | null;
  data?: Record<string, unknown> | null; // typed (no 'any')
};

export default function FavoriteButton({ recipe }: { recipe: RecipeLite }) {
  const [isFav, setIsFav] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();

  /** Resolve current user id: prefer Supabase Auth, fall back to .env dev id */
  async function resolveUserId(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? getDevUserId();
  }

  // Load initial favorite state (scoped to current user)
  useEffect(() => {
    let alive = true;
    (async () => {
      const userId = await resolveUserId();
      const { data, error } = await supabase
        .from('favorites')
        .select('id')
        .eq('user_id', userId)
        .eq('recipe_id', recipe.id)
        .maybeSingle();

      if (!alive) return;
      if (error) {
        console.error(error);
        setIsFav(false);
        return;
      }
      setIsFav(Boolean(data));
    })();
    return () => { alive = false; };
    
  }, [recipe.id]);

  async function toggle() {
    startTransition(async () => {
      const userId = await resolveUserId();

      if (isFav) {
        const { error } = await supabase
          .from('favorites')
          .delete()
          .eq('user_id', userId)
          .eq('recipe_id', recipe.id);
        if (!error) setIsFav(false);
        else console.error(error);
      } else {
        const { error } = await supabase.from('favorites').insert({
          user_id: userId,
          recipe_id: recipe.id,
          title: recipe.title,
          image_url: recipe.image_url ?? null,
          source_url: recipe.source_url ?? null,
          data: recipe.data ?? null,
        });
        if (!error) setIsFav(true);
        else console.error(error);
      }
    });
  }

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