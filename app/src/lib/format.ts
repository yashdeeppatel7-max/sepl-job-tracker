const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** ₹12,34,567 */
export const money = (n: number | null | undefined) => (n == null ? '–' : `₹${inr.format(Math.round(n))}`);

/** ₹12.3 L / ₹1.2 Cr for headline numbers */
export function moneyShort(n: number | null | undefined) {
  if (n == null) return '–';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return money(n);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-08-04 → 4 Aug 2026 */
export function date(iso: string | null | undefined) {
  if (!iso) return '–';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Accepts 04.08.2026, 4/8/26 or 2026-08-04; returns ISO or null */
export function parseUserDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const dt = new Date(Date.UTC(y, +m[2] - 1, +m[1]));
    return dt.getUTCDate() === +m[1] ? dt.toISOString().slice(0, 10) : null;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? t : null;
}

/** ISO → 04.08.2026 for editing */
export const toUserDate = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 10).split('-').reverse().join('.') : '';

/** "1,23,456.50" → 123456.5 */
export function parseNumber(s: string): number | null {
  const t = s.replace(/[,\s₹]/g, '');
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  return Number(t);
}
