// Supabase Edge Function: lets the Director or CEO create staff accounts.
// Creating users needs the service-role key, so it must run on the server,
// never in the app. Deploy: supabase functions deploy manage-users
import { createClient } from 'npm:@supabase/supabase-js@2';

const ROLES = ['director', 'ceo', 'admin', 'accounts', 'production_manager', 'production_incharge'];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // who is calling?
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: caller, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !caller.user) return json({ error: 'Not signed in' }, 401);
  const { data: me } = await admin.from('profiles').select('role, active').eq('id', caller.user.id).single();
  if (!me?.active || !['director', 'ceo'].includes(me.role)) return json({ error: 'Only the Director or CEO can add users' }, 403);

  let body: { action?: string; email?: string; password?: string; full_name?: string; role?: string };
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  if (body.action !== 'create') return json({ error: 'Unknown action' }, 400);
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const full_name = String(body.full_name ?? '').trim();
  const role = String(body.role ?? '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email' }, 400);
  if (password.length < 8) return json({ error: 'Password needs at least 8 characters' }, 400);
  if (!ROLES.includes(role)) return json({ error: 'Pick a role' }, 400);

  const { data: created, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name },
  });
  if (error || !created.user) {
    const msg = error?.message?.includes('already') ? 'A user with this email already exists' : (error?.message ?? 'Could not create user');
    return json({ error: msg }, 400);
  }
  // the sign-up trigger made the profile without a role; set it now
  const { error: pErr } = await admin.from('profiles').update({ role, full_name }).eq('id', created.user.id);
  if (pErr) return json({ error: `User created but role not set: ${pErr.message}` }, 500);
  return json({ id: created.user.id, email, role });
});
