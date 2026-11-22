/** Older servers only report running calls admitted on the current UTC day. */
export function modelActivityBeforeToday(usage?: { activeCalls?: number | undefined; dailyActiveCalls?: number | undefined }) {
  if (usage?.activeCalls === undefined || usage.dailyActiveCalls === undefined) return null;
  const count = usage.activeCalls - usage.dailyActiveCalls;
  return count > 0 ? `${count} running model ${count === 1 ? "call started" : "calls started"} on an earlier UTC day.` : null;
}
