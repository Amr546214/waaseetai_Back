export const REPORT_SECTIONS = ['overview', 'users', 'projects', 'finance', 'specialties', 'affiliates', 'performance'] as const;
export const REPORT_PERIODS = ['7d', '30d', '3m', '6m', '1y', 'custom'] as const;

export function isReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validReportRange(period: string, from: string | null, to: string | null): boolean {
  if (period !== 'custom') return from === null && to === null;
  return !!(from || to) && (!from || isReportDate(from)) && (!to || isReportDate(to)) &&
    (!from || !to || from <= to);
}
