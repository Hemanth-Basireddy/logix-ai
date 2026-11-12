import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { z } from "zod";

const optionalDateFilter = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
);

export const hubManagerShipmentFiltersSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(64).default(""),
  status: z.string().trim().max(60).default(""),
  hubId: z.string().trim().max(20).default(""),
  assignment: z.enum(["", "ASSIGNED", "UNASSIGNED"]).default(""),
  from: optionalDateFilter,
  to: optionalDateFilter,
  view: z.enum(["all", "inbound", "outbound", "inventory", "exceptions"]).default("all"),
});

type QueryExecutor = Pick<PoolConnection, "execute">;

type HubRow = RowDataPacket & {
  hubId: string;
  city: string;
};

type ScopedValues = {
  sql: string;
  params: string[];
};

type ShipmentListFilters = {
  page: number;
  pageSize: number;
  search: string;
  status: string;
  hubId: string;
  assignment?: "" | "ASSIGNED" | "UNASSIGNED";
  from?: string;
  to?: string;
  view: "all" | "inbound" | "outbound" | "inventory" | "exceptions";
};

export class HubManagerDataError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "HubManagerDataError";
  }
}

export async function getHubManagerAssignedHubs(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
): Promise<HubRow[]> {
  const [rows] = await executor.execute<HubRow[]>(
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
  return rows;
}

async function requireAssignedHub(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
  hubId: string,
): Promise<void> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT 1
       FROM employee_hubs eh
       JOIN employees e ON e.employee_id = eh.employee_id
        AND e.company_id = ? AND UPPER(e.status) = 'ACTIVE'
       JOIN hubs h ON h.hub_id = eh.hub_id
        AND h.company_id = e.company_id AND UPPER(h.status) = 'ACTIVE'
      WHERE eh.employee_id = ? AND eh.hub_id = ? AND UPPER(eh.status) = 'ACTIVE'
      LIMIT 1`,
    [companyId, employeeId, hubId],
  );
  if (!rows.length) {
    throw new HubManagerDataError("You are not authorized to access this hub.", 403);
  }
}

function shipmentScope(hubIds: string[], alias = "s"): ScopedValues {
  const placeholders = hubIds.map(() => "?").join(", ");
  return {
    sql: `(${alias}.origin_hub_id IN (${placeholders})
      OR ${alias}.destination_hub_id IN (${placeholders})
      OR EXISTS (SELECT 1 FROM shipment_events hub_event
                  WHERE hub_event.consignment_no = ${alias}.consignment_no
                    AND hub_event.hub_id IN (${placeholders})
                    AND EXISTS (SELECT 1 FROM shipments event_shipment
                                 WHERE event_shipment.consignment_no = hub_event.consignment_no
                                   AND event_shipment.company_id = ${alias}.company_id)
                    AND (SELECT COUNT(*) FROM shipments unique_event_shipment
                          WHERE unique_event_shipment.consignment_no = hub_event.consignment_no) = 1))`,
    params: [...hubIds, ...hubIds, ...hubIds],
  };
}

function latestEventJoin(companyPredicate = "s.company_id"): string {
  return `LEFT JOIN LATERAL (
      SELECT se.event_id, se.event_time, se.event_type, se.event_status, se.hub_id, se.employee_id
        FROM shipment_events se
       WHERE se.consignment_no = s.consignment_no
       AND (SELECT COUNT(*) FROM shipments unique_event_shipment
             WHERE unique_event_shipment.consignment_no = se.consignment_no) = 1
         AND EXISTS (SELECT 1 FROM shipments event_shipment
                      WHERE event_shipment.consignment_no = se.consignment_no
                        AND event_shipment.company_id = ${companyPredicate})
       ORDER BY se.event_time DESC, se.event_id DESC
       LIMIT 1
    ) latest ON TRUE`;
}

function mapRows<T extends Record<string, unknown>>(rows: T[]) {
  return rows;
}

export async function getHubManagerWorkspace(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
) {
  const hubs = await getHubManagerAssignedHubs(executor, companyId, employeeId);
  if (!hubs.length) {
    return {
      scope: { assignedHubCount: 0 },
      hubs: [],
      hubWorkload: [],
      kpis: { shipments: 0, inboundPending: 0, outboundReady: 0, inventory: 0, exceptions: 0, staleTracking: 0, tasks: 0 },
      statusCounts: [],
      volumeTrend: [],
      inbound: [],
      outbound: [],
      inventory: [],
      exceptions: [],
      staleTracking: [],
      staff: [],
      routes: [],
      recentEvents: [],
      capabilities: { taskAssignments: false, qrScanning: true, trackingIdVerification: true, receipt: true, dispatch: true, persistentNotifications: false },
    };
  }

  const hubIds = hubs.map((hub) => hub.hubId);
  const scope = shipmentScope(hubIds);
  const [summaryRows] = await executor.execute<Array<RowDataPacket & {
    shipments: number;
    inboundPending: number;
    outboundReady: number;
    inventory: number;
    exceptions: number;
  }>>(
    `SELECT COUNT(DISTINCT s.consignment_no) AS shipments,
            COUNT(DISTINCT CASE WHEN latest.event_type = 'DISPATCHED' AND latest.hub_id <> s.destination_hub_id
              AND s.destination_hub_id IN (${hubIds.map(() => "?").join(", ")})
              THEN s.consignment_no END) AS inboundPending,
            COUNT(DISTINCT CASE WHEN latest.event_type = 'RECEIVED_AT_ORIGIN_HUB'
              AND latest.hub_id = s.origin_hub_id
              AND s.origin_hub_id IN (${hubIds.map(() => "?").join(", ")})
              THEN s.consignment_no END) AS outboundReady,
            COUNT(DISTINCT CASE WHEN latest.event_type IN
              ('RECEIVED_AT_ORIGIN_HUB','RECEIVED_AT_DESTINATION_HUB')
              AND latest.hub_id IN (${hubIds.map(() => "?").join(", ")})
              THEN s.consignment_no END) AS inventory,
            COUNT(DISTINCT CASE WHEN latest.event_type LIKE '%EXCEPTION%'
                OR latest.event_type LIKE '%DAMAG%'
                OR latest.event_type LIKE '%MISSING%'
                OR latest.event_type LIKE '%MISMATCH%'
              THEN s.consignment_no END) AS exceptions
       FROM shipments s
       ${latestEventJoin()}
      WHERE s.company_id = ? AND ${scope.sql}`,
    [...hubIds, ...hubIds, ...hubIds, companyId, ...scope.params],
  );
  const summary = summaryRows[0] ?? {
    shipments: 0,
    inboundPending: 0,
    outboundReady: 0,
    inventory: 0,
    exceptions: 0,
  };

  const hubWorkload = await Promise.all(hubs.map(async (hub) => {
    const scopeForHub = shipmentScope([hub.hubId]);
    const [rows] = await executor.execute<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT s.consignment_no) AS shipments,
              COUNT(DISTINCT CASE WHEN latest.event_type = 'DISPATCHED'
                AND latest.hub_id <> s.destination_hub_id
                AND s.destination_hub_id = h.hub_id THEN s.consignment_no END) AS inboundPending,
              COUNT(DISTINCT CASE WHEN latest.event_type = 'HANDED_OVER_AT_ORIGIN_HUB'
                AND latest.hub_id = h.hub_id THEN s.consignment_no END) AS arrivalPending,
              COUNT(DISTINCT CASE WHEN latest.event_type IN ('RECEIVED_AT_ORIGIN_HUB','RECEIVED_AT_DESTINATION_HUB')
                AND latest.hub_id = h.hub_id THEN s.consignment_no END) AS receiptPending,
              COUNT(DISTINCT CASE WHEN latest.event_type = 'BOOKED' AND s.origin_hub_id = h.hub_id
                AND s.origin_logistics_executive_1_id IS NULL AND s.origin_logistics_executive_2_id IS NULL
                THEN s.consignment_no END) AS assignmentPending,
              COUNT(DISTINCT CASE WHEN latest.event_type = 'DISPATCHED' AND latest.hub_id = h.hub_id
                THEN s.consignment_no END) AS dispatched,
              COUNT(DISTINCT CASE WHEN latest.event_type = 'RECEIVED_AT_ORIGIN_HUB'
                AND latest.hub_id = s.origin_hub_id
                AND s.origin_hub_id = h.hub_id THEN s.consignment_no END) AS outboundReady,
              COUNT(DISTINCT CASE WHEN latest.event_type IN
                ('RECEIVED_AT_ORIGIN_HUB','RECEIVED_AT_DESTINATION_HUB')
                AND latest.hub_id = h.hub_id THEN s.consignment_no END) AS inventory
         FROM hubs h
         LEFT JOIN shipments s ON s.company_id = h.company_id AND ${scopeForHub.sql}
         ${latestEventJoin()}
        WHERE h.company_id = ? AND h.hub_id = ?
        GROUP BY h.hub_id`,
      [...scopeForHub.params, companyId, hub.hubId],
    );
    return {
      hubId: hub.hubId,
      city: hub.city,
      shipments: Number(rows[0]?.shipments ?? 0),
      inboundPending: Number(rows[0]?.inboundPending ?? 0),
      arrivalPending: Number(rows[0]?.arrivalPending ?? 0),
      receiptPending: Number(rows[0]?.receiptPending ?? 0),
      assignmentPending: Number(rows[0]?.assignmentPending ?? 0),
      outboundReady: Number(rows[0]?.outboundReady ?? 0),
      dispatched: Number(rows[0]?.dispatched ?? 0),
      inventory: Number(rows[0]?.inventory ?? 0),
    };
  }));

  const [statusCounts] = await executor.execute<RowDataPacket[]>(
    `SELECT COALESCE(NULLIF(s.delivery_status, ''), 'Unspecified') AS status,
            COUNT(DISTINCT s.consignment_no) AS total
       FROM shipments s
      WHERE s.company_id = ? AND ${scope.sql}
      GROUP BY COALESCE(NULLIF(s.delivery_status, ''), 'Unspecified')
      ORDER BY total DESC, status`,
    [companyId, ...scope.params],
  );

  const [volumeTrend] = await executor.execute<RowDataPacket[]>(
    `SELECT DATE(s.shipment_date) AS day, COUNT(DISTINCT s.consignment_no) AS total
       FROM shipments s
      WHERE s.company_id = ?
        AND s.shipment_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 29 DAY)
        AND ${scope.sql}
      GROUP BY DATE(s.shipment_date) ORDER BY day`,
    [companyId, ...scope.params],
  );

  const [inbound] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.shipment_date AS shipmentDate,
            s.delivery_status AS status, s.mode, s.route_id AS routeId,
            COALESCE(oh.city, 'Unavailable') AS origin, dh.city AS destination,
            CASE WHEN latest.event_type='HANDED_OVER_AT_ORIGIN_HUB' THEN s.origin_hub_id ELSE s.destination_hub_id END AS hubId, latest.event_time AS lastEventAt,
            latest.event_type AS lastEvent
       FROM shipments s
       JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
       LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
       ${latestEventJoin()}
      WHERE s.company_id = ? AND ((s.destination_hub_id IN (${hubIds.map(() => "?").join(", ")})
        AND latest.event_type = 'DISPATCHED') OR (s.origin_hub_id IN (${hubIds.map(() => "?").join(", ")})
        AND latest.event_type = 'HANDED_OVER_AT_ORIGIN_HUB' AND latest.hub_id=s.origin_hub_id))
      ORDER BY latest.event_time ASC, s.consignment_no
      LIMIT 100`,
    [companyId, ...hubIds, ...hubIds],
  );

  const [outbound] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.shipment_date AS shipmentDate,
            s.delivery_status AS status, s.mode, s.route_id AS routeId,
            COALESCE(dh.city, 'Unavailable') AS destination, oh.city AS origin,
            s.origin_hub_id AS hubId, latest.event_time AS lastEventAt,
            latest.event_type AS lastEvent
       FROM shipments s
       JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
       LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
       ${latestEventJoin()}
      WHERE s.company_id = ? AND s.origin_hub_id IN (${hubIds.map(() => "?").join(", ")})
        AND latest.event_type = 'RECEIVED_AT_ORIGIN_HUB'
        AND latest.hub_id = s.origin_hub_id
      ORDER BY latest.event_time ASC, s.consignment_no
      LIMIT 100`,
    [companyId, ...hubIds],
  );

  const [pickupQueue] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo,s.shipment_date AS shipmentDate,
            s.origin_hub_id AS hubId,oh.city AS origin,s.destination_hub_id AS destinationHubId,dh.city AS destination,
            s.mode,latest.event_time AS lastEventAt
       FROM shipments s ${latestEventJoin()}
       JOIN hubs oh ON oh.hub_id=s.origin_hub_id AND oh.company_id=s.company_id
       JOIN hubs dh ON dh.hub_id=s.destination_hub_id AND dh.company_id=s.company_id
      WHERE s.company_id=? AND s.origin_hub_id IN (${hubIds.map(() => "?").join(",")})
        AND latest.event_type='BOOKED'
        AND s.origin_logistics_executive_1_id IS NULL AND s.origin_logistics_executive_2_id IS NULL
      ORDER BY s.shipment_date,s.consignment_no LIMIT 100`,
    [companyId,...hubIds],
  );

  const [inventory] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.shipment_date AS shipmentDate,
            s.delivery_status AS status, s.mode, s.route_id AS routeId,
            COALESCE(oh.city, 'Unavailable') AS origin,
            COALESCE(dh.city, 'Unavailable') AS destination,
            latest.hub_id AS hubId, h.city AS hubCity,
            latest.event_time AS lastEventAt, latest.event_type AS lastEvent
       FROM shipments s
       ${latestEventJoin()}
       LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
       LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
       JOIN hubs h ON h.hub_id = latest.hub_id AND h.company_id = s.company_id
      WHERE s.company_id = ? AND latest.hub_id IN (${hubIds.map(() => "?").join(", ")})
        AND latest.event_type IN ('RECEIVED_AT_ORIGIN_HUB','RECEIVED_AT_DESTINATION_HUB')
      ORDER BY latest.event_time DESC, s.consignment_no
      LIMIT 100`,
    [companyId, ...hubIds],
  );

  const [exceptions] = await executor.execute<RowDataPacket[]>(
    `SELECT se.consignment_no AS consignmentNo, se.event_type AS reason,
            se.event_status AS status, se.event_time AS eventTime,
            se.hub_id AS hubId, h.city AS hubCity
       FROM shipment_events se
       JOIN shipments s ON s.consignment_no = se.consignment_no AND s.company_id = ?
       JOIN hubs h ON h.hub_id = se.hub_id AND h.company_id = s.company_id
      WHERE se.hub_id IN (${hubIds.map(() => "?").join(", ")})
       AND (SELECT COUNT(*) FROM shipments unique_event_shipment
             WHERE unique_event_shipment.consignment_no = se.consignment_no) = 1
        AND (se.event_type LIKE '%EXCEPTION%' OR se.event_type LIKE '%DAMAG%'
          OR se.event_type LIKE '%MISSING%' OR se.event_type LIKE '%MISMATCH%')
      ORDER BY se.event_time DESC, se.event_id DESC
      LIMIT 100`,
    [companyId, ...hubIds],
  );

  const [staleTracking] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.destination_hub_id AS hubId,
            h.city AS hubCity, latest.event_time AS lastEventAt,
            latest.event_type AS lastEvent
       FROM shipments s
       ${latestEventJoin()}
       JOIN hubs h ON h.hub_id = s.destination_hub_id AND h.company_id = s.company_id
      WHERE s.company_id = ? AND s.destination_hub_id IN (${hubIds.map(() => "?").join(", ")})
        AND latest.event_type = 'DISPATCHED'
        AND latest.event_time < DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 48 HOUR)
      ORDER BY latest.event_time ASC LIMIT 100`,
    [companyId, ...hubIds],
  );

  const [staff] = await executor.execute<RowDataPacket[]>(
    `SELECT DISTINCT e.employee_id AS employeeId, e.name, UPPER(e.role) AS role,
            eh.hub_id AS hubId, h.city
       FROM employee_hubs eh
       JOIN employees e ON e.employee_id = eh.employee_id
        AND e.company_id = ? AND UPPER(e.status) = 'ACTIVE'
       JOIN hubs h ON h.hub_id = eh.hub_id AND h.company_id = e.company_id
      WHERE eh.hub_id IN (${hubIds.map(() => "?").join(", ")})
        AND UPPER(eh.status) = 'ACTIVE' AND UPPER(h.status) = 'ACTIVE'
      ORDER BY h.city, e.name`,
    [companyId, ...hubIds],
  );

  const [routes] = await executor.execute<RowDataPacket[]>(
    `SELECT r.route_id AS routeId, r.mode, r.estimated_transit_days AS estimatedTransitDays,
            oh.hub_id AS originHubId, oh.city AS origin,
            dh.hub_id AS destinationHubId, dh.city AS destination,
            COUNT(DISTINCT s.consignment_no) AS shipments,
            COUNT(DISTINCT CASE WHEN UPPER(s.delivery_status) = 'DELAYED'
              THEN s.consignment_no END) AS recordedDelayed
       FROM routes r
       JOIN hubs oh ON oh.hub_id = r.origin_hub_id AND oh.company_id = r.company_id
       JOIN hubs dh ON dh.hub_id = r.destination_hub_id AND dh.company_id = r.company_id
       LEFT JOIN shipments s ON s.route_id = r.route_id AND s.company_id = r.company_id
      WHERE r.company_id = ? AND (r.origin_hub_id IN (${hubIds.map(() => "?").join(", ")})
        OR r.destination_hub_id IN (${hubIds.map(() => "?").join(", ")}))
      GROUP BY r.route_id, r.mode, r.estimated_transit_days,
               oh.hub_id, oh.city, dh.hub_id, dh.city
      ORDER BY shipments DESC, r.route_id`,
    [companyId, ...hubIds, ...hubIds],
  );

  const [recentEvents] = await executor.execute<RowDataPacket[]>(
    `SELECT se.consignment_no AS consignmentNo, se.event_time AS eventTime,
            se.event_type AS eventType, se.event_status AS eventStatus,
            se.hub_id AS hubId, h.city AS hubCity
       FROM shipment_events se
       JOIN shipments s ON s.consignment_no = se.consignment_no AND s.company_id = ?
       JOIN hubs h ON h.hub_id = se.hub_id AND h.company_id = s.company_id
      WHERE se.hub_id IN (${hubIds.map(() => "?").join(", ")})
       AND (SELECT COUNT(*) FROM shipments unique_event_shipment
             WHERE unique_event_shipment.consignment_no = se.consignment_no) = 1
      ORDER BY se.event_time DESC, se.event_id DESC
      LIMIT 50`,
    [companyId, ...hubIds],
  );

  return {
    scope: { assignedHubCount: hubs.length },
    hubs,
    hubWorkload,
    kpis: {
      shipments: Number(summary.shipments ?? 0),
      inboundPending: Number(summary.inboundPending ?? 0),
      outboundReady: Number(summary.outboundReady ?? 0),
      inventory: Number(summary.inventory ?? 0),
      exceptions: Number(summary.exceptions ?? 0),
      staleTracking: staleTracking.length,
      tasks: 0,
    },
    statusCounts: mapRows(statusCounts),
    volumeTrend: mapRows(volumeTrend),
    inbound: mapRows(inbound),
    outbound: mapRows(outbound),
    pickupQueue: mapRows(pickupQueue),
    inventory: mapRows(inventory),
    exceptions: mapRows(exceptions),
    staleTracking: mapRows(staleTracking),
    staff: mapRows(staff),
    routes: mapRows(routes),
    recentEvents: mapRows(recentEvents),
    capabilities: { taskAssignments: true, qrScanning: true, trackingIdVerification: true, receipt: true, dispatch: true, persistentNotifications: false },
  };
}

export async function listHubManagerShipments(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
  filters: ShipmentListFilters,
) {
  const hubs = await getHubManagerAssignedHubs(executor, companyId, employeeId);
  if (!hubs.length) return { shipments: [], total: 0, page: filters.page, pageSize: filters.pageSize };
  const hubIds = hubs.map((hub) => hub.hubId);
  if (filters.hubId && !hubIds.includes(filters.hubId)) {
    throw new HubManagerDataError("You are not authorized to access this hub.", 403);
  }
  const scope = shipmentScope(hubIds);
  const clauses = ["s.company_id = ?", scope.sql];
  const params: Array<string | number> = [companyId, ...scope.params];
  if (filters.search) {
    clauses.push("s.consignment_no LIKE ?");
    params.push(`%${filters.search.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (filters.status) {
    clauses.push("s.delivery_status = ?");
    params.push(filters.status);
  }
  if (filters.from) { clauses.push("DATE(s.shipment_date) >= ?"); params.push(filters.from); }
  if (filters.to) { clauses.push("DATE(s.shipment_date) <= ?"); params.push(filters.to); }
  if (filters.hubId) {
    clauses.push("(s.origin_hub_id = ? OR s.destination_hub_id = ? OR EXISTS (SELECT 1 FROM shipment_events assigned_hub_event WHERE assigned_hub_event.consignment_no = s.consignment_no AND assigned_hub_event.hub_id = ? AND (SELECT COUNT(*) FROM shipments unique_event_shipment WHERE unique_event_shipment.consignment_no = assigned_hub_event.consignment_no) = 1))");
    params.push(filters.hubId, filters.hubId, filters.hubId);
  }
  if (filters.view === "inbound") {
    const queueHubs = filters.hubId ? [filters.hubId] : hubIds;
    clauses.push("((s.destination_hub_id IN (" + queueHubs.map(() => "?").join(", ") + ") AND ((latest.event_type = 'DISPATCHED' AND latest.hub_id <> s.destination_hub_id) OR (latest.event_type IN ('ARRIVED_AT_DESTINATION_HUB','RECEIVED_AT_DESTINATION_HUB') AND latest.hub_id=s.destination_hub_id))) OR (s.origin_hub_id IN (" + queueHubs.map(() => "?").join(", ") + ") AND latest.event_type IN ('HANDED_OVER_AT_ORIGIN_HUB','ARRIVED_AT_ORIGIN_HUB') AND latest.hub_id=s.origin_hub_id))");
    params.push(...queueHubs, ...queueHubs);
  } else if (filters.view === "outbound") {
    const queueHubs = filters.hubId ? [filters.hubId] : hubIds;
    clauses.push("s.origin_hub_id IN (" + queueHubs.map(() => "?").join(", ") + ") AND latest.hub_id = s.origin_hub_id AND latest.event_type IN ('BOOKED','PICKED_UP','HANDED_OVER_AT_ORIGIN_HUB','RECEIVED_AT_ORIGIN_HUB','DISPATCHED')");
    params.push(...queueHubs);
  } else if (filters.view === "inventory") {
    clauses.push("latest.hub_id IN (" + hubIds.map(() => "?").join(", ") + ") AND latest.event_type IN ('RECEIVED_AT_ORIGIN_HUB','RECEIVED_AT_DESTINATION_HUB')");
    params.push(...hubIds);
  } else if (filters.view === "exceptions") {
    clauses.push("(EXISTS (SELECT 1 FROM shipment_events exception_event WHERE exception_event.consignment_no = s.consignment_no AND exception_event.hub_id IN (" + hubIds.map(() => "?").join(", ") + ") AND (exception_event.event_type LIKE '%EXCEPTION%' OR exception_event.event_type LIKE '%DAMAG%' OR exception_event.event_type LIKE '%MISSING%' OR exception_event.event_type LIKE '%MISMATCH%') AND EXISTS (SELECT 1 FROM shipments exception_shipment WHERE exception_shipment.consignment_no = exception_event.consignment_no AND exception_shipment.company_id = s.company_id) AND (SELECT COUNT(*) FROM shipments unique_exception_shipment WHERE unique_exception_shipment.consignment_no = exception_event.consignment_no) = 1) OR (s.destination_hub_id IN (" + hubIds.map(() => "?").join(", ") + ") AND latest.event_type = 'DISPATCHED' AND latest.event_time < DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 48 HOUR)))");
    params.push(...hubIds, ...hubIds);
  }
  if (filters.assignment && (filters.view === "inbound" || filters.view === "outbound")) {
    const prefix = filters.view === "outbound" ? "origin" : "destination";
    const assigned = `(s.${prefix}_logistics_executive_1_id IS NOT NULL OR s.${prefix}_logistics_executive_2_id IS NOT NULL)`;
    clauses.push(filters.assignment === "ASSIGNED" ? assigned : `NOT ${assigned}`);
  }

  const where = clauses.join(" AND ");
  const [countRows] = await executor.execute<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT s.consignment_no) AS total
       FROM shipments s ${latestEventJoin()}
      WHERE ${where}`,
    params,
  );
  const offset = (filters.page - 1) * filters.pageSize;
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.shipment_date AS shipmentDate,
            s.delivery_status AS status, s.mode, s.route_id AS routeId,
            s.origin_hub_id AS originHubId, s.destination_hub_id AS destinationHubId,
            s.recipient_name AS recipientName,
            s.origin_logistics_executive_1_id AS originExecutive1Id,
            s.origin_logistics_executive_2_id AS originExecutive2Id,
            s.destination_logistics_executive_1_id AS destinationExecutive1Id,
            s.destination_logistics_executive_2_id AS destinationExecutive2Id,
            (SELECT GROUP_CONCAT(DISTINCT e.name ORDER BY e.name SEPARATOR ', ') FROM employees e
              WHERE e.company_id = s.company_id AND e.employee_id IN (s.origin_logistics_executive_1_id, s.origin_logistics_executive_2_id)) AS originExecutiveNames,
            (SELECT GROUP_CONCAT(DISTINCT e.name ORDER BY e.name SEPARATOR ', ') FROM employees e
              WHERE e.company_id = s.company_id AND e.employee_id IN (s.destination_logistics_executive_1_id, s.destination_logistics_executive_2_id)) AS destinationExecutiveNames,
            COALESCE(oh.city, 'Unavailable') AS origin, COALESCE(dh.city, 'Unavailable') AS destination,
            latest.event_time AS lastEventAt, latest.event_type AS lastEvent,
            latest.event_status AS lastEventStatus, latest.hub_id AS currentHubId,
            ch.city AS currentHubCity,
            CASE
              WHEN latest.event_type = 'DISPATCHED' AND latest.hub_id <> s.destination_hub_id THEN 'IN_TRANSIT'
              WHEN latest.event_type = 'ARRIVED_AT_DESTINATION_HUB' THEN 'RECEIPT_PENDING'
              WHEN latest.event_type = 'RECEIVED_AT_DESTINATION_HUB' THEN 'RECEIVED'
              WHEN latest.event_type = 'DISPATCHED' THEN 'DISPATCHED'
              WHEN latest.event_type = 'RECEIVED_AT_ORIGIN_HUB' THEN 'READY_FOR_DISPATCH'
              WHEN latest.event_type = 'ARRIVED_AT_ORIGIN_HUB' THEN 'ARRIVAL_PENDING'
              WHEN latest.event_type = 'HANDED_OVER_AT_ORIGIN_HUB' THEN 'ORIGIN_INBOUND'
              WHEN latest.event_type = 'PICKED_UP' THEN 'HANDOVER_PENDING'
              WHEN latest.event_type = 'BOOKED' THEN 'PICKUP_ASSIGNMENT_PENDING'
              ELSE 'RECORDED_STATE'
            END AS operationalState,
            CASE
              WHEN latest.event_type = 'DISPATCHED' AND latest.hub_id <> s.destination_hub_id THEN 'Confirm arrival at destination hub'
              WHEN latest.event_type = 'ARRIVED_AT_DESTINATION_HUB' THEN 'Confirm physical receipt'
              WHEN latest.event_type = 'RECEIVED_AT_DESTINATION_HUB' AND s.destination_logistics_executive_1_id IS NULL AND s.destination_logistics_executive_2_id IS NULL THEN 'Assign delivery executive'
              WHEN latest.event_type = 'RECEIVED_AT_DESTINATION_HUB' THEN 'Delivery task assigned'
              WHEN latest.event_type = 'RECEIVED_AT_ORIGIN_HUB' THEN 'Ready for dispatch'
              WHEN latest.event_type = 'ARRIVED_AT_ORIGIN_HUB' THEN 'Confirm physical receipt'
              WHEN latest.event_type = 'HANDED_OVER_AT_ORIGIN_HUB' THEN 'Confirm arrival at origin hub'
              WHEN latest.event_type = 'PICKED_UP' THEN 'Awaiting executive handover'
              WHEN latest.event_type = 'BOOKED' AND s.origin_logistics_executive_1_id IS NULL AND s.origin_logistics_executive_2_id IS NULL THEN 'Assign pickup executive'
              WHEN latest.event_type = 'BOOKED' THEN 'Pickup task assigned'
              WHEN latest.event_type = 'DISPATCHED' THEN 'In transit'
              ELSE 'Review shipment'
            END AS nextAction,
            CASE WHEN latest.event_type = 'BOOKED' THEN 'PICKUP'
                 WHEN latest.event_type = 'RECEIVED_AT_DESTINATION_HUB' THEN 'DELIVERY'
                 ELSE NULL END AS requiredTaskType
       FROM shipments s
       LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
       LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
       ${latestEventJoin()}
       LEFT JOIN hubs ch ON ch.hub_id = latest.hub_id AND ch.company_id = s.company_id
      WHERE ${where}
      ORDER BY s.shipment_date DESC, s.consignment_no
      LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset],
  );
  return { shipments: rows, total: Number(countRows[0]?.total ?? 0), page: filters.page, pageSize: filters.pageSize };
}

export async function getHubManagerShipmentEvents(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
  consignmentNo: string,
) {
  const hubs = await getHubManagerAssignedHubs(executor, companyId, employeeId);
  if (!hubs.length) return null;
  const scope = shipmentScope(hubs.map((hub) => hub.hubId));
  const [shipments] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.shipment_date AS shipmentDate,
            s.delivery_status AS status, s.mode, s.route_id AS routeId,
            s.origin_hub_id AS originHubId, s.destination_hub_id AS destinationHubId,
            s.recipient_name AS recipientName,
            s.origin_logistics_executive_1_id AS originExecutive1Id,
            s.origin_logistics_executive_2_id AS originExecutive2Id,
            s.destination_logistics_executive_1_id AS destinationExecutive1Id,
            s.destination_logistics_executive_2_id AS destinationExecutive2Id,
            (SELECT GROUP_CONCAT(DISTINCT e.name ORDER BY e.name SEPARATOR ', ') FROM employees e
              WHERE e.company_id = s.company_id AND e.employee_id IN (s.origin_logistics_executive_1_id, s.origin_logistics_executive_2_id)) AS originExecutiveNames,
            (SELECT GROUP_CONCAT(DISTINCT e.name ORDER BY e.name SEPARATOR ', ') FROM employees e
              WHERE e.company_id = s.company_id AND e.employee_id IN (s.destination_logistics_executive_1_id, s.destination_logistics_executive_2_id)) AS destinationExecutiveNames,
            COALESCE(oh.city, 'Unavailable') AS origin, COALESCE(dh.city, 'Unavailable') AS destination
       FROM shipments s
       LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
       LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
      WHERE s.company_id = ? AND s.consignment_no = ? AND ${scope.sql}
        AND (SELECT COUNT(*) FROM shipments unique_event_shipment
              WHERE unique_event_shipment.consignment_no = s.consignment_no) = 1
      LIMIT 1`,
    [companyId, consignmentNo, ...scope.params],
  );
  if (!shipments[0]) return null;
  const [events] = await executor.execute<RowDataPacket[]>(
    `SELECT se.event_time AS eventTime, se.event_type AS eventType,
            se.event_status AS eventStatus, se.hub_id AS hubId, h.city,
            CASE WHEN se.employee_id IS NULL THEN NULL ELSE e.name END AS employeeName
       FROM shipment_events se
       JOIN shipments s ON s.consignment_no = se.consignment_no AND s.company_id = ?
       LEFT JOIN hubs h ON h.hub_id = se.hub_id AND h.company_id = s.company_id
       LEFT JOIN employees e ON e.employee_id = se.employee_id AND e.company_id = s.company_id
      WHERE s.consignment_no = ? AND ${scope.sql}
        AND (SELECT COUNT(*) FROM shipments unique_event_shipment
              WHERE unique_event_shipment.consignment_no = s.consignment_no) = 1
      ORDER BY se.event_time DESC, se.event_id DESC LIMIT 100`,
    [companyId, consignmentNo, ...scope.params],
  );
  return { ...shipments[0], lastEvent: events[0]?.eventType ?? null, lastEventAt: events[0]?.eventTime ?? null, events };
}

export async function recordHubShipmentAction(
  connection: PoolConnection,
  companyId: number,
  employeeId: string,
  hubId: string,
  consignmentNo: string,
  action: "arrive" | "receive" | "dispatch",
): Promise<{ consignmentNo: string; eventType: string; hubId: string }> {
  await requireAssignedHub(connection, companyId, employeeId, hubId);
  const [shipments] = await connection.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.origin_hub_id AS originHubId,
            s.destination_hub_id AS destinationHubId, s.route_id AS routeId
       FROM shipments s
      WHERE s.company_id = ? AND s.consignment_no = ?
      LIMIT 2 FOR UPDATE`,
    [companyId, consignmentNo],
  );
  if (!shipments.length) {
    throw new HubManagerDataError("Shipment was not found in your company.", 404);
  }
  if (shipments.length !== 1) {
    throw new HubManagerDataError("Shipment identifier is ambiguous and cannot be processed.", 409);
  }
  const shipment = shipments[0]!;
  const [latestRows] = await connection.execute<RowDataPacket[]>(
    `SELECT event_type AS eventType, hub_id AS hubId
       FROM shipment_events
      WHERE consignment_no = ?
        AND EXISTS (SELECT 1 FROM shipments s WHERE s.consignment_no = shipment_events.consignment_no AND s.company_id = ?)
        AND (SELECT COUNT(*) FROM shipments unique_event_shipment
              WHERE unique_event_shipment.consignment_no = shipment_events.consignment_no) = 1
      ORDER BY event_time DESC, event_id DESC
      LIMIT 1 FOR UPDATE`,
    [consignmentNo, companyId],
  );
  const latest = latestRows[0];
  if (!shipment.routeId) {
    throw new HubManagerDataError("Shipment has no configured route for hub verification.", 409);
  }
  const [routeRows] = await connection.execute<RowDataPacket[]>(
    `SELECT route_id FROM routes
      WHERE route_id = ? AND company_id = ?
        AND origin_hub_id = ? AND destination_hub_id = ?
      LIMIT 1`,
    [shipment.routeId, companyId, shipment.originHubId, shipment.destinationHubId],
  );
  if (!routeRows.length) {
    throw new HubManagerDataError("Shipment route does not match its recorded hub assignment.", 409);
  }
  let eventType: string;
  if (action === "arrive") {
    if (shipment.originHubId === hubId && latest?.eventType === "HANDED_OVER_AT_ORIGIN_HUB" && latest.hubId === hubId) {
      eventType = "ARRIVED_AT_ORIGIN_HUB";
    } else if (shipment.destinationHubId === hubId && latest?.eventType === "DISPATCHED" && latest.hubId !== hubId) {
      eventType = "ARRIVED_AT_DESTINATION_HUB";
    } else {
      throw new HubManagerDataError("Shipment is not in transit to this assigned hub.", 409);
    }
  } else if (action === "receive") {
    if (shipment.originHubId === hubId && latest?.eventType === "ARRIVED_AT_ORIGIN_HUB" && latest.hubId === hubId) {
      eventType = "RECEIVED_AT_ORIGIN_HUB";
    } else if (shipment.destinationHubId === hubId && latest?.eventType === "ARRIVED_AT_DESTINATION_HUB" && latest.hubId === hubId) {
      eventType = "RECEIVED_AT_DESTINATION_HUB";
    } else {
      throw new HubManagerDataError("Shipment must have an arrival recorded before physical receipt.", 409);
    }
  } else {
    if (shipment.originHubId !== hubId) {
      throw new HubManagerDataError("This shipment does not originate from the selected hub.", 409);
    }
    if (latest?.eventType !== "RECEIVED_AT_ORIGIN_HUB" || latest.hubId !== hubId) {
      throw new HubManagerDataError("Shipment must be physically recorded at its origin hub before dispatch.", 409);
    }
    eventType = "DISPATCHED";
  }

  await connection.execute<ResultSetHeader>(
    `INSERT INTO shipment_events
       (consignment_no, event_time, event_type, event_status, hub_id, employee_id)
     VALUES (?, CURRENT_TIMESTAMP(), ?, 'COMPLETED', ?, ?)`,
    [consignmentNo, eventType, hubId, employeeId],
  );
  return { consignmentNo, eventType, hubId };
}
