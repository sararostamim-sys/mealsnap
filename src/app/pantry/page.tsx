// src/app/pantry/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { getDevUserId } from '@/lib/user';

// NEW: helpers + scanner
import BarcodeScanner from '@/components/BarcodeScanner';
import { ocrDetectSingle, upcLookup, type DetectedItem } from '@/lib/helpers';

type PantryItem = {
  id: string;
  name: string;
  qty: number;
  unit: string;
  perish_by: string | null;
};

/** ------------------------------------------------------------------
 * Common, readable units for pantry rows (single source of truth)
 * -----------------------------------------------------------------*/
const UNIT_OPTIONS = [
  'unit',
  'can',
  'oz',
  'lb',
  'g',
  'ml',
  'cup',
  'tbsp',
  'tsp',
] as const;

export default function PantryPage() {
  useRequireAuth();

  const [items, setItems] = useState<PantryItem[]>([]);
  const [form, setForm] = useState({ name: '', qty: 1, unit: 'unit', perish_by: '' });
  const [loading, setLoading] = useState(true);

  // tabs
  const [tab, setTab] = useState<'manual' | 'upload' | 'barcode'>('manual');

  // inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; qty: number; unit: string; perish_by: string | '' }>({
    name: '',
    qty: 1,
    unit: 'unit',
    perish_by: '',
  });
  const isEditing = (id: string) => editingId === id;

  /** Resolve current user id */
  async function resolveUserId(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? getDevUserId();
  }

  async function load() {
    setLoading(true);
    const userId = await resolveUserId();
    const { data, error } = await supabase
      .from('pantry_items')
      .select('id,name,qty,unit,perish_by')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (!error) setItems(data || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function add() {
    const userId = await resolveUserId();
    if (!form.name.trim()) return;

    const payload = {
      user_id: userId,
      name: form.name.trim().toLowerCase(),
      qty: Number(form.qty) || 1,
      unit: form.unit,
      perish_by: form.perish_by || null,
    };

    const { error } = await supabase.from('pantry_items').insert(payload);
    if (!error) {
      setForm({ name: '', qty: 1, unit: 'unit', perish_by: '' });
      load();
    } else {
      console.error(error);
      alert('Failed to add item.');
    }
  }

  async function remove(id: string) {
    const userId = await resolveUserId();
    const { error } = await supabase
      .from('pantry_items')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (!error) {
      setItems((prev) => prev.filter((i) => i.id !== id));
      if (editingId === id) setEditingId(null);
    } else {
      console.error(error);
      alert('Failed to delete item.');
    }
  }

  function beginEdit(row: PantryItem) {
    setEditingId(row.id);
    setDraft({
      name: row.name,
      qty: row.qty,
      unit: row.unit,
      perish_by: row.perish_by ?? '',
    });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id: string) {
    const userId = await resolveUserId();
    const payload = {
      name: draft.name.trim(),
      qty: Number(draft.qty) || 1,
      unit: draft.unit,
      perish_by: draft.perish_by || null,
    };
    const { error } = await supabase
      .from('pantry_items')
      .update(payload)
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error(error);
      alert('Failed to save changes.');
      return;
    }

    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...payload } as PantryItem : i)));
    setEditingId(null);
  }

  function onDraftKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      if (editingId) void saveEdit(editingId);
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-gray-100" data-build="pantry-tabs-v1">Pantry</h1>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-neutral-900 p-4 shadow-sm">
        {/* Tabs */}
        <div className="mb-4 border-b border-gray-200 dark:border-gray-800">
          <nav className="-mb-px flex gap-4">
            {(['manual','upload','barcode'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={[
                  'px-3 py-2 text-sm',
                  tab === t ? 'border-b-2 border-black dark:border-white font-medium' : 'text-gray-500'
                ].join(' ')}
              >
                {t === 'manual' ? 'Manual' : t === 'upload' ? 'Upload Photos' : 'Scan Barcode'}
              </button>
            ))}
          </nav>
        </div>

        {/* MANUAL */}
        {tab === 'manual' && (
          <div className="flex flex-wrap gap-2 mb-4">
            <input
              className="rounded border px-3 py-2 flex-1 min-w-[12rem]
                         border-gray-300 dark:border-gray-700
                         bg-white dark:bg-neutral-900
                         text-gray-900 dark:text-gray-100
                         placeholder:text-gray-400 dark:placeholder:text-gray-500"
              placeholder="e.g., chicken breast"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <input
              className="rounded border px-3 py-2 w-24
                         border-gray-300 dark:border-gray-700
                         bg-white dark:bg-neutral-900
                         text-gray-900 dark:text-gray-100"
              type="number"
              value={form.qty}
              onChange={(e) => setForm((f) => ({ ...f, qty: Number(e.target.value) }))}
            />
            <select
              className="rounded border px-3 py-2 w-28 pr-8
                         border-gray-300 dark:border-gray-700
                         bg-white dark:bg-neutral-900
                         text-gray-900 dark:text-gray-100"
              value={form.unit}
              onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
            >
              {UNIT_OPTIONS.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <input
              className="rounded border px-3 py-2 w-44
                         border-gray-300 dark:border-gray-700
                         bg-white dark:bg-neutral-900
                         text-gray-900 dark:text-gray-100"
              type="date"
              value={form.perish_by}
              onChange={(e) => setForm((f) => ({ ...f, perish_by: e.target.value }))}
            />
            <button
              onClick={add}
              className="rounded px-4 py-2 bg-black text-white hover:opacity-90
                         dark:bg-white dark:text-black"
            >
              Add
            </button>
          </div>
        )}

        {/* UPLOAD */}
        {tab === 'upload' && (
          <UploadPhoto
            onConfirm={async (rows) => {
              const userId = await resolveUserId();
              if (!rows.length) return;
              const payload = rows.map(r => ({
                user_id: userId,
                name: r.name,
                qty: r.qty ?? 1,
                unit: r.unit ?? 'unit',
                perish_by: null,
              }));
              const { error } = await supabase.from('pantry_items').insert(payload);
              if (error) {
                console.error(error);
                alert('Failed to add detected items.');
              } else {
                load();
              }
            }}
          />
        )}

        {/* BARCODE */}
        {tab === 'barcode' && (
          <BarcodeCapture
            onCommit={async (item) => {
              const userId = await resolveUserId();
              const { error } = await supabase.from('pantry_items').insert({
                user_id: userId,
                name: item.name,
                qty: item.qty ?? 1,
                unit: item.unit ?? 'unit',
                perish_by: null,
              });
              if (error) {
                console.error(error);
                alert('Failed to add item.');
              } else {
                load();
              }
            }}
          />
        )}

        {/* TABLE (wrapped, fixed layout) */}
        {loading ? (
          <p className="text-gray-600 dark:text-gray-400">Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-sm border border-gray-200 dark:border-gray-800">
              <thead className="bg-gray-50 dark:bg-neutral-900">
                <tr>
                  <th className="text-left p-2 w-2/5">Item</th>
                  <th className="text-left p-2 w-20">Qty</th>
                  <th className="text-left p-2 w-24">Unit</th>
                  <th className="text-left p-2 w-44">Perish by</th>
                  <th className="p-2 w-40 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const editing = isEditing(i.id);
                  return (
                    <tr key={i.id} className="border-t border-gray-200 dark:border-gray-800 align-top">
                      <td className="p-2">
                        {editing ? (
                          <input
                            className="border rounded px-2 py-1 w-full"
                            value={draft.name}
                            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                            onKeyDown={onDraftKeyDown}
                            autoFocus
                          />
                        ) : (
                          <div className="truncate">{i.name}</div>
                        )}
                      </td>
                      <td className="p-2">
                        {editing ? (
                          <input
                            type="number"
                            className="border rounded px-2 py-1 w-full"
                            value={draft.qty}
                            onChange={(e) => setDraft((d) => ({ ...d, qty: Number(e.target.value) }))}
                            onKeyDown={onDraftKeyDown}
                          />
                        ) : (
                          i.qty
                        )}
                      </td>
                      <td className="p-2">
                        {editing ? (
                          <select
                            className="border rounded px-2 py-1 w-full"
                            value={draft.unit}
                            onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))}
                            onKeyDown={onDraftKeyDown}
                          >
                            {UNIT_OPTIONS.map(u => (
                              <option key={u} value={u}>{u}</option>
                            ))}
                          </select>
                        ) : (
                          i.unit
                        )}
                      </td>
                      <td className="p-2">
                        {editing ? (
                          <input
                            type="date"
                            className="border rounded px-2 py-1 w-full"
                            value={draft.perish_by}
                            onChange={(e) => setDraft((d) => ({ ...d, perish_by: e.target.value }))}
                            onKeyDown={onDraftKeyDown}
                          />
                        ) : (
                          i.perish_by ?? '-'
                        )}
                      </td>
                      <td className="p-2">
                        <div className="flex justify-end items-center gap-3 whitespace-nowrap">
                          {editing ? (
                            <>
                              <button
                                onClick={() => saveEdit(i.id)}
                                className="text-green-700 dark:text-green-400 hover:underline"
                                aria-label="Save changes"
                              >
                                Save
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="text-gray-600 dark:text-gray-400 hover:underline"
                                aria-label="Cancel editing"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => remove(i.id)}
                                className="text-red-600 dark:text-red-400 hover:underline"
                                aria-label="Delete item"
                              >
                                Delete
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => beginEdit(i)}
                                className="text-blue-700 dark:text-blue-400 hover:underline"
                                aria-label="Edit item"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => remove(i.id)}
                                className="text-red-600 dark:text-red-400 hover:underline"
                                aria-label="Delete item"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {items.length === 0 && (
                  <tr>
                    <td className="p-3 text-gray-500 dark:text-gray-400" colSpan={5}>
                      No items yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------- Inline helpers (UI) ----------------------- */

function UploadPhoto({ onConfirm }: { onConfirm: (rows: { name: string; qty: number; unit: string }[]) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [rows, setRows] = useState<DetectedItem[] | null>(null);

  async function pickOne() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      setPending(true);
      try {
        const items = await ocrDetectSingle(f); // /api/ocr
        const dedup = Array.from(new Map(items.map(i => [i.name, i])).values()).slice(0, 10);
        setRows(dedup);
      } catch (e) {
        console.error(e);
        alert(`OCR failed: ${String(e)}`);
      } finally {
        setPending(false);
      }
    };
    input.click();
  }

  if (rows) {
    return (
      <div className="space-y-3 mb-4">
        <div className="text-sm text-gray-600 dark:text-gray-400">Confirm detected items</div>
        <ul className="divide-y divide-gray-200 dark:divide-gray-800">
          {rows.map((r, i) => (
            <li key={i} className="py-2 flex items-center gap-2">
              <input
                className="border rounded px-2 py-1 w-56"
                value={r.name}
                onChange={e => setRows(rs => rs!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                type="number"
                className="border rounded px-2 py-1 w-20"
                value={r.qty ?? 1}
                onChange={e => setRows(rs => rs!.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))}
              />
              <input
                className="border rounded px-2 py-1 w-24"
                value={r.unit ?? 'unit'}
                onChange={e => setRows(rs => rs!.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}
              />
              <span className="text-xs opacity-60">
                {r.confidence ? `~${Math.round((r.confidence || 0) * 100)}%` : ''}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex gap-3">
          <button
            onClick={() =>
              onConfirm(rows.map(r => ({ name: r.name, qty: r.qty ?? 1, unit: r.unit ?? 'unit' })))
            }
            className="rounded px-4 py-2 bg-black text-white dark:bg-white dark:text-black"
          >
            Add {rows.length} item(s)
          </button>
          <button onClick={() => setRows(null)} className="text-sm underline">
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-center gap-3">
      <button
        onClick={pickOne}
        className="rounded px-4 py-2 border border-gray-300 dark:border-gray-700"
      >
        Choose photo
      </button>
      {pending && <span className="text-sm opacity-70">Processing…</span>}
    </div>
  );
}

function BarcodeCapture({ onCommit }: { onCommit: (item: { name: string; qty?: number; unit?: string }) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState<DetectedItem | null>(null);

  return (
    <div className="space-y-3 mb-4">
      <BarcodeScanner
        onDetected={async (code: string) => {
          if (pending) return;
          setPending(true);
          try {
            const item = await upcLookup(code);
            setLast(item);
          } catch (e) {
            console.error(e);
            alert(`UPC lookup failed: ${String(e)}`);
          } finally {
            setPending(false);
          }
        }}
      />
      {last && (
        <div className="rounded border border-gray-200 dark:border-gray-800 p-3">
          <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">Detected:</div>
          <div className="flex items-center gap-2">
            <input
              className="border rounded px-2 py-1 w-56"
              value={last.name}
              onChange={e => setLast({ ...last!, name: e.target.value })}
            />
            <input
              type="number"
              className="border rounded px-2 py-1 w-20"
              value={last.qty ?? 1}
              onChange={e => setLast({ ...last!, qty: Number(e.target.value) })}
            />
            <input
              className="border rounded px-2 py-1 w-24"
              value={last.unit ?? 'unit'}
              onChange={e => setLast({ ...last!, unit: e.target.value })}
            />
            <button
              onClick={() => onCommit({ name: last.name, qty: last.qty ?? 1, unit: last.unit ?? 'unit' })}
              className="ml-2 rounded px-3 py-1 bg-black text-white dark:bg-white dark:text-black"
            >
              Add to pantry
            </button>
          </div>
        </div>
      )}
      {pending && <span className="text-sm opacity-70">Scanning…</span>}
    </div>
  );
}