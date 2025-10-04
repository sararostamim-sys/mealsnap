'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRequireAuth } from '@/hooks/useRequireAuth';

type PantryItem = {
  id: string;
  name: string;
  qty: number;
  unit: string;
  perish_by: string | null;
};

export default function PantryPage() {
  useRequireAuth();
  const [items, setItems] = useState<PantryItem[]>([]);
  const [form, setForm] = useState({ name: '', qty: 1, unit: 'unit', perish_by: '' });
  const [loading, setLoading] = useState(true);

  async function load() {
    const { data, error } = await supabase.from('pantry_items')
      .select('id,name,qty,unit,perish_by').order('created_at', { ascending: false });
    if (!error) setItems(data || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function add() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !form.name.trim()) return;
    const payload = {
      user_id: user.id,
      name: form.name.trim().toLowerCase(),
      qty: Number(form.qty) || 1,
      unit: form.unit,
      perish_by: form.perish_by || null
    };
    const { error } = await supabase.from('pantry_items').insert(payload);
    if (!error) {
      setForm({ name: '', qty: 1, unit: 'unit', perish_by: '' });
      load();
    }
  }

  async function remove(id: string) {
    await supabase.from('pantry_items').delete().eq('id', id);
    setItems(items => items.filter(i => i.id !== id));
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-4">Pantry</h1>

      <div className="flex gap-2 mb-4">
        <input className="border rounded px-3 py-2 flex-1" placeholder="e.g., chicken breast"
          value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <input className="border rounded px-3 py-2 w-24" type="number"
          value={form.qty} onChange={e => setForm(f => ({ ...f, qty: Number(e.target.value) }))} />
        <select className="border rounded px-3 py-2"
          value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}>
          {['unit','g','ml','cup','tbsp','tsp','can'].map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <input className="border rounded px-3 py-2" type="date"
          value={form.perish_by} onChange={e => setForm(f => ({ ...f, perish_by: e.target.value }))} />
        <button onClick={add} className="rounded bg-black text-white px-4">Add</button>
      </div>

      {loading ? <p>Loading…</p> : (
        <table className="w-full text-sm border">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-2">Item</th>
              <th className="text-left p-2">Qty</th>
              <th className="text-left p-2">Unit</th>
              <th className="text-left p-2">Perish by</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map(i => (
              <tr key={i.id} className="border-t">
                <td className="p-2">{i.name}</td>
                <td className="p-2">{i.qty}</td>
                <td className="p-2">{i.unit}</td>
                <td className="p-2">{i.perish_by ?? '-'}</td>
                <td className="p-2 text-right">
                  <button onClick={() => remove(i.id)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td className="p-3 text-gray-500" colSpan={5}>No items yet.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}