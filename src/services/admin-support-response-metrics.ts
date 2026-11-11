export interface ResponseMetricRow {
  createdAt: Date;
  firstReplyAt: Date | null;
  senderId: string | null;
  sla: string | null;
  closed?: boolean;
}
export function responseMetrics(rows: ResponseMetricRow[]) {
  const durations = rows.filter(r => r.firstReplyAt && r.firstReplyAt >= r.createdAt)
    .map(r => (r.firstReplyAt!.getTime() - r.createdAt.getTime()) / 3600_000);
  const met = rows.filter(r => r.sla === 'MET').length;
  const late = rows.filter(r => r.sla === 'LATE').length;
  const overdue = rows.filter(r => r.sla === 'OVERDUE').length;
  const pending = rows.filter(r => r.sla === 'PENDING').length;
  const closedWithoutReply = rows.filter(r => r.closed && !r.firstReplyAt).length;
  const measured = met + late + overdue;
  return {
    tickets: rows.length, answered: durations.length, withoutStaffReply: rows.length - durations.length,
    averageFirstReplyHours: durations.length ? Math.round(durations.reduce((a,b) => a+b, 0) / durations.length * 100) / 100 : null,
    met, late, overdue, pending, closedWithoutReply, measured,
    slaRate: measured ? Math.round(met / measured * 1000) / 10 : null,
  };
}
