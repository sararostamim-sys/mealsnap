'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRequireAuth } from '@/hooks/useRequireAuth';

type SupportType =
  | 'bug_report'
  | 'feature_suggestion'
  | 'recipe_issue'
  | 'pantry_shopping_issue'
  | 'general_feedback';

export default function SupportPage() {
  const { checking } = useRequireAuth();

  const pathname = usePathname();

  const [type, setType] = useState<SupportType>('bug_report');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const inputCls =
    'rounded border px-3 py-2 border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500';
  const selectCls = inputCls + ' pr-8';

  if (checking) return <div className="p-6 text-sm text-gray-500">Loading...</div>;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitted(false);

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setError('Please enter a message.');
      return;
    }

    setSubmitting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch('/api/support', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify({
          type,
          message: trimmedMessage,
          email: email.trim(),
          page_path: pathname,
        }),
      });

      const json = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !json.ok) {
        throw new Error(json.error || 'Could not submit feedback.');
      }

      setMessage('');
      setEmail('');
      setSubmitted(true);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Could not submit feedback.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-2 text-gray-900 dark:text-gray-100">
        Support &amp; Feedback
      </h1>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Found a bug, have an idea, or want to suggest an improvement? Send it here.
      </p>

      <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 p-4 shadow-sm">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
              Type
            </label>
            <select
              className={`${selectCls} w-full`}
              value={type}
              onChange={(e) => setType(e.target.value as SupportType)}
            >
              <option value="bug_report">Bug report</option>
              <option value="feature_suggestion">Feature suggestion</option>
              <option value="recipe_issue">Recipe issue</option>
              <option value="pantry_shopping_issue">Pantry / shopping issue</option>
              <option value="general_feedback">General feedback</option>
            </select>
          </div>

          <div>
            <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
              Message
            </label>
            <textarea
              className={`${inputCls} min-h-[160px] w-full`}
              placeholder="Tell us what happened or what you'd like to see improved."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          <div>
            <label className="block mb-1 font-medium text-gray-900 dark:text-gray-100">
              Email (optional)
            </label>
            <input
              type="email"
              className={`${inputCls} w-full`}
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Include your email if you’d like a reply.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className={`rounded px-4 py-2 bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white ${
                submitting ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {submitting ? 'Submitting…' : 'Submit'}
            </button>

            {submitted ? (
              <span className="text-green-600 dark:text-green-400">
                ✓ Thanks — your feedback was submitted.
              </span>
            ) : null}
          </div>

          {error ? (
            <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
          ) : null}
        </form>
      </section>
    </div>
  );
}