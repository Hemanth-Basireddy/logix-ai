export type CustomerRouteSummary = { origin: string; destination: string; shipments: number; delivered: number; active: number };
export type CustomerDashboardSummary<TShipment = unknown> = {
  companyNetwork: {
    totalShipments: number;
    deliveredShipments: number;
    activeShipments: number;
    customersServed: number;
    statesCovered: number;
    hubsCovered: number;
    monthlyShipmentActivity: { month: string; shipments: number }[];
    destinationSummary: { destination: string; shipments: number; delivered: number; active: number; hubs: { hubId: string; city: string; shipments: number }[] }[];
    routeSummary: CustomerRouteSummary[];
  };
  personal: {
    totalShipments: number;
    deliveredShipments: number;
    activeShipments: number;
    exceptionShipments: number;
    awaitingEvent: number;
    pendingApproval: number;
    statesCovered: number;
    topRoutes: CustomerRouteSummary[];
    monthlyActivity: { month: string; shipments: number }[];
  };
  recentShipments: TShipment[];
};

export function emptyCustomerDashboardSummary<TShipment = unknown>(): CustomerDashboardSummary<TShipment> {
  return {
    companyNetwork: { totalShipments: 0, deliveredShipments: 0, activeShipments: 0, customersServed: 0, statesCovered: 0, hubsCovered: 0, monthlyShipmentActivity: [], destinationSummary: [], routeSummary: [] },
    personal: { totalShipments: 0, deliveredShipments: 0, activeShipments: 0, exceptionShipments: 0, awaitingEvent: 0, pendingApproval: 0, statesCovered: 0, topRoutes: [], monthlyActivity: [] },
    recentShipments: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asCount(value: unknown): number {
  const result = typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function asLabel(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeCustomerDashboardSummary<TShipment = unknown>(value: unknown): CustomerDashboardSummary<TShipment> {
  const root = asRecord(value);
  const rawNetwork = asRecord(root.companyNetwork);
  const rawPersonal = asRecord(root.personal);
  const routeSummary = asArray(rawNetwork.routeSummary ?? rawNetwork.routes).flatMap((route) => {
    const origin = asLabel(route.origin);
    const destination = asLabel(route.destination);
    return origin && destination ? [{ origin, destination, shipments: asCount(route.shipments), delivered: asCount(route.delivered), active: asCount(route.active) }] : [];
  });

  return {
    companyNetwork: {
      totalShipments: asCount(rawNetwork.totalShipments),
      deliveredShipments: asCount(rawNetwork.deliveredShipments),
      activeShipments: asCount(rawNetwork.activeShipments),
      customersServed: asCount(rawNetwork.customersServed),
      statesCovered: asCount(rawNetwork.statesCovered),
      hubsCovered: asCount(rawNetwork.hubsCovered),
      monthlyShipmentActivity: asArray(rawNetwork.monthlyShipmentActivity).flatMap((item) => item.month ? [{ month: asLabel(item.month), shipments: asCount(item.shipments) }] : []),
      destinationSummary: asArray(rawNetwork.destinationSummary).flatMap((item) => item.destination ? [{ destination: asLabel(item.destination), shipments: asCount(item.shipments), delivered: asCount(item.delivered), active: asCount(item.active), hubs: asArray(item.hubs).flatMap((hub) => hub.hubId ? [{ hubId: asLabel(hub.hubId), city: asLabel(hub.city), shipments: asCount(hub.shipments) }] : []) }] : []),
      routeSummary,
    },
    personal: {
      totalShipments: asCount(rawPersonal.totalShipments),
      deliveredShipments: asCount(rawPersonal.deliveredShipments),
      activeShipments: asCount(rawPersonal.activeShipments),
      exceptionShipments: asCount(rawPersonal.exceptionShipments),
      awaitingEvent: asCount(rawPersonal.awaitingEvent),
      pendingApproval: asCount(rawPersonal.pendingApproval),
      statesCovered: asCount(rawPersonal.statesCovered),
      topRoutes: asArray(rawPersonal.topRoutes).flatMap((route) => route.origin && route.destination ? [{ origin: asLabel(route.origin), destination: asLabel(route.destination), shipments: asCount(route.shipments), delivered: asCount(route.delivered), active: asCount(route.active) }] : []),
      monthlyActivity: asArray(rawPersonal.monthlyActivity).flatMap((item) => item.month ? [{ month: asLabel(item.month), shipments: asCount(item.shipments) }] : []),
    },
    recentShipments: Array.isArray(root.recentShipments) ? root.recentShipments.filter((shipment) => shipment !== null && typeof shipment === "object") as TShipment[] : [],
  };
}
