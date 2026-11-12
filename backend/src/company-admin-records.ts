import type { RowDataPacket } from "mysql2";
import { pool } from "./db.js";

export type CompanyRecordKind = "shipments" | "customers" | "employees" | "hubs" | "routes" | "exceptions";
export type CompanyRecordQuery = {
  page: number;
  pageSize: number;
  search: string;
  sortBy: string;
  direction: "asc" | "desc";
  status: string;
  mode: string;
  startDate: string;
  endDate: string;
};

const sortColumns: Record<CompanyRecordKind, Record<string, string>> = {
  shipments: {
    shipmentDate: "s.shipment_date",
    consignmentNo: "s.consignment_no",
    customerName: "c.customer_name",
    status: "status",
    mode: "s.mode",
  },
  customers: {
    customerId: "c.customer_id",
    customerName: "c.customer_name",
    shipmentCount: "shipment_count",
    latestShipment: "latest_shipment",
  },
  employees: {
    employeeId: "e.employee_id",
    name: "e.name",
    role: "e.role",
    status: "e.status",
  },
  hubs: {
    hubId: "h.hub_id",
    city: "h.city",
    status: "h.status",
    shipments: "shipment_legs",
  },
  routes: {
    routeId: "r.route_id",
    mode: "r.mode",
    shipments: "shipment_count",
    delayRate: "delay_rate",
  },
  exceptions: {
    consignmentNo: "consignmentNo",
    status: "status",
    dueDate: "dueDate",
  },
};

function wildcard(search: string): string {
  return `%${search.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function listCompanyRecords(
  companyId: number,
  kind: CompanyRecordKind,
  query: CompanyRecordQuery,
) {
  const limit = query.pageSize;
  const offset = (query.page - 1) * limit;
  const direction = query.direction === "asc" ? "ASC" : "DESC";
  const orderBy = sortColumns[kind][query.sortBy] ?? Object.values(sortColumns[kind])[0]!;
  const search = wildcard(query.search);

  let countSql: string;
  let rowsSql: string;
  let params: Array<string | number>;

  switch (kind) {
    case "shipments": {
      const where = ["s.company_id = ?"];
      params = [companyId];
      if (query.search) {
        where.push("(s.consignment_no LIKE ? OR c.customer_name LIKE ? OR s.delivery_status LIKE ?)");
        params.push(search, search, search);
      }
      if (query.status) {
        where.push("s.delivery_status = ?");
        params.push(query.status);
      }
      if (query.mode) {
        where.push("s.mode = ?");
        params.push(query.mode);
      }
      if (query.startDate) {
        where.push("s.shipment_date >= ?");
        params.push(query.startDate);
      }
      if (query.endDate) {
        where.push("s.shipment_date <= ?");
        params.push(query.endDate);
      }
      const predicate = where.join(" AND ");
      countSql = `SELECT COUNT(*) AS total FROM shipments s
        LEFT JOIN customers c ON c.customer_id = s.customer_id AND c.company_id = s.company_id
        WHERE ${predicate}`;
      rowsSql = `SELECT s.consignment_no AS consignmentNo, s.customer_id AS customerId,
          COALESCE(c.customer_name, 'Customer unavailable') AS customerName,
          COALESCE(oh.city, 'Unavailable') AS origin, COALESCE(dh.city, 'Unavailable') AS destination,
          s.origin_hub_id AS originHubId, s.destination_hub_id AS destinationHubId,
          s.mode, s.chargeable_weight AS chargeableWeight, s.shipment_date AS shipmentDate,
          s.estimated_delivery_date AS expectedDeliveryDate,
          CASE WHEN latest.event_type = 'DELIVERED' THEN 'Delivered'
            ELSE COALESCE(NULLIF(s.delivery_status, ''), 'Unspecified') END AS status,
          s.delivery_status AS recordedOutcome,
          s.actual_transit_days AS actualTransitDays, s.sla_days AS slaDays, s.sla_due_date AS slaDueDate,
          CASE
            WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
              AND s.actual_transit_days IS NOT NULL
              AND s.actual_transit_days > COALESCE(s.sla_days, 4) THEN 'Historically delayed'
            WHEN LOWER(COALESCE(s.delivery_status, '')) IN ('on time','delayed','delivered','completed')
              AND s.actual_transit_days IS NOT NULL THEN 'Within recorded SLA'
            WHEN latest.event_type = 'DELIVERED' THEN 'Unavailable'
            WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN ('on time','delayed','delivered','completed')
              AND s.sla_due_date < CURRENT_DATE()
              THEN CONCAT('Rule-based overdue · ', DATEDIFF(CURRENT_DATE(), s.sla_due_date), ' days')
            WHEN LOWER(COALESCE(s.delivery_status, '')) NOT IN ('on time','delayed','delivered','completed')
              THEN 'Non-terminal'
            ELSE 'Unavailable'
          END AS slaAssessment
        FROM shipments s
        LEFT JOIN customers c ON c.customer_id = s.customer_id AND c.company_id = s.company_id
        LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
        LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id
        LEFT JOIN LATERAL (
          SELECT se.event_type
            FROM shipment_events se
           WHERE se.consignment_no = s.consignment_no
             AND EXISTS (
               SELECT 1 FROM shipments owned
                WHERE owned.consignment_no = se.consignment_no AND owned.company_id = s.company_id
             )
           ORDER BY se.event_time DESC, se.event_id DESC LIMIT 1
        ) latest ON TRUE
        WHERE ${predicate} ORDER BY ${orderBy} ${direction}, s.consignment_no LIMIT ? OFFSET ?`;
      break;
    }
    case "customers": {
      const where = ["c.company_id = ?"];
      params = [companyId];
      if (query.search) {
        where.push("(c.customer_id LIKE ? OR c.customer_name LIKE ? OR c.customer_city LIKE ?)");
        params.push(search, search, search);
      }
      const predicate = where.join(" AND ");
      countSql = `SELECT COUNT(*) AS total FROM customers c WHERE ${predicate}`;
      rowsSql = `SELECT c.customer_id AS customerId, c.customer_name AS customerName,
          c.customer_city AS city, COUNT(DISTINCT s.consignment_no) AS shipmentCount,
          MAX(s.shipment_date) AS latestShipment,
          SUM(CASE WHEN LOWER(COALESCE(s.delivery_status, '')) = 'delayed' THEN 1 ELSE 0 END) AS recordedDelayed
        FROM customers c LEFT JOIN shipments s
          ON s.customer_id = c.customer_id AND s.company_id = c.company_id
        WHERE ${predicate} GROUP BY c.customer_id, c.customer_name, c.customer_city
        ORDER BY ${orderBy} ${direction}, c.customer_id LIMIT ? OFFSET ?`;
      break;
    }
    case "employees": {
      const where = ["e.company_id = ?"];
      params = [companyId];
      if (query.search) {
        where.push("(e.employee_id LIKE ? OR e.name LIKE ? OR e.role LIKE ? OR e.email LIKE ? OR e.phone LIKE ?)");
        params.push(search, search, search, search, search);
      }
      if (query.status) {
        where.push("e.status = ?");
        params.push(query.status);
      }
      const predicate = where.join(" AND ");
      countSql = `SELECT COUNT(*) AS total FROM employees e WHERE ${predicate}`;
      rowsSql = `SELECT e.employee_id AS employeeId, e.name,
          CASE WHEN UPPER(e.role) = 'ADMIN' THEN 'COMPANY_ADMIN' ELSE UPPER(e.role) END AS role,
          e.email,e.phone,e.status,
          COALESCE(GROUP_CONCAT(DISTINCT CONCAT(h.city, ' · ', h.hub_id) ORDER BY h.city SEPARATOR ', '), '') AS assignedHubs
        FROM employees e
        LEFT JOIN employee_hubs eh ON eh.employee_id = e.employee_id AND eh.status = 'Active'
        LEFT JOIN hubs h ON h.hub_id = eh.hub_id AND h.company_id = e.company_id AND h.status = 'Active'
        WHERE ${predicate}
        GROUP BY e.employee_id, e.name, e.role, e.email, e.phone, e.status
        ORDER BY ${orderBy} ${direction}, e.employee_id LIMIT ? OFFSET ?`;
      break;
    }
    case "hubs": {
      const where = ["h.company_id = ?"];
      params = [companyId];
      if (query.search) {
        where.push("(h.hub_id LIKE ? OR h.city LIKE ?)");
        params.push(search, search);
      }
      if (query.status) {
        where.push("h.status = ?");
        params.push(query.status);
      }
      const predicate = where.join(" AND ");
      countSql = `SELECT COUNT(*) AS total FROM hubs h WHERE ${predicate}`;
      rowsSql = `SELECT h.hub_id AS hubId, h.city, h.status,
          (SELECT COUNT(DISTINCT eh.employee_id) FROM employee_hubs eh
            JOIN employees e ON e.employee_id = eh.employee_id AND e.company_id = h.company_id
            WHERE eh.hub_id = h.hub_id AND eh.status = 'Active' AND e.status = 'Active') AS assignedStaff,
          (SELECT COUNT(DISTINCT s.consignment_no) FROM shipments s
            WHERE s.company_id = h.company_id AND (s.origin_hub_id = h.hub_id OR s.destination_hub_id = h.hub_id)) AS shipment_legs
        FROM hubs h WHERE ${predicate}
        ORDER BY ${orderBy} ${direction}, h.hub_id LIMIT ? OFFSET ?`;
      break;
    }
    case "routes": {
      const where = ["r.company_id = ?"];
      params = [companyId];
      if (query.search) {
        where.push("(r.route_id LIKE ? OR oh.city LIKE ? OR dh.city LIKE ? OR r.mode LIKE ?)");
        params.push(search, search, search, search);
      }
      if (query.mode) {
        where.push("r.mode = ?");
        params.push(query.mode);
      }
      const predicate = where.join(" AND ");
      countSql = `SELECT COUNT(*) AS total FROM routes r
        JOIN hubs oh ON oh.hub_id = r.origin_hub_id AND oh.company_id = r.company_id
        JOIN hubs dh ON dh.hub_id = r.destination_hub_id AND dh.company_id = r.company_id
        WHERE ${predicate}`;
      rowsSql = `SELECT r.route_id AS routeId, r.mode, oh.city AS origin, dh.city AS destination,
          COUNT(DISTINCT s.consignment_no) AS shipmentCount,
          SUM(CASE WHEN LOWER(COALESCE(s.delivery_status, '')) = 'delayed' THEN 1 ELSE 0 END) AS recordedDelayed,
          ROUND(100 * SUM(CASE WHEN LOWER(COALESCE(s.delivery_status, '')) = 'delayed' THEN 1 ELSE 0 END)
            / NULLIF(COUNT(s.consignment_no), 0), 1) AS delay_rate
        FROM routes r
        JOIN hubs oh ON oh.hub_id = r.origin_hub_id AND oh.company_id = r.company_id
        JOIN hubs dh ON dh.hub_id = r.destination_hub_id AND dh.company_id = r.company_id
        LEFT JOIN shipments s ON s.route_id = r.route_id AND s.company_id = r.company_id
        WHERE ${predicate}
        GROUP BY r.route_id, r.mode, oh.city, dh.city
        ORDER BY ${orderBy} ${direction}, r.route_id LIMIT ? OFFSET ?`;
      break;
    }
    case "exceptions": {
      const ruleWhere = [
        "s.company_id = ?",
        "LOWER(COALESCE(s.delivery_status, '')) NOT IN ('on time','delayed','delivered','completed')",
        "s.sla_due_date < CURRENT_DATE()",
      ];
      const ruleParams: Array<string | number> = [companyId];
      if (query.search) {
        ruleWhere.push("(s.consignment_no LIKE ? OR s.delivery_status LIKE ?)");
        ruleParams.push(search, search);
      }
      if (query.startDate) {
        ruleWhere.push("s.shipment_date >= ?");
        ruleParams.push(query.startDate);
      }
      if (query.endDate) {
        ruleWhere.push("s.shipment_date <= ?");
        ruleParams.push(query.endDate);
      }
      const eventWhere = [
        "s.company_id = ?",
        "(SELECT COUNT(*) FROM shipments same_id WHERE same_id.consignment_no = se.consignment_no) = 1",
        "(LOWER(COALESCE(se.event_type, '')) LIKE '%exception%' OR LOWER(COALESCE(se.event_status, '')) LIKE '%exception%' OR LOWER(COALESCE(se.event_type, '')) LIKE '%delay%' OR LOWER(COALESCE(se.event_status, '')) LIKE '%delay%' OR LOWER(COALESCE(se.event_type, '')) LIKE '%damage%' OR LOWER(COALESCE(se.event_type, '')) LIKE '%lost%' OR LOWER(COALESCE(se.event_type, '')) LIKE '%weather%')",
      ];
      const eventParams: Array<string | number> = [companyId];
      if (query.search) {
        eventWhere.push("(s.consignment_no LIKE ? OR se.event_type LIKE ? OR se.event_status LIKE ?)");
        eventParams.push(search, search, search);
      }
      if (query.startDate) {
        eventWhere.push("s.shipment_date >= ?");
        eventParams.push(query.startDate);
      }
      if (query.endDate) {
        eventWhere.push("s.shipment_date <= ?");
        eventParams.push(query.endDate);
      }
      const ruleQuery = `SELECT s.consignment_no AS consignmentNo, 'Rule-based overdue SLA' AS source,
          s.shipment_date AS shipmentDate, NULL AS eventTime, 'Recorded due date passed' AS eventType,
          s.delivery_status AS status, s.sla_due_date AS dueDate,
          DATEDIFF(CURRENT_DATE(), s.sla_due_date) AS overdueDays
        FROM shipments s WHERE ${ruleWhere.join(" AND ")}`;
      const eventQuery = `SELECT s.consignment_no AS consignmentNo, 'Recorded shipment event' AS source,
          s.shipment_date AS shipmentDate, se.event_time AS eventTime,
          COALESCE(NULLIF(se.event_status, ''), NULLIF(se.event_type, ''), 'Recorded exception event') AS eventType,
          s.delivery_status AS status, s.sla_due_date AS dueDate, NULL AS overdueDays
        FROM shipment_events se
        JOIN shipments s ON s.consignment_no = se.consignment_no
        WHERE ${eventWhere.join(" AND ")}`;
      const combinedQuery = `${ruleQuery} UNION ALL ${eventQuery}`;
      params = [...ruleParams, ...eventParams];
      countSql = `SELECT COUNT(*) AS total FROM (${combinedQuery}) AS company_exceptions`;
      rowsSql = `SELECT * FROM (${combinedQuery}) AS company_exceptions
        ORDER BY ${orderBy} ${direction}, consignmentNo LIMIT ? OFFSET ?`;
      break;
    }
  }

  const [countRows] = await pool.execute<Array<RowDataPacket & { total: number }>>(countSql, params);
  const [rows] = await pool.execute<RowDataPacket[]>(rowsSql, [...params, limit, offset]);
  return {
    rows,
    pagination: {
      page: query.page,
      pageSize: limit,
      total: Number(countRows[0]?.total ?? 0),
      totalPages: Math.ceil(Number(countRows[0]?.total ?? 0) / limit),
    },
  };
}
