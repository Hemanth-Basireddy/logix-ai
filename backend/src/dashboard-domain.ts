export const baselineSlaDays = 4;

const terminalStatuses = new Set(["on time", "delayed", "delivered", "completed"]);

export type ShipmentDeliveryFacts = {
  deliveryStatus: string | null;
  actualTransitDays: number | null;
  slaDays: number | null;
};

export function isTerminalShipment(status: string | null): boolean {
  return status !== null && terminalStatuses.has(status.trim().toLowerCase());
}

export function exceededShipmentSla(facts: ShipmentDeliveryFacts): boolean {
  return (
    isTerminalShipment(facts.deliveryStatus) &&
    facts.actualTransitDays !== null &&
    facts.actualTransitDays > (facts.slaDays ?? baselineSlaDays)
  );
}

export function onTimeDeliveryRate(onTime: number, eligibleDelivered: number): number | null {
  if (eligibleDelivered <= 0) return null;
  return (onTime / eligibleDelivered) * 100;
}

export function trendGranularityForRange(
  startDate: string | null,
  endDate: string | null,
): "day" | "week" {
  if (!startDate || !endDate) return "week";
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (start > end) throw new Error("startDate must not be after endDate.");
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return days <= 90 ? "day" : "week";
}

export function parseIsoDate(value: string | undefined, label: string): string | null {
  if (value === undefined || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid calendar date.`);
  }
  return value;
}

export function previousEquivalentPeriod(
  startDate: string | null,
  endDate: string | null,
): { startDate: string; endDate: string } | null {
  if (!startDate || !endDate) return null;
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (start > end) throw new Error("startDate must not be after endDate.");
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const previousEnd = new Date(start.getTime() - 86_400_000);
  const previousStart = new Date(previousEnd.getTime() - (days - 1) * 86_400_000);
  return {
    startDate: previousStart.toISOString().slice(0, 10),
    endDate: previousEnd.toISOString().slice(0, 10),
  };
}
