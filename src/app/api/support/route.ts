import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type SupportType =
  | 'bug_report'
  | 'feature_suggestion'
  | 'recipe_issue'
  | 'pantry_shopping_issue'
  | 'general_feedback';

const ALLOWED_TYPES: SupportType[] = [
  'bug_report',
  'feature_suggestion',
  'recipe_issue',
  'pantry_shopping_issue',
  'general_feedback',
];

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      type?: string;
      message?: string;
      email?: string;
      page_path?: string;
    };

    const type = String(body.type || '').trim() as SupportType;
    const message = String(body.message || '').trim();
    const emailRaw = String(body.email || '').trim();
    const pagePath = String(body.page_path || '').trim();

    if (!ALLOWED_TYPES.includes(type)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid feedback type.' },
        { status: 400 },
      );
    }

    if (!message) {
      return NextResponse.json(
        { ok: false, error: 'Message is required.' },
        { status: 400 },
      );
    }

    const email = emailRaw || null;

    const authHeader = req.headers.get('authorization') || '';

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { error } = await supabase.from('support_requests').insert({
      user_id: user?.id ?? null,
      email,
      type,
      message,
      page_path: pagePath || null,
    });

    if (error) {
      console.error('[SUPPORT API] insert failed:', error);
      return NextResponse.json(
        { ok: false, error: 'Could not submit feedback.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[SUPPORT API] unexpected error:', error);
    return NextResponse.json(
      { ok: false, error: 'Unexpected error.' },
      { status: 500 },
    );
  }
}