// SmartHR — Supabase client duy nhất (thay Dexie + server.js LAN sync).
// Realtime thay SSE tay: supabase.channel(...).on('postgres_changes', ...).
// .env: VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (KHÔNG dùng service_role ở FE).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anon) {
  throw new Error(
    '[Supabase] Thiếu VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. ' +
      'Copy .env.example thành .env và điền anon key (không phải service_role).'
  );
}

export const supabase: SupabaseClient = createClient(url, anon, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'smarthr-supabase-auth',
    },
    realtime: { params: { eventsPerSecond: 20 } },
  });

// Helper subscribe realtime 1 bảng (INSERT/UPDATE/DELETE), trả về unsubscribe.
export function subscribeTable(
  table: string,
  onChange: (payload: unknown) => void
): () => void {
  const ch = supabase
    .channel(`rt:${table}`)
    .on(
      'postgres_changes' as never,
      { event: '*', schema: 'public', table } as never,
      onChange as never
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(ch);
  };
}
