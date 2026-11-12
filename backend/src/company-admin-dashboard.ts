import type { RowDataPacket } from "mysql2";
import { pool } from "./db.js";
import {
  onTimeDeliveryRate,
  previousEquivalentPeriod,
  trendGranularityForRange,
} from "./dashboard-domain.js";

export type DashboardDateRange = {
  startDate: string | null;
  endDate: string | null;
};

type SummaryRow = RowDataPacket & {
  total_shipments: number;
  delivered_shipments: number;
  active_shipments: number;
  delayed_shipments: number;
  eligible_delivered: number;
  on_time_delivered: number;
  at_risk_shipments: number;
  estimated_revenue: number | null;
  min_shipment_date: string | null;
  max_shipment_date: string | null;
};

type TrendRow = RowDataPacket & {
  period_start: string;
  shipments: number;
  delivered: number;
  active: number;
  delayed_shipments: number;
  eligible_delivered: number;
  on_time_delivered: number;
  estimated_revenue: number | null;
};

type ModeRow = RowDataPacket & {
  mode: string;
  shipments: number;
  delayed_shipments: number;
  eligible_delivered: number;
  on_time_delivered: number;
};

type RouteRow = RowDataPacket & {
  route_id: string;
  mode: string;
  route_name: string;
  shipments: number;
  delayed_shipments: number;
  eligible_delivered: number;
  actual_transit_total: number | null;
};

type HubRow = RowDataPacket & {
  hub_id: string;
  city: string;
  shipments: number;
  delayed_shipments: number;
  eligible_delivered: number;
  actual_transit_total: number | null;
};

type CustomerSummaryRow = RowDataPacket & {
  customers: number;
  repeat_customers: number;
  one_time_customers: number;
};

type TopCustomerRow = RowDataPacket & {
  customer_id: string;
  customer_name: string | null;
  shipments: number;
};

type EmployeeCoverageRow = RowDataPacket & {
  role: string;
  employees: number;
  assigned_employees: number;
};

type HubCoverageRow = RowDataPacket & {
  active_hubs: number;
  hubs_with_active_assignments: number;
};

type ExceptionRow = RowDataPacket & {
  category: string;
  events: number;
};

type FreshnessRow = RowDataPacket & {
  last_event_at: string | null;
};

type StatusRow = RowDataPacket & {
  status: string;
  shipments: number;
};

type SearchRow = RowDataPacket & {
  result_type: "shipment" | "customer" | "route";
  result_id: string;
  label: string;
  detail: string;
};

type ShipmentInvestigationDbRow = RowDataPacket & {
  consignment_no: string;
  customer_name: string | null;
  origin_city: string | null;
  destination_city: string | null;
  route_id: string;
  mode: string;
  chargeable_weight: number | null;
  shipment_date: string;
  estimated_delivery_date: string | null;
  delivery_status: string;
  actual_transit_days: number | null;
  sla_days: number | null;
  sla_due_date: string | null;
  last_event_at: string | null;
  last_event_type: string | null;
  last_event: string | null;
  last_location: string | null;
};

type Filter = {
  sql: string;
  params: Array<string | number>;
};

function shipmentFilter(companyId: number, range: DashboardDateRange, alias = "s"): Filter {
  const clauses = [`${alias}.company_id = ?`, `${alias}.shipment_date IS NOT NULL`];
  const params: Array<string | number> = [companyId];
  if (range.startDate) {
    clauses.push(`${alias}.shipment_date >= ?`);
    params.push(range.startDate);
  }
  if (range.endDate) {
    clauses.push(`${alias}.shipment_date <= ?`);
    params.push(range.endDate);
  }
  return { sql: clauses.join(" AND "), params };
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function summaryValue(row: SummaryRow | undefined) {
  const totalShipments = Number(row?.total_shipments ?? 0);
  const deliveredShipments = Number(row?.delivered_shipments ?? 0);
  const activeShipments = Number(row?.active_shipments ?? 0);
  const delayedShipments = Number(row?.delayed_shipments ?? 0);
  const eligibleDelivered = Number(row?.eligible_delivered ?? 0);
  const onTimeDelivered = Number(row?.on_time_delivered ?? 0);
  return {
    totalShipments,
    deliveredShipments,
    activeShipments,
    delayedShipments,
    eligibleDelivered,
    onTimeDelivered,
    onTimeDeliveryPercent: onTimeDeliveryRate(onTimeDelivered, eligibleDelivered),
    atRiskShipments: Number(row?.at_risk_shipments ?? 0),
    estimatedRevenue: Number(row?.estimated_revenue ?? 0),
    minShipmentDate: row?.min_shipment_date ?? null,
    maxShipmentDate: row?.max_shipment_date ?? null,
  };
}

const latestEventJoin = `
  LEFT JOIN LATERAL (
    SELECT se.event_type
      FROM shipment_events se
     WHERE se.consignment_no = s.consignment_no
       AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no = se.consignment_no) = 1
     ORDER BY se.event_time DESC, se.event_id DESC
     LIMIT 1
  ) latest ON TRUE`;

const summarySelect = `
  COUNT(DISTINCT s.consignment_no) AS total_shipments,
  COUNT(DISTINCT CASE
        WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
          OR latest.event_type = 'DELIVERED'
        THEN s.consignment_no END) AS delivered_shipments,
  COUNT(DISTINCT CASE
        WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN ('on time','delayed','delivered','completed')
          AND COALESCE(latest.event_type, '') <> 'DELIVERED'
        THEN s.consignment_no END) AS active_shipments,
  SUM(CASE
        WHEN (LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
          OR latest.event_type = 'DELIVERED')
         AND s.actual_transit_days IS NOT NULL
         AND s.actual_transit_days > COALESCE(s.sla_days, 4)
        THEN 1 ELSE 0
      END) AS delayed_shipments,
  SUM(CASE
        WHEN (LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
          OR latest.event_type = 'DELIVERED')
         AND s.actual_transit_days IS NOT NULL
        THEN 1 ELSE 0
      END) AS eligible_delivered,
  SUM(CASE
        WHEN (LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delivered','completed')
          OR latest.event_type = 'DELIVERED')
         AND s.actual_transit_days IS NOT NULL
         AND s.actual_transit_days <= COALESCE(s.sla_days, 4)
        THEN 1 ELSE 0
      END) AS on_time_delivered,
  SUM(CASE
        WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN ('on time','delayed','delivered','completed')
         AND COALESCE(latest.event_type, '') <> 'DELIVERED'
         AND s.sla_due_date < CURRENT_DATE()
        THEN 1 ELSE 0
      END) AS at_risk_shipments,
  SUM(COALESCE(s.total_amount, COALESCE(s.tariff, 0) + COALESCE(s.vas_charges, 0))) AS estimated_revenue,
  MIN(s.shipment_date) AS min_shipment_date,
  MAX(s.shipment_date) AS max_shipment_date`;

export async function getCompanyAdminDashboard(
  companyId: number,
  range: DashboardDateRange,
) {
  const filter = shipmentFilter(companyId, range);
  const [[summaryRows], [customerCountRows]] = await Promise.all([
    pool.execute<SummaryRow[]>(
      `SELECT ${summarySelect} FROM shipments s ${latestEventJoin} WHERE ${filter.sql}`,
      filter.params,
    ),
    pool.execute<Array<RowDataPacket & { total_customers: number }>>(
      "SELECT COUNT(*) AS total_customers FROM customers WHERE company_id = ?",
      [companyId],
    ),
  ]);
  const summary = summaryValue(summaryRows[0]);
  const dataRangeStart = range.startDate ?? summary.minShipmentDate;
  const dataRangeEnd = range.endDate ?? summary.maxShipmentDate;
  const trendGranularity = trendGranularityForRange(dataRangeStart, dataRangeEnd);
  const trendDateExpression =
    trendGranularity === "day"
      ? "DATE(s.shipment_date)"
      : "DATE_SUB(DATE(s.shipment_date), INTERVAL WEEKDAY(s.shipment_date) DAY)";

  const previous = previousEquivalentPeriod(range.startDate, range.endDate);
  let comparison: ReturnType<typeof summaryValue> | null = null;
  if (previous) {
    const priorFilter = shipmentFilter(companyId, previous);
    const [previousRows] = await pool.execute<SummaryRow[]>(
      `SELECT ${summarySelect} FROM shipments s ${latestEventJoin} WHERE ${priorFilter.sql}`,
      priorFilter.params,
    );
    comparison = summaryValue(previousRows[0]);
  }

  const [trendRows] = await pool.execute<TrendRow[]>(
    `SELECT ${trendDateExpression} AS period_start,
            COUNT(DISTINCT s.consignment_no) AS shipments,
            COUNT(DISTINCT CASE
              WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
              THEN s.consignment_no END) AS delivered,
            COUNT(DISTINCT CASE
              WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN ('on time','delayed','delivered','completed')
              THEN s.consignment_no END) AS active,
            SUM(LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
                AND s.actual_transit_days IS NOT NULL
                AND s.actual_transit_days > COALESCE(s.sla_days, 4)) AS delayed_shipments,
            SUM(LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
                AND s.actual_transit_days IS NOT NULL) AS eligible_delivered,
            SUM(LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delivered','completed')
                AND s.actual_transit_days IS NOT NULL
                AND s.actual_transit_days <= COALESCE(s.sla_days, 4)) AS on_time_delivered,
            SUM(COALESCE(s.total_amount, COALESCE(s.tariff, 0) + COALESCE(s.vas_charges, 0))) AS estimated_revenue
       FROM shipments s
      WHERE ${filter.sql}
      GROUP BY period_start
      ORDER BY period_start`,
    filter.params,
  );
  const [modeRows] = await pool.execute<ModeRow[]>(
    `SELECT COALESCE(NULLIF(s.mode, ''), 'Unspecified') AS mode,
            COUNT(*) AS shipments,
            SUM(LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
                AND s.actual_transit_days IS NOT NULL
                AND s.actual_transit_days > COALESCE(s.sla_days, 4)) AS delayed_shipments,
            SUM(LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
                AND s.actual_transit_days IS NOT NULL) AS eligible_delivered,
            SUM(LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delivered','completed')
                AND s.actual_transit_days IS NOT NULL
                AND s.actual_transit_days <= COALESCE(s.sla_days, 4)) AS on_time_delivered
       FROM shipments s
      WHERE ${filter.sql}
      GROUP BY mode
      ORDER BY shipments DESC`,
    filter.params,
  );
  const [statusRows] = await pool.execute<StatusRow[]>(
    `SELECT COALESCE(NULLIF(TRIM(s.delivery_status), ''), 'Unspecified') AS status,
            COUNT(DISTINCT s.consignment_no) AS shipments
       FROM shipments s
      WHERE ${filter.sql}
      GROUP BY status
      ORDER BY shipments DESC, status`,
    filter.params,
  );

  const [routeRows] = await pool.execute<RouteRow[]>(
    `SELECT r.route_id, r.mode,
            CONCAT(oh.city, ' → ', dh.city) AS route_name,
            COUNT(DISTINCT s.consignment_no) AS shipments,
            COUNT(DISTINCT CASE
              WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
               AND s.actual_transit_days IS NOT NULL
               AND s.actual_transit_days > COALESCE(s.sla_days, 4)
              THEN s.consignment_no END) AS delayed_shipments,
            COUNT(DISTINCT CASE
              WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
               AND s.actual_transit_days IS NOT NULL
              THEN s.consignment_no END) AS eligible_delivered,
            SUM(CASE
              WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
               AND s.actual_transit_days IS NOT NULL
              THEN s.actual_transit_days ELSE 0 END) AS actual_transit_total
       FROM shipments s
       JOIN routes r
         ON r.route_id = s.route_id
        AND r.mode = s.mode
        AND r.company_id = s.company_id
       JOIN hubs oh ON oh.hub_id = r.origin_hub_id AND oh.company_id = s.company_id
       JOIN hubs dh ON dh.hub_id = r.destination_hub_id AND dh.company_id = s.company_id
      WHERE ${filter.sql}
      GROUP BY r.route_id, r.mode, oh.city, dh.city
      ORDER BY shipments DESC`,
    filter.params,
  );

  const [hubRows] = await pool.execute<HubRow[]>(
    `WITH hub_legs AS (
       SELECT s.consignment_no, s.origin_hub_id AS hub_id, s.actual_transit_days,
              s.sla_days, s.delivery_status
         FROM shipments s
        WHERE ${filter.sql}
       UNION
       SELECT s.consignment_no, s.destination_hub_id AS hub_id, s.actual_transit_days,
              s.sla_days, s.delivery_status
         FROM shipments s
        WHERE ${filter.sql}
     )
     SELECT h.hub_id, h.city,
            COUNT(DISTINCT hl.consignment_no) AS shipments,
            COUNT(DISTINCT CASE
              WHEN LOWER(COALESCE(hl.delivery_status, '')) IN ('on time','delayed','delivered','completed')
               AND hl.actual_transit_days IS NOT NULL
               AND hl.actual_transit_days > COALESCE(hl.sla_days, 4)
              THEN hl.consignment_no END) AS delayed_shipments,
            COUNT(DISTINCT CASE
              WHEN LOWER(COALESCE(hl.delivery_status, '')) IN ('on time','delayed','delivered','completed')
               AND hl.actual_transit_days IS NOT NULL
              THEN hl.consignment_no END) AS eligible_delivered,
            AVG(CASE
              WHEN LOWER(COALESCE(hl.delivery_status, '')) IN ('on time','delayed','delivered','completed')
               AND hl.actual_transit_days IS NOT NULL
              THEN hl.actual_transit_days END) AS actual_transit_total
       FROM hub_legs hl
       JOIN hubs h ON h.hub_id = hl.hub_id AND h.company_id = ?
      GROUP BY h.hub_id, h.city
      ORDER BY shipments DESC`,
    [...filter.params, ...filter.params, companyId],
  );

  const [customerSummaryRows] = await pool.execute<CustomerSummaryRow[]>(
    `SELECT COUNT(*) AS customers,
            SUM(customer_shipments.shipments > 1) AS repeat_customers,
            SUM(customer_shipments.shipments = 1) AS one_time_customers
       FROM (
         SELECT s.customer_id, COUNT(*) AS shipments
           FROM shipments s
           JOIN customers c
             ON c.customer_id = s.customer_id
            AND c.company_id = s.company_id
          WHERE ${filter.sql}
          GROUP BY s.customer_id
       ) AS customer_shipments`,
    filter.params,
  );
  const [topCustomerRows] = await pool.execute<TopCustomerRow[]>(
    `SELECT c.customer_id, c.customer_name, COUNT(*) AS shipments
       FROM shipments s
       JOIN customers c
         ON c.customer_id = s.customer_id
        AND c.company_id = s.company_id
      WHERE ${filter.sql}
      GROUP BY c.customer_id, c.customer_name
      ORDER BY shipments DESC, c.customer_name
      LIMIT 10`,
    filter.params,
  );

  const [employeeRows] = await pool.execute<EmployeeCoverageRow[]>(
    `SELECT e.role, COUNT(*) AS employees,
            SUM(EXISTS (
              SELECT 1
                FROM employee_hubs eh
                JOIN hubs h ON h.hub_id = eh.hub_id
               WHERE eh.employee_id = e.employee_id
                 AND LOWER(COALESCE(eh.status, '')) = 'active'
                 AND LOWER(COALESCE(h.status, '')) = 'active'
                 AND h.company_id = e.company_id
            )) AS assigned_employees
       FROM employees e
      WHERE e.company_id = ?
      GROUP BY e.role
      ORDER BY employees DESC`,
    [companyId],
  );
  const [hubCoverageRows] = await pool.execute<HubCoverageRow[]>(
    `SELECT COUNT(*) AS active_hubs,
            COUNT(DISTINCT CASE WHEN EXISTS (
              SELECT 1
                FROM employee_hubs eh
               WHERE eh.hub_id = h.hub_id
                 AND LOWER(COALESCE(eh.status, '')) = 'active'
            ) THEN h.hub_id END) AS hubs_with_active_assignments
       FROM hubs h
      WHERE h.company_id = ?
        AND LOWER(COALESCE(h.status, '')) = 'active'`,
    [companyId],
  );

  const [exceptionRows] = await pool.execute<ExceptionRow[]>(
    `SELECT CASE
              WHEN LOWER(COALESCE(se.event_type, '')) LIKE '%weather%' THEN 'Weather'
              WHEN LOWER(COALESCE(se.event_type, '')) LIKE '%damage%' THEN 'Damage'
              WHEN LOWER(COALESCE(se.event_type, '')) LIKE '%lost%' THEN 'Lost'
              WHEN LOWER(COALESCE(se.event_type, '')) LIKE '%delay%'
                OR LOWER(COALESCE(se.event_status, '')) LIKE '%delay%' THEN 'Delay'
              WHEN LOWER(COALESCE(se.event_type, '')) LIKE '%exception%'
                OR LOWER(COALESCE(se.event_status, '')) LIKE '%exception%' THEN 'Other exception'
              ELSE 'Other'
            END AS category,
            COUNT(*) AS events
       FROM shipment_events se
       JOIN shipments s ON s.consignment_no = se.consignment_no
      WHERE s.company_id = ?
        AND se.event_time IS NOT NULL
        AND (LOWER(COALESCE(se.event_type, '')) LIKE '%exception%'
          OR LOWER(COALESCE(se.event_status, '')) LIKE '%exception%'
          OR LOWER(COALESCE(se.event_type, '')) LIKE '%delay%'
          OR LOWER(COALESCE(se.event_status, '')) LIKE '%delay%'
          OR LOWER(COALESCE(se.event_type, '')) LIKE '%damage%'
          OR LOWER(COALESCE(se.event_type, '')) LIKE '%lost%'
          OR LOWER(COALESCE(se.event_type, '')) LIKE '%weather%')
        ${range.startDate ? "AND s.shipment_date >= ?" : ""}
        ${range.endDate ? "AND s.shipment_date <= ?" : ""}
      GROUP BY category
      ORDER BY events DESC`,
    [
      companyId,
      ...(range.startDate ? [range.startDate] : []),
      ...(range.endDate ? [range.endDate] : []),
    ],
  );

  const [freshnessRows] = await pool.execute<FreshnessRow[]>(
    `SELECT MAX(se.event_time) AS last_event_at
       FROM shipment_events se
       JOIN shipments s ON s.consignment_no = se.consignment_no
      WHERE s.company_id = ?`,
    [companyId],
  );

  const routes = routeRows.map((row) => ({
    id: row.route_id,
    mode: row.mode,
    name: row.route_name,
    shipments: Number(row.shipments),
    delayed: Number(row.delayed_shipments),
      eligibleDelivered: Number(row.eligible_delivered),
    delayRatePercent: percent(Number(row.delayed_shipments), Number(row.eligible_delivered)),
    averageTransitDays:
      Number(row.eligible_delivered) > 0
        ? Number(row.actual_transit_total ?? 0) / Number(row.eligible_delivered)
        : null,
  }));
  const hubs = hubRows.map((row) => ({
    id: row.hub_id,
    city: row.city,
    shipments: Number(row.shipments),
    delayed: Number(row.delayed_shipments),
    delayRatePercent: percent(Number(row.delayed_shipments), Number(row.eligible_delivered)),
    averageTransitDays:
      row.actual_transit_total === null ? null : Number(row.actual_transit_total),
  }));

  const customerSummary = customerSummaryRows[0];
  const employees = employeeRows.map((row) => ({
    role: row.role,
    employees: Number(row.employees),
    assignedEmployees: Number(row.assigned_employees),
  }));
  const hubCoverage = hubCoverageRows[0];
  return {
    generatedAt: new Date().toISOString(),
    dataStatus: "DATABASE_SNAPSHOT",
    range: {
      requestedStartDate: range.startDate,
      requestedEndDate: range.endDate,
      availableStartDate: summary.minShipmentDate,
      availableEndDate: summary.maxShipmentDate,
      trendGranularity,
    },
    freshness: {
      latestShipmentEventAt: freshnessRows[0]?.last_event_at ?? null,
      note: freshnessRows[0]?.last_event_at
        ? "Last event time in the available event records; not a live feed indicator."
        : "No shipment event records are available.",
    },
    kpis: {
      ...summary,
      totalCustomers: Number(customerCountRows[0]?.total_customers ?? 0),
      onTimeDeliveryPercent: summary.onTimeDeliveryPercent,
      estimatedRevenueSource: "total_amount; tariff + VAS charges only when total_amount is null",
      baselineSlaDays: 4,
      baselineSlaNote: "Fallback only, derived from this dataset; not an official company SLA.",
    },
    comparison: comparison
      ? {
          previousPeriod: previous,
          totalShipments: comparison.totalShipments,
          delayedShipments: comparison.delayedShipments,
          onTimeDeliveryPercent: comparison.onTimeDeliveryPercent,
          estimatedRevenue: comparison.estimatedRevenue,
        }
      : null,
    charts: {
      timeline: trendRows.map((row) => ({
        periodStart: String(row.period_start).slice(0, 10),
        shipments: Number(row.shipments),
        delivered: Number(row.delivered),
        active: Number(row.active),
        delayed: Number(row.delayed_shipments),
        onTimeDeliveryPercent: percent(
          Number(row.on_time_delivered),
          Number(row.eligible_delivered),
        ),
        estimatedRevenue: Number(row.estimated_revenue ?? 0),
      })),
      modes: modeRows.map((row) => ({
        mode: row.mode,
        shipments: Number(row.shipments),
        delayed: Number(row.delayed_shipments),
        onTimeDeliveryPercent: percent(
          Number(row.on_time_delivered),
          Number(row.eligible_delivered),
        ),
        onTimeDelivered: Number(row.on_time_delivered),
        eligibleDelivered: Number(row.eligible_delivered),
      })),
      statuses: statusRows.map((row) => ({
        status: row.status,
        shipments: Number(row.shipments),
        operationalStage: ["on time", "delayed", "delivered", "completed"].includes(
          row.status.trim().toLowerCase(),
        )
          ? "terminal"
          : "active",
      })),
      routesByVolume: routes.slice(0, 10),
      routesByDelay: routes
        .filter((route) => route.eligibleDelivered >= 20)
        .sort((left, right) => (right.delayRatePercent ?? -1) - (left.delayRatePercent ?? -1))
        .slice(0, 10),
      hubs,
      customerInsights: {
        customers: Number(customerSummary?.customers ?? 0),
        repeatCustomers: Number(customerSummary?.repeat_customers ?? 0),
        oneTimeCustomers: Number(customerSummary?.one_time_customers ?? 0),
        topCustomers: topCustomerRows.map((row) => ({
          id: row.customer_id,
          name: row.customer_name ?? "Unnamed customer",
          shipments: Number(row.shipments),
        })),
      },
      employees: {
        roles: employees,
        total: employees.reduce((total, row) => total + row.employees, 0),
        assignedToHub: employees.reduce((total, row) => total + row.assignedEmployees, 0),
        activeHubs: Number(hubCoverage?.active_hubs ?? 0),
        hubsWithActiveAssignments: Number(hubCoverage?.hubs_with_active_assignments ?? 0),
      },
      exceptions: exceptionRows.map((row) => ({
        category: row.category,
        events: Number(row.events),
      })),
    },
    integrations: {
      powerBiConfigured: false,
      powerBiMessage:
        "Power BI secure embed configuration is not present. Configure server-side workspace, report, and embed-token flow before enabling reports.",
    },
  };
}

export async function listCompanyShipments(
  companyId: number,
  range: DashboardDateRange,
  filters: {
    status: string | null;
    routeId: string | null;
    hubId: string | null;
    customerId: string | null;
    consignmentNo: string | null;
  },
) {
  const filter = shipmentFilter(companyId, range);
  const clauses = [filter.sql];
  const params: Array<string | number> = [...filter.params];
  if (filters.status) {
    clauses.push("s.delivery_status = ?");
    params.push(filters.status);
  }
  if (filters.routeId) {
    clauses.push("s.route_id = ?");
    params.push(filters.routeId);
  }
  if (filters.hubId) {
    clauses.push("(s.origin_hub_id = ? OR s.destination_hub_id = ?)");
    params.push(filters.hubId, filters.hubId);
  }
  if (filters.customerId) {
    clauses.push("s.customer_id = ?");
    params.push(filters.customerId);
  }
  if (filters.consignmentNo) {
    clauses.push("s.consignment_no = ?");
    params.push(filters.consignmentNo);
  }

  const [rows] = await pool.execute<ShipmentInvestigationDbRow[]>(
    `SELECT s.consignment_no, COALESCE(c.customer_name, 'Customer unavailable') AS customer_name,
            oh.city AS origin_city, dh.city AS destination_city,
            s.route_id, s.mode, s.chargeable_weight, s.shipment_date,
            s.estimated_delivery_date, s.delivery_status, s.actual_transit_days,
            s.sla_days, s.sla_due_date,
            latest.event_time AS last_event_at, latest.event_type AS last_event_type,
            latest.event_label AS last_event,
            latest.last_location
       FROM shipments s
       LEFT JOIN customers c
         ON c.customer_id = s.customer_id AND c.company_id = s.company_id
       LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
       LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
       LEFT JOIN LATERAL (
         SELECT se.event_time, se.event_type,
                COALESCE(NULLIF(se.event_status, ''), NULLIF(se.event_type, ''), 'Recorded event') AS event_label,
                h.city AS last_location
           FROM shipment_events se
           LEFT JOIN hubs h ON h.hub_id = se.hub_id AND h.company_id = s.company_id
          WHERE se.consignment_no = s.consignment_no
            AND EXISTS (
              SELECT 1
                FROM shipments event_shipment
               WHERE event_shipment.consignment_no = se.consignment_no
                 AND event_shipment.company_id = s.company_id
            )
          ORDER BY se.event_time DESC, se.event_id DESC
          LIMIT 1
       ) AS latest ON TRUE
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.shipment_date DESC, s.consignment_no
      LIMIT 50`,
    params,
  );

  return rows.map((row) => {
    const status = row.delivery_status.trim().toLowerCase();
    const terminal = ["on time", "delayed", "delivered", "completed"].includes(status) ||
      row.last_event_type === "DELIVERED";
    const actualTransit = row.actual_transit_days === null ? null : Number(row.actual_transit_days);
    const slaDays = row.sla_days === null ? null : Number(row.sla_days);
    const exceededSla =
      terminal && actualTransit !== null && actualTransit > (slaDays ?? 4);
    const overdueDays =
      !terminal && row.sla_due_date
        ? Math.max(
            0,
            Math.floor(
              (Date.now() - new Date(`${String(row.sla_due_date).slice(0, 10)}T00:00:00Z`).getTime()) /
                86_400_000,
            ),
          )
        : 0;
    return {
      consignmentNo: row.consignment_no,
      customerName: row.customer_name ?? "Customer unavailable",
      originCity: row.origin_city ?? "Unavailable",
      destinationCity: row.destination_city ?? "Unavailable",
      routeId: row.route_id,
      mode: row.mode,
      chargeableWeight: row.chargeable_weight === null ? null : Number(row.chargeable_weight),
      shipmentDate: String(row.shipment_date).slice(0, 10),
      expectedDeliveryDate: row.estimated_delivery_date,
      deliveryStatus: row.last_event_type === "DELIVERED" ? "Delivered" : row.delivery_status,
      recordedOutcome: row.delivery_status,
      actualTransitDays: actualTransit,
      slaDays,
      slaStatus: exceededSla
        ? "historically-delayed"
        : terminal && actualTransit !== null
          ? "on-time"
          : terminal
            ? "unavailable"
            : "active",
      overdueDays,
      lastEventAt: row.last_event_at,
      lastEvent: row.last_event,
      lastLocation: row.last_location,
    };
  });
}

export async function searchCompanyRecords(companyId: number, term: string) {
  const pattern = `%${term}%`;
  const [shipmentRows] = await pool.execute<SearchRow[]>(
    `SELECT 'shipment' AS result_type, s.consignment_no AS result_id,
            s.consignment_no AS label, CONCAT(COALESCE(s.mode, 'Mode unavailable'), ' · ', COALESCE(s.delivery_status, 'Status unavailable')) AS detail
       FROM shipments s
      WHERE s.company_id = ? AND s.consignment_no LIKE ?
      ORDER BY s.shipment_date DESC
      LIMIT 5`,
    [companyId, pattern],
  );
  const [customerRows] = await pool.execute<SearchRow[]>(
    `SELECT 'customer' AS result_type, c.customer_id AS result_id,
            COALESCE(c.customer_name, c.customer_id) AS label,
            COALESCE(c.customer_city, 'Customer') AS detail
       FROM customers c
      WHERE c.company_id = ? AND (c.customer_name LIKE ? OR c.customer_id LIKE ?)
      ORDER BY c.customer_name
      LIMIT 5`,
    [companyId, pattern, pattern],
  );
  const [routeRows] = await pool.execute<SearchRow[]>(
    `SELECT 'route' AS result_type, r.route_id AS result_id,
            CONCAT(oh.city, ' → ', dh.city) AS label, r.mode AS detail
       FROM routes r
       JOIN hubs oh ON oh.hub_id = r.origin_hub_id AND oh.company_id = r.company_id
       JOIN hubs dh ON dh.hub_id = r.destination_hub_id AND dh.company_id = r.company_id
      WHERE r.company_id = ? AND (r.route_id LIKE ? OR oh.city LIKE ? OR dh.city LIKE ?)
      ORDER BY r.route_id
      LIMIT 5`,
    [companyId, pattern, pattern, pattern],
  );
  return [...shipmentRows, ...customerRows, ...routeRows];
}
