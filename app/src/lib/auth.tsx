import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { can, type Role } from './roles';
import { supabase } from './supabase';

type Profile = { id: string; full_name: string; role: Role | null; active: boolean };

type AuthState = {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  role: Role | null;
  perms: ReturnType<typeof can>;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadProfile(s: Session | null) {
    if (!s) { setProfile(null); return; }
    const { data } = await supabase.from('profiles').select('id, full_name, role, active').eq('id', s.user.id).maybeSingle();
    setProfile((data as Profile) ?? null);
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await loadProfile(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      // load outside the callback to avoid a Supabase client deadlock
      setTimeout(() => loadProfile(s), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const role = profile?.active ? profile.role : null;
  const value: AuthState = {
    loading,
    session,
    profile,
    role,
    perms: can(role),
    refreshProfile: () => loadProfile(session),
    signOut: async () => { await supabase.auth.signOut(); },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
