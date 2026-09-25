export function mergeReportEvent(current, event) {
  const previous = typeof current === "string" ? current : "";
  if (event?.stage !== "report") return previous;
  if (typeof event.report === "string" && event.report.startsWith(previous)) return event.report;
  if (typeof event.chunk !== "string") return previous;
  return `${previous}${event.chunk}`;
}

export function isFinalReportEvent(event) {
  return event?.stage === "report"
    && Number.isInteger(event.index)
    && Number.isInteger(event.total)
    && event.total > 0
    && event.index === event.total;
}
