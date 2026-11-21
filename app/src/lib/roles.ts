export type Role = 'director' | 'ceo' | 'admin' | 'accounts' | 'production_manager' | 'production_incharge';

export const ROLE_LABEL: Record<Role, string> = {
  director: 'Director',
  ceo: 'CEO',
  admin: 'Admin',
  accounts: 'Accounts',
  production_manager: 'Production manager',
  production_incharge: 'Production incharge',
};

export const ROLES = Object.keys(ROLE_LABEL) as Role[];

// These mirror the server rules in supabase/migrations/0001_schema.sql.
// They only decide what the app shows; the server enforces the real limits.
export const can = (role: Role | null | undefined) => ({
  manageUsers: role === 'director' || role === 'ceo',
  manageJobs: role === 'director' || role === 'ceo' || role === 'admin',
  importExcel: role === 'director' || role === 'ceo' || role === 'admin',
  seeMoney: role === 'director' || role === 'ceo' || role === 'admin' || role === 'accounts',
  seeDespatch: role === 'director' || role === 'ceo' || role === 'admin' || role === 'accounts',
  recordDespatch: role === 'director' || role === 'ceo' || role === 'admin',
  updateProductionStages: role === 'director' || role === 'ceo' || role === 'admin' || role === 'production_manager' || role === 'production_incharge',
  updateFinanceStages: role === 'director' || role === 'ceo' || role === 'admin' || role === 'accounts',
});
