// Supabase Edge Function: admin-user — Kieu (AD System) cấp lại mật khẩu
// user dept trực tiếp từ frontend, không cần Glory kỹ thuật.
//
// Bảo mật:
//  - service_role CHỈ sống trong function (env tự có của Edge Functions).
//  - Mọi request phải kèm JWT user; function verify JWT rồi kiểm tra
//    app_metadata.role === 'AD System' mới cho chạy.
//  - Chặn tự reset chính mình (đổi pass của mình ở avatar → Đổi mật khẩu).
//
// Deploy (chọn 1):
//  A. Dashboard: Edge Functions → Create a new function → tên admin-user
//     → paste toàn file này → Deploy.
//  B. CLI: supabase link --project-ref <ref> && supabase functions deploy admin-user
// Test: POST /functions/v1/admin-user {action:'reset_password', email, newPassword}
//   kèm header Authorization: Bearer <jwt-cua-kieu>

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Chỉ hỗ trợ POST' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json({ error: 'Thiếu env SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY' }, 500);
    }

    // 1. Xác thực caller bằng JWT của chính họ
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: caller },
      error: callerErr,
    } = await callerClient.auth.getUser();
    if (callerErr || !caller) {
      return json({ error: 'Chưa đăng nhập hoặc phiên hết hạn' }, 401);
    }
    const callerRole = (caller.app_metadata as Record<string, unknown>)?.['role'];
    if (callerRole !== 'AD System') {
      return json({ error: 'Chỉ AD System (Kieu/Hoa/Glory) được cấp lại mật khẩu' }, 403);
    }

    // 2. Đọc tham số
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? '');
    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return json({ error: 'Email không hợp lệ' }, 400);
    }

    // 3. Tìm user theo email (list tối đa 1000 — hệ thống 6 users)
    const admin = createClient(supabaseUrl, serviceKey);
    const { data: listData, error: listErr } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (listErr) return json({ error: `Không liệt kê được users: ${listErr.message}` }, 500);
    const target = (listData?.users ?? []).find(
      (u) => (u.email ?? '').toLowerCase() === email
    );
    if (!target) return json({ error: `Không tìm thấy tài khoản ${email}` }, 404);

    // 4. Chặn tự thao tác chính mình (đổi pass của mình ở avatar → Đổi mật khẩu)
    if (target.id === caller.id) {
      return json({
        error: 'Không tự cấp lại cho chính mình — đổi mật khẩu của bạn ở avatar → Đổi mật khẩu',
      }, 400);
    }

    if (action === 'reset_password') {
      const newPassword = String(body?.newPassword ?? '');
      if (newPassword.length < 6) {
        return json({ error: 'Mật khẩu mới phải tối thiểu 6 ký tự (chính sách Supabase Auth)' }, 400);
      }
      const { error: updateErr } = await admin.auth.admin.updateUserById(target.id, {
        password: newPassword,
      });
      if (updateErr) return json({ error: updateErr.message }, 400);
      return json({ ok: true, email });
    }

    if (action === 'unban') {
      const { error: unbanErr } = await admin.auth.admin.updateUserById(target.id, {
        ban_duration: 'none',
      });
      if (unbanErr) return json({ error: unbanErr.message }, 400);
      return json({ ok: true, email });
    }

    return json({ error: `action không hỗ trợ: ${action || '(trống)'}` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
