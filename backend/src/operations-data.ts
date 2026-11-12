import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";

type QueryExecutor = Pick<PoolConnection, "execute">;

type HubRow = RowDataPacket & {
  hubId: string;
  city: string;
};

type ShipmentSummaryRow = RowDataPacket & {
  total: number;
  inTransit: number;
  delayedCount: number;
  approachingSla: number;
  staleTracking: number;
};

type Scope = {
  sql: string;
  params: Array<string | number>;
};

export type OperationsShipmentFilters = {
  page: number;
  pageSize: number;
  search: string;
  status: string;
  hubId: string;
  origin: string;
  destination: string;
  mode: string;
  risk: "active" | "delayed" | "approaching" | "stale" | "";
  sortBy: "shipmentDate" | "status" | "expectedDeliveryDate" | "consignmentNo";
  direction: "asc" | "desc";
};

function inClause(values: string[]): string {
  return values.map(() => "?").join(", ");
}

function shipmentScope(companyId: number, hubIds: string[], alias = "s"): Scope {
  const placeholders = inClause(hubIds);
  return {
    sql: `(${alias}.origin_hub_id IN (${placeholders})
      OR ${alias}.destination_hub_id IN (${placeholders})
      OR EXISTS (
        SELECT 1
          FROM shipment_events current_event
         WHERE current_event.consignment_no = ${alias}.consignment_no
           AND current_event.hub_id IN (${placeholders})
           AND EXISTS (
             SELECT 1 FROM shipments event_shipment
              WHERE event_shipment.consignment_no = current_event.consignment_no
                AND event_shipment.company_id = ${alias}.company_id
           )
           AND NOT EXISTS (
             SELECT 1
               FROM shipment_events newer_event
              WHERE newer_event.consignment_no = current_event.consignment_no
                AND (newer_event.event_time > current_event.event_time
                  OR (newer_event.event_time = current_event.event_time
                    AND newer_event.event_id > current_event.event_id))
                AND EXISTS (
                  SELECT 1 FROM shipments newer_shipment
                   WHERE newer_shipment.consignment_no = newer_event.consignment_no
                     AND newer_shipment.company_id = ${alias}.company_id
                )
           )
      ))`,
    params: [...hubIds, ...hubIds, ...hubIds],
  };
}

async function getAssignedHubs(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
): Promise<HubRow[]> {
  const [hubs] = await executor.execute<HubRow[]>(
    `SELECT h.hub_id AS hubId, h.city
       FROM employee_hubs eh
       JOIN employees e ON e.employee_id = eh.employee_id
        AND e.company_id = ? AND UPPER(e.status) = 'ACTIVE'
       JOIN hubs h ON h.hub_id = eh.hub_id
        AND h.company_id = e.company_id AND UPPER(h.status) = 'ACTIVE'
      WHERE eh.employee_id = ? AND UPPER(eh.status) = 'ACTIVE'
      ORDER BY h.city, h.hub_id`,
    [companyId, employeeId],
  );
  return hubs;
}

export async function getOperationsAssignedHubs(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
) {
  return getAssignedHubs(executor, companyId, employeeId);
}

function percent(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10;
}

export async function getOperationsWorkspace(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
) {
  const hubs = await getAssignedHubs(executor, companyId, employeeId);
  if (hubs.length === 0) {
    return {
      scope: { assignedHubCount: 0, shipmentVisibility: "origin-destination-latest-recorded-event" },
      hubs: [],
      kpis: { totalShipments: 0, inTransit: 0, delayed: 0, approachingSla: 0, staleTracking: 0 },
      statuses: [],
      trend: [],
      hubWorkload: [],
      routes: [],
      team: [],
      exceptions: [],
      capabilities: { taskAssignments: false, notifications: false, shipmentActions: false },
    };
  }

  const hubIds = hubs.map((hub) => hub.hubId);
  const scope = shipmentScope(companyId, hubIds);
  const [summaryRows] = await executor.execute<ShipmentSummaryRow[]>(
    `SELECT COUNT(DISTINCT s.consignment_no) AS total,
            COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN
              ('on time','delayed','delivered','completed')
              AND COALESCE(latest.event_type, '') <> 'DELIVERED'
              THEN s.consignment_no END) AS inTransit,
            COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) = 'delayed'
              OR (LOWER(COALESCE(s.delivery_status, '')) NOT IN
                ('on time','delayed','delivered','completed')
                  AND COALESCE(latest.event_type, '') <> 'DELIVERED'
                  AND s.sla_due_date < CURRENT_DATE()) THEN s.consignment_no END) AS delayedCount,
            COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN
                ('on time','delayed','delivered','completed')
              AND COALESCE(latest.event_type, '') <> 'DELIVERED'
              AND s.sla_due_date >= CURRENT_DATE()
              AND s.sla_due_date < DATE_ADD(CURRENT_DATE(), INTERVAL 3 DAY)
              THEN s.consignment_no END) AS approachingSla,
            COUNT(DISTINCT CASE WHEN latest.event_type <> 'DELIVERED'
              AND latest.event_time < DATE_SUB(NOW(), INTERVAL 48 HOUR)
              THEN s.consignment_no END) AS staleTracking
       FROM shipments s
       LEFT JOIN LATERAL (
         SELECT se.event_time, se.event_type
           FROM shipment_events se
          WHERE se.consignment_no = s.consignment_no
            AND EXISTS (SELECT 1 FROM shipments es
                         WHERE es.consignment_no = se.consignment_no
                           AND es.company_id = s.company_id)
          ORDER BY se.event_time DESC, se.event_id DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE s.company_id = ? AND ${scope.sql}`,
    [companyId, ...scope.params],
  );

  const [statusRows] = await executor.execute<Array<RowDataPacket & { status: string; total: number }>>(
    `SELECT COALESCE(NULLIF(s.delivery_status, ''), 'Unspecified') AS status,
            COUNT(DISTINCT s.consignment_no) AS total
       FROM shipments s
      WHERE s.company_id = ? AND ${scope.sql}
      GROUP BY COALESCE(NULLIF(s.delivery_status, ''), 'Unspecified')
      ORDER BY total DESC, status`,
    [companyId, ...scope.params],
  );

  const [trendRows] = await executor.execute<Array<RowDataPacket & { day: string; total: number }>>(
    `SELECT s.shipment_date AS day, COUNT(DISTINCT s.consignment_no) AS total
       FROM shipments s
      WHERE s.company_id = ? AND s.shipment_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 29 DAY)
        AND ${scope.sql}
      GROUP BY s.shipment_date ORDER BY s.shipment_date`,
    [companyId, ...scope.params],
  );

  const hubWorkload = await Promise.all(hubs.map(async (hub) => {
    const hubScope = {
      sql: `(s.origin_hub_id = ? OR s.destination_hub_id = ? OR EXISTS (
        SELECT 1 FROM shipment_events current_event
         WHERE current_event.consignment_no = s.consignment_no
           AND current_event.hub_id = ?
           AND EXISTS (SELECT 1 FROM shipments event_shipment
                        WHERE event_shipment.consignment_no = current_event.consignment_no
                          AND event_shipment.company_id = s.company_id)
           AND NOT EXISTS (
             SELECT 1 FROM shipment_events newer_event
              WHERE newer_event.consignment_no = current_event.consignment_no
                AND (newer_event.event_time > current_event.event_time
                  OR (newer_event.event_time = current_event.event_time
                    AND newer_event.event_id > current_event.event_id))
                AND EXISTS (SELECT 1 FROM shipments newer_shipment
                             WHERE newer_shipment.consignment_no = newer_event.consignment_no
                               AND newer_shipment.company_id = s.company_id)
           )))`,
      params: [hub.hubId, hub.hubId, hub.hubId],
    };
    const [rows] = await executor.execute<Array<RowDataPacket & {
      shipments: number;
      active: number;
      delayedCount: number;
      eligibleDelivered: number;
      historicalDelays: number;
    }>>(
      `SELECT COUNT(DISTINCT s.consignment_no) AS shipments,
              COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN
                ('on time','delayed','delivered','completed') THEN s.consignment_no END) AS active,
              COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) = 'delayed'
                OR (LOWER(COALESCE(s.delivery_status, '')) NOT IN
                  ('on time','delayed','delivered','completed')
                  AND s.sla_due_date < CURRENT_DATE()) THEN s.consignment_no END) AS delayedCount,
              COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) IN
                ('on time','delayed','delivered','completed')
                AND s.actual_transit_days IS NOT NULL THEN s.consignment_no END) AS eligibleDelivered,
              COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) IN
                ('on time','delayed','delivered','completed')
                AND s.actual_transit_days > COALESCE(s.sla_days, 4)
                THEN s.consignment_no END) AS historicalDelays
         FROM hubs h
         LEFT JOIN shipments s ON s.company_id = h.company_id AND ${hubScope.sql}
        WHERE h.company_id = ? AND h.hub_id = ?
        GROUP BY h.hub_id`,
      [...hubScope.params, companyId, hub.hubId],
    );
    const row = rows[0];
    const eligible = Number(row?.eligibleDelivered ?? 0);
    const historicalDelays = Number(row?.historicalDelays ?? 0);
    return {
      id: hub.hubId,
      city: hub.city,
      shipments: Number(row?.shipments ?? 0),
      active: Number(row?.active ?? 0),
      delayed: Number(row?.delayedCount ?? 0),
      eligibleDelivered: eligible,
      historicalDelayPercent: percent(historicalDelays, eligible),
    };
  }));

  const [routeRows] = await executor.execute<Array<RowDataPacket & {
    id: string;
    mode: string;
    shipments: number;
    delayedCount: number;
    eligibleDelivered: number;
    historicalDelays: number;
  }>>(
    `SELECT r.route_id AS id, r.mode, COUNT(DISTINCT s.consignment_no) AS shipments,
            COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) = 'delayed'
              OR (LOWER(COALESCE(s.delivery_status, '')) NOT IN
                ('on time','delayed','delivered','completed')
                AND s.sla_due_date < CURRENT_DATE()) THEN s.consignment_no END) AS delayedCount,
            COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) IN
              ('on time','delayed','delivered','completed')
              AND s.actual_transit_days IS NOT NULL THEN s.consignment_no END) AS eligibleDelivered,
            COUNT(DISTINCT CASE WHEN LOWER(COALESCE(s.delivery_status, '')) IN
              ('on time','delayed','delivered','completed')
              AND s.actual_transit_days > COALESCE(s.sla_days, 4)
              THEN s.consignment_no END) AS historicalDelays
       FROM routes r
       JOIN shipments s ON s.route_id = r.route_id AND s.company_id = r.company_id
      WHERE r.company_id = ? AND ${scope.sql}
        AND (r.origin_hub_id IN (${inClause(hubIds)})
          OR r.destination_hub_id IN (${inClause(hubIds)}))
      GROUP BY r.route_id, r.mode ORDER BY shipments DESC, r.route_id`,
    [companyId, ...scope.params, ...hubIds, ...hubIds],
  );

  const [teamRows] = await executor.execute<Array<RowDataPacket & {
    employeeId: string;
    name: string;
    role: string;
    hubId: string;
    city: string;
  }>>(
    `SELECT DISTINCT e.employee_id AS employeeId, e.name,
            CASE WHEN UPPER(e.role) = 'ADMIN' THEN 'COMPANY_ADMIN' ELSE UPPER(e.role) END AS role,
            h.hub_id AS hubId, h.city
       FROM employee_hubs eh
       JOIN employees e ON e.employee_id = eh.employee_id
        AND e.company_id = ? AND UPPER(e.status) = 'ACTIVE'
       JOIN hubs h ON h.hub_id = eh.hub_id
        AND h.company_id = e.company_id AND UPPER(h.status) = 'ACTIVE'
      WHERE eh.status = 'Active' AND eh.hub_id IN (${inClause(hubIds)})
      ORDER BY h.city, e.name, e.employee_id`,
    [companyId, ...hubIds],
  );

  const [exceptionRows] = await executor.execute<Array<RowDataPacket & {
    consignmentNo: string;
    status: string;
    slaDueDate: string | null;
    lastEventAt: string | null;
    lastLocation: string | null;
    reason: string;
    priority: number;
  }>>(
    `SELECT s.consignment_no AS consignmentNo, s.delivery_status AS status,
            s.sla_due_date AS slaDueDate, latest.event_time AS lastEventAt,
            latest.city AS lastLocation,
            CASE
              WHEN LOWER(COALESCE(s.delivery_status, '')) = 'delayed' THEN 'Recorded delayed status'
              WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN
                ('on time','delayed','delivered','completed') AND s.sla_due_date < CURRENT_DATE()
                THEN CONCAT('Past recorded SLA due date by ', DATEDIFF(CURRENT_DATE(), s.sla_due_date), ' days')
              WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN
                ('on time','delayed','delivered','completed') AND s.sla_due_date < DATE_ADD(CURRENT_DATE(), INTERVAL 3 DAY)
                THEN 'Recorded SLA due date within 2 days'
              WHEN latest.event_time < DATE_SUB(NOW(), INTERVAL 48 HOUR)
                THEN 'No recorded event in the last 48 hours'
            END AS reason,
            CASE
              WHEN LOWER(COALESCE(s.delivery_status, '')) = 'delayed' THEN 1
              WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN
                ('on time','delayed','delivered','completed') AND s.sla_due_date < CURRENT_DATE() THEN 2
              WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN
                ('on time','delayed','delivered','completed') AND s.sla_due_date < DATE_ADD(CURRENT_DATE(), INTERVAL 3 DAY) THEN 3
              ELSE 4
            END AS priority
       FROM shipments s
       LEFT JOIN LATERAL (
         SELECT se.event_time, h.city
           FROM shipment_events se
           LEFT JOIN hubs h ON h.hub_id = se.hub_id AND h.company_id = s.company_id
          WHERE se.consignment_no = s.consignment_no
            AND EXISTS (SELECT 1 FROM shipments es WHERE es.consignment_no = se.consignment_no AND es.company_id = s.company_id)
          ORDER BY se.event_time DESC, se.event_id DESC LIMIT 1
       ) latest ON TRUE
      WHERE s.company_id = ? AND ${scope.sql}
        AND (LOWER(COALESCE(s.delivery_status, '')) = 'delayed'
          OR (LOWER(COALESCE(s.delivery_status, '')) NOT IN ('on time','delayed','delivered','completed')
            AND s.sla_due_date < DATE_ADD(CURRENT_DATE(), INTERVAL 3 DAY))
          OR latest.event_time < DATE_SUB(NOW(), INTERVAL 48 HOUR))
      ORDER BY priority, s.sla_due_date, latest.event_time
      LIMIT 100`,
    [companyId, ...scope.params],
  );

  const summary = summaryRows[0];
  return {
    scope: { assignedHubCount: hubs.length, shipmentVisibility: "origin-destination-latest-recorded-event" },
    hubs: hubs.map((hub) => ({ id: hub.hubId, city: hub.city })),
    kpis: {
      totalShipments: Number(summary?.total ?? 0),
      inTransit: Number(summary?.inTransit ?? 0),
      delayed: Number(summary?.delayedCount ?? 0),
      approachingSla: Number(summary?.approachingSla ?? 0),
      staleTracking: Number(summary?.staleTracking ?? 0),
    },
    statuses: statusRows.map((row) => ({ status: row.status, shipments: Number(row.total) })),
    trend: trendRows.map((row) => ({ day: String(row.day).slice(0, 10), shipments: Number(row.total) })),
    hubWorkload,
    routes: routeRows.map((row) => {
      const eligible = Number(row.eligibleDelivered);
      return {
        id: row.id,
        mode: row.mode,
        shipments: Number(row.shipments),
        delayed: Number(row.delayedCount),
        eligibleDelivered: eligible,
        historicalDelayPercent: percent(Number(row.historicalDelays), eligible),
      };
    }),
    team: teamRows,
    exceptions: exceptionRows.map((row) => ({ ...row, priority: Number(row.priority) })),
    capabilities: { taskAssignments: false, notifications: false, shipmentActions: false },
  };
}

export async function listOperationsShipments(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
  filters: OperationsShipmentFilters,
) {
  const hubs = await getAssignedHubs(executor, companyId, employeeId);
  if (!hubs.length) return { shipments: [], total: 0, page: filters.page, pageSize: filters.pageSize };

  const hubIds = hubs.map((hub) => hub.hubId);
  const scope = shipmentScope(companyId, hubIds);
  const clauses = ["s.company_id = ?", scope.sql];
  const params: Array<string | number> = [companyId, ...scope.params];
  const escapedSearch = `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`;
  if (filters.search) {
    clauses.push("s.consignment_no LIKE ?");
    params.push(escapedSearch);
  }
  if (filters.status) {
    clauses.push("s.delivery_status = ?");
    params.push(filters.status);
  }
  if (filters.hubId && hubIds.includes(filters.hubId)) {
    clauses.push("(s.origin_hub_id = ? OR s.destination_hub_id = ? OR EXISTS (SELECT 1 FROM shipment_events at_hub WHERE at_hub.consignment_no = s.consignment_no AND at_hub.hub_id = ? AND EXISTS (SELECT 1 FROM shipments current_shipment WHERE current_shipment.consignment_no = at_hub.consignment_no AND current_shipment.company_id = s.company_id) AND NOT EXISTS (SELECT 1 FROM shipment_events newer WHERE newer.consignment_no = at_hub.consignment_no AND (newer.event_time > at_hub.event_time OR (newer.event_time = at_hub.event_time AND newer.event_id > at_hub.event_id)) AND EXISTS (SELECT 1 FROM shipments newer_shipment WHERE newer_shipment.consignment_no = newer.consignment_no AND newer_shipment.company_id = s.company_id))))");
    params.push(filters.hubId, filters.hubId, filters.hubId);
  } else if (filters.hubId) {
    return { shipments: [], total: 0, page: filters.page, pageSize: filters.pageSize };
  }
  if (filters.origin) {
    clauses.push("oh.city LIKE ?");
    params.push(`%${filters.origin.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (filters.destination) {
    clauses.push("dh.city LIKE ?");
    params.push(`%${filters.destination.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (filters.mode) {
    clauses.push("s.mode = ?");
    params.push(filters.mode);
  }
  const terminal = "LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')";
  if (filters.risk === "active") {
    clauses.push(`NOT ${terminal}`);
  } else if (filters.risk === "delayed") {
    clauses.push(`(LOWER(COALESCE(s.delivery_status, '')) = 'delayed' OR (NOT ${terminal} AND s.sla_due_date < CURRENT_DATE()))`);
  } else if (filters.risk === "approaching") {
    clauses.push(`(NOT ${terminal} AND s.sla_due_date >= CURRENT_DATE() AND s.sla_due_date < DATE_ADD(CURRENT_DATE(), INTERVAL 3 DAY))`);
  } else if (filters.risk === "stale") {
    clauses.push("EXISTS (SELECT 1 FROM shipment_events stale_event WHERE stale_event.consignment_no = s.consignment_no AND EXISTS (SELECT 1 FROM shipments es WHERE es.consignment_no = stale_event.consignment_no AND es.company_id = s.company_id) AND stale_event.event_time < DATE_SUB(NOW(), INTERVAL 48 HOUR) AND NOT EXISTS (SELECT 1 FROM shipment_events newer WHERE newer.consignment_no = stale_event.consignment_no AND (newer.event_time > stale_event.event_time OR (newer.event_time = stale_event.event_time AND newer.event_id > stale_event.event_id))))");
  }

  const where = clauses.join(" AND ");
  const [countRows] = await executor.execute<Array<RowDataPacket & { total: number }>>(
    `SELECT COUNT(*) AS total
       FROM shipments s
       LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
       LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
      WHERE ${where}`,
    params,
  );
  const sortColumn = {
    shipmentDate: "s.shipment_date",
    status: "s.delivery_status",
    expectedDeliveryDate: "s.estimated_delivery_date",
    consignmentNo: "s.consignment_no",
  }[filters.sortBy];
  const direction = filters.direction === "asc" ? "ASC" : "DESC";
  const offset = (filters.page - 1) * filters.pageSize;
  const [rows] = await executor.execute<Array<RowDataPacket & {
    consignmentNo: string;
    customerName: string | null;
    origin: string | null;
    destination: string | null;
    originHubId: string;
    destinationHubId: string;
    mode: string;
    chargeableWeight: number | null;
    shipmentDate: string;
    expectedDeliveryDate: string | null;
    status: string;
    slaDueDate: string | null;
    lastEventAt: string | null;
    lastEvent: string | null;
    lastLocation: string | null;
  }>>(
    `SELECT s.consignment_no AS consignmentNo, c.customer_name AS customerName,
            oh.city AS origin, dh.city AS destination,
            s.origin_hub_id AS originHubId, s.destination_hub_id AS destinationHubId,
            s.mode, s.chargeable_weight AS chargeableWeight,
            s.shipment_date AS shipmentDate, s.estimated_delivery_date AS expectedDeliveryDate,
            s.delivery_status AS status, s.sla_due_date AS slaDueDate,
            latest.event_time AS lastEventAt, latest.event_label AS lastEvent,
            latest.city AS lastLocation
       FROM shipments s
       LEFT JOIN customers c ON c.customer_id = s.customer_id AND c.company_id = s.company_id
       LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
       LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
       LEFT JOIN LATERAL (
         SELECT se.event_time,
                COALESCE(NULLIF(se.event_status, ''), NULLIF(se.event_type, ''), 'Recorded event') AS event_label,
                h.city
           FROM shipment_events se
           LEFT JOIN hubs h ON h.hub_id = se.hub_id AND h.company_id = s.company_id
          WHERE se.consignment_no = s.consignment_no
            AND EXISTS (SELECT 1 FROM shipments es WHERE es.consignment_no = se.consignment_no AND es.company_id = s.company_id)
          ORDER BY se.event_time DESC, se.event_id DESC LIMIT 1
       ) latest ON TRUE
      WHERE ${where}
      ORDER BY ${sortColumn} ${direction}, s.consignment_no
      LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );
  return {
    shipments: rows.map((row) => ({
      ...row,
      shipmentDate: String(row.shipmentDate).slice(0, 10),
      chargeableWeight: row.chargeableWeight === null ? null : Number(row.chargeableWeight),
    })),
    total: Number(countRows[0]?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function getOperationsShipmentEvents(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
  consignmentNo: string,
) {
  const hubs = await getAssignedHubs(executor, companyId, employeeId);
  if (!hubs.length) return null;
  const scope = shipmentScope(companyId, hubs.map((hub) => hub.hubId));
  const [rows] = await executor.execute<Array<RowDataPacket & {
    consignmentNo: string;
    customerName: string | null;
    origin: string | null;
    destination: string | null;
    shipmentDate: string;
    expectedDeliveryDate: string | null;
    status: string;
    mode: string;
    chargeableWeight: number | null;
  }>>(
    `SELECT s.consignment_no AS consignmentNo, c.customer_name AS customerName,
            oh.city AS origin, dh.city AS destination,
            s.shipment_date AS shipmentDate, s.estimated_delivery_date AS expectedDeliveryDate,
            s.delivery_status AS status, s.mode, s.chargeable_weight AS chargeableWeight
       FROM shipments s
       LEFT JOIN customers c ON c.customer_id = s.customer_id AND c.company_id = s.company_id
       LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
       LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
      WHERE s.company_id = ? AND s.consignment_no = ? AND ${scope.sql}
      LIMIT 1`,
    [companyId, consignmentNo, ...scope.params],
  );
  if (!rows[0]) return null;
  const [events] = await executor.execute<Array<RowDataPacket & {
    eventTime: string;
    eventType: string | null;
    eventStatus: string | null;
    hubId: string | null;
    city: string | null;
  }>>(
    `SELECT se.event_time AS eventTime, se.event_type AS eventType,
            se.event_status AS eventStatus, se.hub_id AS hubId, h.city
       FROM shipment_events se
       JOIN shipments s ON s.consignment_no = se.consignment_no AND s.company_id = ?
       LEFT JOIN hubs h ON h.hub_id = se.hub_id AND h.company_id = s.company_id
      WHERE s.consignment_no = ? AND ${scope.sql}
      ORDER BY se.event_time DESC, se.event_id DESC
      LIMIT 100`,
    [companyId, consignmentNo, ...scope.params],
  );
  return { ...rows[0], events };
}
