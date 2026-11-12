export type EmployeeRole =
  | "COMPANY_ADMIN"
  | "OPERATIONS_MANAGER"
  | "HUB_MANAGER"
  | "LOGISTICS_EXECUTIVE";

export type Employee = {
  employeeId: string;
  name: string;
  role: EmployeeRole;
  company: {
    id: number;
    name: string;
    branding: {
      logoPath?: string;
      accentColor?: string;
    };
  };
  assignedHubs: Array<{
    id: string;
    city: string;
  }>;
};

export type DashboardPeriod = {
  startDate: string;
  endDate: string;
};

export type CompanyAdminDashboard = {
  generatedAt: string;
  dataStatus: "DATABASE_SNAPSHOT";
  range: {
    requestedStartDate: string | null;
    requestedEndDate: string | null;
    availableStartDate: string | null;
    availableEndDate: string | null;
    trendGranularity: "day" | "week";
  };
  freshness: {
    latestShipmentEventAt: string | null;
    note: string;
  };
  kpis: {
    totalShipments: number;
    deliveredShipments: number;
    activeShipments: number;
    delayedShipments: number;
    totalCustomers: number;
    eligibleDelivered: number;
    onTimeDelivered: number;
    onTimeDeliveryPercent: number | null;
    atRiskShipments: number;
    estimatedRevenue: number;
    estimatedRevenueSource: string;
    baselineSlaDays: number;
    baselineSlaNote: string;
  };
  comparison: null | {
    previousPeriod: DashboardPeriod;
    totalShipments: number;
    delayedShipments: number;
    onTimeDeliveryPercent: number | null;
    estimatedRevenue: number;
  };
  charts: {
    timeline: Array<{
      periodStart: string;
      shipments: number;
      delivered: number;
      active: number;
      delayed: number;
      onTimeDeliveryPercent: number | null;
      estimatedRevenue: number;
    }>;
    modes: Array<{
      mode: string;
      shipments: number;
      delayed: number;
      onTimeDelivered: number;
      onTimeDeliveryPercent: number | null;
      eligibleDelivered: number;
    }>;
    statuses: Array<{
      status: string;
      shipments: number;
      operationalStage: "terminal" | "active";
    }>;
    routesByVolume: Array<RouteMetric>;
    routesByDelay: Array<RouteMetric>;
    hubs: Array<HubMetric>;
    customerInsights: {
      customers: number;
      repeatCustomers: number;
      oneTimeCustomers: number;
      topCustomers: Array<{
        id: string;
        name: string;
        shipments: number;
      }>;
    };
    employees: {
      roles: Array<{
        role: string;
        employees: number;
        assignedEmployees: number;
      }>;
      total: number;
      assignedToHub: number;
      activeHubs: number;
      hubsWithActiveAssignments: number;
    };
    exceptions: Array<{
      category: string;
      events: number;
    }>;
  };
  integrations: {
    powerBiConfigured: boolean;
    powerBiMessage: string;
  };
};

export type RouteMetric = {
  id: string;
  mode: string;
  name: string;
  shipments: number;
  delayed: number;
  eligibleDelivered: number;
  delayRatePercent: number | null;
  averageTransitDays: number | null;
};

export type HubMetric = {
  id: string;
  city: string;
  shipments: number;
  delayed: number;
  delayRatePercent: number | null;
  averageTransitDays: number | null;
};

export type CompanySearchResult = {
  result_type: "shipment" | "customer" | "route";
  result_id: string;
  label: string;
  detail: string;
};

export type ShipmentInvestigationRow = {
  consignmentNo: string;
  customerName: string;
  originCity: string;
  destinationCity: string;
  routeId: string;
  mode: string;
  chargeableWeight: number | null;
  shipmentDate: string;
  expectedDeliveryDate: string | null;
  deliveryStatus: string;
  actualTransitDays: number | null;
  slaDays: number | null;
  slaStatus: "historically-delayed" | "on-time" | "active" | "unavailable";
  overdueDays: number;
  lastEventAt: string | null;
  lastEvent: string | null;
  lastLocation: string | null;
};
