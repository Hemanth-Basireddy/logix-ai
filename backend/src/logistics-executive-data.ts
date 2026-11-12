import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { Pool, PoolConnection } from "mysql2/promise";
import { config } from "./config.js";

type Executor = Pick<Pool | PoolConnection, "execute">;
type TaskType = "PICKUP" | "DELIVERY";
type Action = "accept" | "start" | "pickup" | "handover" | "out-for-delivery" | "deliver" | "fail";

export class LogisticsTaskError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409) {
    super(message);
    this.name = "LogisticsTaskError";
  }
}

const shipmentFields = `s.consignment_no AS consignmentNo, s.shipment_date AS shipmentDate,
  s.estimated_delivery_date AS expectedDeliveryDate, s.delivery_status AS shipmentStatus,
  s.mode, s.origin_hub_id AS originHubId, oh.city AS originCity,
  s.destination_hub_id AS destinationHubId, dh.city AS destinationCity,
  s.sender_name AS senderName, s.sender_phone AS senderPhone,
  s.sender_address AS senderAddress, s.sender_city AS senderCity,
  s.sender_state AS senderState, s.sender_pincode AS senderPincode,
  s.recipient_name AS recipientName, s.recipient_phone AS recipientPhone,
  s.recipient_address AS recipientAddress, s.recipient_city AS recipientCity,
  s.receiver_state AS recipientState, s.receiver_pincode AS recipientPincode`;

const shipmentJoins = `LEFT JOIN hubs oh ON oh.hub_id = s.origin_hub_id AND oh.company_id = s.company_id
  LEFT JOIN hubs dh ON dh.hub_id = s.destination_hub_id AND dh.company_id = s.company_id`;

function assignmentPredicate(taskType: TaskType, alias = "s") {
  const prefix = taskType === "PICKUP" ? "origin" : "destination";
  return `(${alias}.${prefix}_logistics_executive_1_id = ? OR ${alias}.${prefix}_logistics_executive_2_id = ?)`;
}

function inferredStatus(taskType: TaskType, latestAlias = "latest") {
  const exception = `${latestAlias}.event_type = '${taskType}_EXCEPTION'`;
  if (taskType === "PICKUP") {
    return `CASE WHEN ${exception} THEN 'FAILED' WHEN ${latestAlias}.event_type = 'RECEIVED_AT_ORIGIN_HUB' THEN 'COMPLETED' WHEN ${latestAlias}.event_type = 'PICKED_UP' THEN 'IN_PROGRESS' ELSE 'PENDING' END`;
  }
  return `CASE WHEN ${exception} THEN 'FAILED' WHEN ${latestAlias}.event_type = 'DELIVERED' THEN 'COMPLETED' WHEN ${latestAlias}.event_type = 'OUT_FOR_DELIVERY' THEN 'IN_PROGRESS' ELSE 'PENDING' END`;
}

function latestEventJoin() {
  return `LEFT JOIN LATERAL (
    SELECT se.event_type, se.event_time, se.event_status, se.hub_id, se.employee_id
      FROM shipment_events se
     WHERE se.consignment_no = s.consignment_no
       AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no = se.consignment_no) = 1
     ORDER BY se.event_time DESC, se.event_id DESC LIMIT 1
  ) latest ON TRUE`;
}

const activeDeliveryStatus = (progressAlias = "p") => `(${progressAlias}.task_progress_id IS NOT NULL OR LOWER(COALESCE(s.delivery_status, '')) NOT IN ('delivered','completed','on time','delayed'))`;

async function listType(executor: Executor, companyId: number, employeeId: string, taskType: TaskType, filters: { status?: string; search?: string }) {
  const hubIdField = taskType === "PICKUP" ? "s.origin_hub_id" : "s.destination_hub_id";
  const activeAssignment = `EXISTS (SELECT 1 FROM employee_hubs eh
    JOIN employees assigned_employee ON assigned_employee.employee_id=eh.employee_id
      AND assigned_employee.company_id=s.company_id AND UPPER(assigned_employee.status)='ACTIVE'
      AND UPPER(assigned_employee.role)='LOGISTICS_EXECUTIVE'
    JOIN hubs assigned_hub ON assigned_hub.hub_id=eh.hub_id AND assigned_hub.company_id=s.company_id
      AND UPPER(assigned_hub.status)='ACTIVE'
    WHERE eh.employee_id=? AND eh.hub_id=${hubIdField} AND UPPER(eh.status)='ACTIVE')`;
  const clauses = ["s.company_id = ?", assignmentPredicate(taskType), activeAssignment, activeDeliveryStatus()];
  const params: Array<string | number> = [companyId, employeeId, employeeId, employeeId];
  if (filters.status && filters.status !== "ALL") {
    clauses.push(`COALESCE(p.status, ${inferredStatus(taskType)}) = ?`);
    params.push(filters.status);
  }
  if (filters.search) {
    clauses.push("(s.consignment_no LIKE ? OR s.sender_name LIKE ? OR s.recipient_name LIKE ?)");
    const pattern = `%${filters.search}%`;
    params.push(pattern, pattern, pattern);
  }
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT '${taskType}' AS taskType, CONCAT('${taskType}', ':', s.consignment_no) AS taskKey,
            COALESCE(p.status, ${inferredStatus(taskType)}) AS status,
            p.failure_reason AS failureReason, p.task_progress_id AS progressId,
            ${taskType === "PICKUP" ? "s.origin_hub_id" : "s.destination_hub_id"} AS hubId,
            ${taskType === "PICKUP" ? "oh.city" : "dh.city"} AS hubCity,
            s.origin_logistics_executive_1_id AS originExecutive1Id,
            s.origin_logistics_executive_2_id AS originExecutive2Id,
            s.destination_logistics_executive_1_id AS destinationExecutive1Id,
            s.destination_logistics_executive_2_id AS destinationExecutive2Id,
            p.created_at AS assignedAt, ${shipmentFields},
            latest.event_type AS lastEvent, latest.event_time AS lastEventAt,
            latest.hub_id AS lastEventHubId
       FROM shipments s
       ${shipmentJoins}
       LEFT JOIN logistics_task_progress p ON p.company_id = s.company_id
         AND p.consignment_no = s.consignment_no AND p.task_type = '${taskType}'
       ${latestEventJoin()}
      WHERE ${clauses.join(" AND ")}
      ORDER BY FIELD(COALESCE(p.status, ${inferredStatus(taskType)}), 'PENDING','ACCEPTED','IN_PROGRESS','FAILED','COMPLETED'), s.estimated_delivery_date, s.consignment_no
      LIMIT 500`,
    params,
  );
  return rows;
}

export async function listExecutiveTasks(executor: Executor, companyId: number, employeeId: string, filters: { status?: string; type?: TaskType; search?: string } = {}) {
  const types: TaskType[] = filters.type ? [filters.type] : ["PICKUP", "DELIVERY"];
  const [tasks, deliveries] = await Promise.all([
    listType(executor, companyId, employeeId, types[0]!, filters),
    types.length === 2 ? listType(executor, companyId, employeeId, "DELIVERY", filters) : Promise.resolve([]),
  ]);
  return [...tasks, ...deliveries].sort((a, b) => String(a.expectedDeliveryDate ?? "").localeCompare(String(b.expectedDeliveryDate ?? "")));
}

export type ExecutiveHistoryFilters = { type?: TaskType; search?: string; offset?: number; limit?: number };

function historyAssignmentPredicate(taskType: TaskType) {
  const prefix = taskType === "PICKUP" ? "origin" : "destination";
  return `(s.${prefix}_logistics_executive_1_id = ? OR s.${prefix}_logistics_executive_2_id = ?)`;
}

function historyFilters(companyId: number, employeeId: string, filters: ExecutiveHistoryFilters, taskType: TaskType) {
  const clauses = [
    "s.company_id = ?",
    historyAssignmentPredicate(taskType),
    "LOWER(COALESCE(s.delivery_status,'')) IN ('delivered','completed','on time','delayed')",
    "NOT EXISTS (SELECT 1 FROM logistics_task_progress p WHERE p.company_id=s.company_id AND p.consignment_no=s.consignment_no AND p.task_type=?)",
    "(SELECT COUNT(*) FROM shipments unique_shipment WHERE unique_shipment.consignment_no=s.consignment_no)=1",
  ];
  const values: Array<string | number> = [companyId, employeeId, employeeId, taskType];
  if (filters.search) {
    clauses.push("(s.consignment_no LIKE ? OR s.sender_name LIKE ? OR s.recipient_name LIKE ?)");
    const pattern = `%${filters.search}%`;
    values.push(pattern, pattern, pattern);
  }
  return { sql: clauses.join(" AND "), values };
}

const historicalEventSummary = `LEFT JOIN LATERAL (
  SELECT COUNT(*) AS eventCount,
         MIN(CASE WHEN se.event_type='PICKED_UP' THEN se.event_time END) AS pickedUpAt,
         MIN(CASE WHEN se.event_type='HANDED_OVER_AT_ORIGIN_HUB' THEN se.event_time END) AS handedOverAt,
         MIN(CASE WHEN se.event_type='OUT_FOR_DELIVERY' THEN se.event_time END) AS outForDeliveryAt,
         MIN(CASE WHEN se.event_type='DELIVERED' THEN se.event_time END) AS deliveredAt,
         SUM(CASE WHEN se.event_type IN ('PICKUP_EXCEPTION','DELIVERY_EXCEPTION') THEN 1 ELSE 0 END) AS failedAttemptCount
    FROM shipment_events se
   WHERE se.consignment_no=s.consignment_no
     AND (SELECT COUNT(*) FROM shipments unique_event_shipment WHERE unique_event_shipment.consignment_no=se.consignment_no)=1
) history_events ON TRUE`;

export async function listExecutiveAssignmentHistory(
  executor: Executor,
  companyId: number,
  employeeId: string,
  filters: ExecutiveHistoryFilters = {},
) {
  const types: TaskType[] = filters.type ? [filters.type] : ["PICKUP", "DELIVERY"];
  const perType = await Promise.all(types.map(async (taskType) => {
    const where = historyFilters(companyId, employeeId, filters, taskType);
    const [countRows] = await executor.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM shipments s WHERE ${where.sql}`,
      where.values,
    );
    const [rows] = await executor.execute<RowDataPacket[]>(
      `SELECT '${taskType}' AS taskType, CONCAT('${taskType}', ':', s.consignment_no) AS taskKey,
              s.consignment_no AS consignmentNo, s.shipment_date AS shipmentDate,
              s.delivery_status AS recordedOutcome, s.estimated_delivery_date AS expectedDeliveryDate,
              s.mode, s.origin_hub_id AS originHubId, oh.city AS originCity,
              s.destination_hub_id AS destinationHubId, dh.city AS destinationCity,
              ${taskType === "PICKUP" ? "s.origin_hub_id" : "s.destination_hub_id"} AS hubId,
              ${taskType === "PICKUP" ? "oh.city" : "dh.city"} AS hubCity,
              s.sender_name AS senderName, s.sender_phone AS senderPhone,
              s.sender_address AS senderAddress, s.sender_city AS senderCity,
              s.sender_state AS senderState, s.sender_pincode AS senderPincode,
              s.recipient_name AS recipientName, s.recipient_phone AS recipientPhone,
              s.recipient_address AS recipientAddress, s.recipient_city AS recipientCity,
              s.receiver_state AS recipientState, s.receiver_pincode AS recipientPincode,
              COALESCE(history_events.eventCount,0) AS eventCount,
              history_events.pickedUpAt, history_events.handedOverAt,
              history_events.outForDeliveryAt, history_events.deliveredAt,
              COALESCE(history_events.failedAttemptCount,0) AS failedAttemptCount
         FROM shipments s ${shipmentJoins}
         ${historicalEventSummary}
        WHERE ${where.sql}
        ORDER BY s.shipment_date DESC, s.consignment_no
        LIMIT ? OFFSET ?`,
        [...where.values, (filters.offset ?? 0) + (filters.limit ?? 50), 0],
    );
    return { rows, total: Number(countRows[0]?.total ?? 0) };
  }));
  return {
    assignments: perType.flatMap((item) => item.rows)
      .sort((a, b) => String(b.shipmentDate ?? "").localeCompare(String(a.shipmentDate ?? "")) || String(a.consignmentNo).localeCompare(String(b.consignmentNo)))
      .slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 50)),
    total: perType.reduce((sum, item) => sum + item.total, 0),
  };
}

export async function getExecutiveAssignmentHistoryDetail(
  executor: Executor,
  companyId: number,
  employeeId: string,
  taskType: TaskType,
  consignmentNo: string,
) {
  const where = historyFilters(companyId, employeeId, {}, taskType);
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.shipment_date AS shipmentDate,
            s.delivery_status AS recordedOutcome, s.estimated_delivery_date AS expectedDeliveryDate,
            s.mode, s.origin_hub_id AS originHubId, oh.city AS originCity,
            s.destination_hub_id AS destinationHubId, dh.city AS destinationCity,
            ${taskType === "PICKUP" ? "s.origin_hub_id" : "s.destination_hub_id"} AS hubId,
            ${taskType === "PICKUP" ? "oh.city" : "dh.city"} AS hubCity,
            s.sender_name AS senderName, s.sender_phone AS senderPhone,
            s.sender_address AS senderAddress, s.sender_city AS senderCity,
            s.sender_state AS senderState, s.sender_pincode AS senderPincode,
            s.recipient_name AS recipientName, s.recipient_phone AS recipientPhone,
            s.recipient_address AS recipientAddress, s.recipient_city AS recipientCity,
            s.receiver_state AS recipientState, s.receiver_pincode AS recipientPincode
       FROM shipments s ${shipmentJoins}
      WHERE ${where.sql} AND s.consignment_no=? LIMIT 1`,
    [...where.values, consignmentNo],
  );
  if (!rows[0]) return null;
  const [events] = await executor.execute<RowDataPacket[]>(
    `SELECT se.event_time AS eventTime, se.event_type AS eventType, se.event_status AS eventStatus,
            se.hub_id AS hubId, h.city, CASE WHEN se.employee_id IS NULL THEN NULL ELSE e.name END AS employeeName, se.notes
       FROM shipment_events se JOIN shipments s ON s.consignment_no=se.consignment_no AND s.company_id=?
       LEFT JOIN hubs h ON h.hub_id=se.hub_id AND h.company_id=s.company_id
       LEFT JOIN employees e ON e.employee_id=se.employee_id AND e.company_id=s.company_id
      WHERE s.consignment_no=? AND (SELECT COUNT(*) FROM shipments unique_event_shipment WHERE unique_event_shipment.consignment_no=se.consignment_no)=1
      ORDER BY se.event_time,se.event_id LIMIT 500`,
    [companyId, consignmentNo],
  );
  const recordedEvents = events as Array<RowDataPacket & { eventType: string; eventTime: string | Date }>;
  const firstEventTime = (eventType: string) => recordedEvents.find((event) => event.eventType === eventType)?.eventTime ?? null;
  return {
    ...rows[0], taskType, taskKey: `${taskType}:${consignmentNo}`, events,
    eventCount: recordedEvents.length,
    failedAttemptCount: recordedEvents.filter((event) => event.eventType === "PICKUP_EXCEPTION" || event.eventType === "DELIVERY_EXCEPTION").length,
    pickedUpAt: firstEventTime("PICKED_UP"),
    handedOverAt: firstEventTime("HANDED_OVER_AT_ORIGIN_HUB"),
    outForDeliveryAt: firstEventTime("OUT_FOR_DELIVERY"),
    deliveredAt: firstEventTime("DELIVERED"),
  };
}

async function assignedShipment(executor: Executor, companyId: number, employeeId: string, taskType: TaskType, consignmentNo: string) {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT ${shipmentFields},
            ${taskType === "PICKUP" ? "oh.city" : "dh.city"} AS hubCity,
            ${taskType === "PICKUP" ? "s.origin_hub_id" : "s.destination_hub_id"} AS hubId,
            COALESCE(p.status, ${inferredStatus(taskType)}) AS status,
            p.failure_reason AS failureReason, p.task_progress_id AS progressId,
            latest.event_type AS lastEvent, latest.event_time AS lastEventAt,
            latest.hub_id AS lastEventHubId,
            (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no = s.consignment_no) AS shipmentMatches
       FROM shipments s
       ${shipmentJoins}
       LEFT JOIN logistics_task_progress p ON p.company_id = s.company_id
         AND p.consignment_no = s.consignment_no AND p.task_type = '${taskType}'
       ${latestEventJoin()}
      WHERE s.company_id = ? AND s.consignment_no = ? AND ${assignmentPredicate(taskType)}
      LIMIT 2`,
    [companyId, consignmentNo, employeeId, employeeId],
  );
  if (!rows.length) return null;
  if (rows.length !== 1 || Number(rows[0]!.shipmentMatches) !== 1) {
    throw new LogisticsTaskError("Shipment identifier is ambiguous and cannot be processed.", 409);
  }
  if (rows[0]!.progressId == null && ["delivered", "completed", "on time", "delayed"].includes(String(rows[0]!.shipmentStatus ?? "").toLowerCase())) return null;
  return rows[0]!;
}

export async function getExecutiveTaskDetail(executor: Executor, companyId: number, employeeId: string, taskType: TaskType, consignmentNo: string) {
  const task = await assignedShipment(executor, companyId, employeeId, taskType, consignmentNo);
  if (!task) return null;
  const [assignments] = await executor.execute<RowDataPacket[]>(
    `SELECT 1 FROM employee_hubs eh
       JOIN employees e ON e.employee_id = eh.employee_id AND e.company_id = ?
         AND UPPER(e.status) = 'ACTIVE' AND UPPER(e.role) = 'LOGISTICS_EXECUTIVE'
       JOIN hubs h ON h.hub_id = eh.hub_id AND h.company_id = e.company_id AND UPPER(h.status) = 'ACTIVE'
      WHERE eh.employee_id = ? AND eh.hub_id = ? AND UPPER(eh.status) = 'ACTIVE' LIMIT 1`,
    [companyId, employeeId, task.hubId],
  );
  if (!assignments.length) return null;
  const [events] = await executor.execute<RowDataPacket[]>(
    `SELECT se.event_time AS eventTime, se.event_type AS eventType, se.event_status AS eventStatus,
            se.hub_id AS hubId, h.city, CASE WHEN se.employee_id IS NULL THEN NULL ELSE e.name END AS employeeName, se.notes
       FROM shipment_events se
       JOIN shipments s ON s.consignment_no = se.consignment_no AND s.company_id = ?
       LEFT JOIN hubs h ON h.hub_id = se.hub_id AND h.company_id = s.company_id
       LEFT JOIN employees e ON e.employee_id = se.employee_id AND e.company_id = s.company_id
      WHERE s.consignment_no = ?
        AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no = s.consignment_no) = 1
      ORDER BY se.event_time DESC, se.event_id DESC LIMIT 100`,
    [companyId, consignmentNo],
  );
  const [paymentRows] = await executor.execute<RowDataPacket[]>(
    `SELECT r.charge_payer AS chargePayer,r.collection_method AS collectionMethod,r.payment_status AS paymentStatus,
            COALESCE(p.amount,s.total_amount) AS shippingCharge,s.cod_amount AS codAmount,
            COALESCE((SELECT SUM(c.amount) FROM shipment_collections c WHERE c.company_id=s.company_id AND c.consignment_no=s.consignment_no AND c.collection_method='COD' AND c.collection_status='COLLECTED'),0) AS codCollected,
            COALESCE((SELECT SUM(c.amount) FROM shipment_collections c WHERE c.company_id=s.company_id AND c.consignment_no=s.consignment_no AND c.collection_method IN ('PAY_AT_PICKUP','PAY_AT_DELIVERY') AND c.collection_status='COLLECTED'),0) AS shippingCollected
       FROM shipments s JOIN customer_booking_requests r ON r.consignment_no=s.consignment_no AND r.status='APPROVED'
       LEFT JOIN shipment_payments p ON p.company_id=s.company_id AND p.booking_request_id=r.booking_request_id
      WHERE s.company_id=? AND s.consignment_no=? LIMIT 1`,
    [companyId, consignmentNo],
  );
  return { ...task, ...(paymentRows[0] ?? {}), taskType, taskKey: `${taskType}:${consignmentNo}`, events };
}

export async function listHubManagerTasks(executor: Executor, companyId: number, hubIds: string[], hubFilter: string, status: string) {
  const permitted = hubFilter ? [hubFilter] : hubIds;
  if (!permitted.length) return [];
  const placeholders = permitted.map(() => "?").join(",");
  const params: Array<string | number> = [companyId, ...permitted, ...(status === "ALL" ? [] : [status]), companyId, ...permitted, ...(status === "ALL" ? [] : [status])];
  const pickupStatus = `COALESCE(p.status, ${inferredStatus("PICKUP")})`;
  const deliveryStatus = `COALESCE(d.status, ${inferredStatus("DELIVERY")})`;
  const pickupState = status === "ALL" ? "" : ` AND ${pickupStatus} = ?`;
  const deliveryState = status === "ALL" ? "" : ` AND ${deliveryStatus} = ?`;
  const pickupActive = activeDeliveryStatus("p");
  const deliveryActive = activeDeliveryStatus("d");
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT * FROM (
       SELECT 'PICKUP' AS taskType, CONCAT('PICKUP:',s.consignment_no) AS taskKey,
              s.consignment_no AS consignmentNo, s.origin_hub_id AS hubId, oh.city AS hubCity,
              COALESCE(p.status, ${inferredStatus("PICKUP")}) AS status,
              ex.employee_id AS employeeId, ex.name AS employeeName,
              s.delivery_status AS shipmentStatus, s.estimated_delivery_date AS expectedDeliveryDate,
              p.created_at AS assignedAt
         FROM shipments s JOIN hubs oh ON oh.hub_id=s.origin_hub_id AND oh.company_id=s.company_id
         JOIN employees ex ON ex.company_id=s.company_id AND UPPER(ex.role)='LOGISTICS_EXECUTIVE' AND UPPER(ex.status)='ACTIVE'
           AND (ex.employee_id=s.origin_logistics_executive_1_id OR ex.employee_id=s.origin_logistics_executive_2_id)
         LEFT JOIN logistics_task_progress p ON p.company_id=s.company_id AND p.consignment_no=s.consignment_no AND p.task_type='PICKUP'
         ${latestEventJoin()}
        WHERE s.company_id=? AND s.origin_hub_id IN (${placeholders}) AND ${pickupActive}${pickupState}
          AND EXISTS (SELECT 1 FROM employee_hubs eh JOIN hubs ah ON ah.hub_id=eh.hub_id AND ah.company_id=s.company_id AND UPPER(ah.status)='ACTIVE'
                       WHERE eh.employee_id=ex.employee_id AND eh.hub_id=s.origin_hub_id AND UPPER(eh.status)='ACTIVE')
       UNION ALL
       SELECT 'DELIVERY' AS taskType, CONCAT('DELIVERY:',s.consignment_no) AS taskKey,
              s.consignment_no AS consignmentNo, s.destination_hub_id AS hubId, dh.city AS hubCity,
              COALESCE(d.status, ${inferredStatus("DELIVERY","delivery_event")}) AS status,
              ex.employee_id AS employeeId, ex.name AS employeeName,
              s.delivery_status AS shipmentStatus, s.estimated_delivery_date AS expectedDeliveryDate,
              d.created_at AS assignedAt
         FROM shipments s JOIN hubs dh ON dh.hub_id=s.destination_hub_id AND dh.company_id=s.company_id
         JOIN employees ex ON ex.company_id=s.company_id AND UPPER(ex.role)='LOGISTICS_EXECUTIVE' AND UPPER(ex.status)='ACTIVE'
           AND (ex.employee_id=s.destination_logistics_executive_1_id OR ex.employee_id=s.destination_logistics_executive_2_id)
         LEFT JOIN logistics_task_progress d ON d.company_id=s.company_id AND d.consignment_no=s.consignment_no AND d.task_type='DELIVERY'
         LEFT JOIN LATERAL (SELECT se.event_type FROM shipment_events se WHERE se.consignment_no=s.consignment_no AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=se.consignment_no)=1 ORDER BY se.event_time DESC,se.event_id DESC LIMIT 1) delivery_event ON TRUE
        WHERE s.company_id=? AND s.destination_hub_id IN (${placeholders}) AND ${deliveryActive}${deliveryState}
          AND EXISTS (SELECT 1 FROM employee_hubs eh JOIN hubs ah ON ah.hub_id=eh.hub_id AND ah.company_id=s.company_id AND UPPER(ah.status)='ACTIVE'
                       WHERE eh.employee_id=ex.employee_id AND eh.hub_id=s.destination_hub_id AND UPPER(eh.status)='ACTIVE')
      ) tasks ORDER BY assignedAt DESC, consignmentNo LIMIT 500`,
    params,
  );
  return rows;
}

export async function createLogisticsTask(connection: PoolConnection, args: {
  companyId: number; managerId: string; hubId: string; employeeId: string; consignmentNo: string; taskType: TaskType;
}) {
  const [manager] = await connection.execute<RowDataPacket[]>(
    `SELECT 1 FROM employee_hubs eh JOIN employees e ON e.employee_id=eh.employee_id AND e.company_id=? AND UPPER(e.status)='ACTIVE' AND UPPER(e.role)='HUB_MANAGER'
       JOIN hubs h ON h.hub_id=eh.hub_id AND h.company_id=e.company_id AND UPPER(h.status)='ACTIVE'
      WHERE eh.employee_id=? AND eh.hub_id=? AND UPPER(eh.status)='ACTIVE' LIMIT 1`,
    [args.companyId, args.managerId, args.hubId],
  );
  if (!manager.length) throw new LogisticsTaskError("You are not authorized to assign work for this hub.", 403);
  const [executives] = await connection.execute<RowDataPacket[]>(
    `SELECT 1 FROM employee_hubs eh JOIN employees e ON e.employee_id=eh.employee_id AND e.company_id=? AND UPPER(e.status)='ACTIVE' AND UPPER(e.role)='LOGISTICS_EXECUTIVE'
       JOIN hubs h ON h.hub_id=eh.hub_id AND h.company_id=e.company_id AND UPPER(h.status)='ACTIVE'
      WHERE eh.employee_id=? AND eh.hub_id=? AND UPPER(eh.status)='ACTIVE' LIMIT 1`,
    [args.companyId, args.employeeId, args.hubId],
  );
  if (!executives.length) throw new LogisticsTaskError("Select an active Logistics Executive assigned to this hub.", 400);
  const [shipments] = await connection.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.origin_hub_id AS originHubId, s.destination_hub_id AS destinationHubId,
            s.route_id AS routeId, LOWER(COALESCE(s.delivery_status,'')) AS deliveryStatus,
            s.origin_logistics_executive_1_id AS origin1, s.origin_logistics_executive_2_id AS origin2,
            s.destination_logistics_executive_1_id AS destination1, s.destination_logistics_executive_2_id AS destination2,
            latest.event_type AS eventType, latest.hub_id AS eventHubId,
            (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=s.consignment_no) AS shipmentMatches
       FROM shipments s ${latestEventJoin()}
      WHERE s.company_id=? AND s.consignment_no=? LIMIT 2 FOR UPDATE`,
    [args.companyId, args.consignmentNo],
  );
  if (!shipments.length) throw new LogisticsTaskError("Shipment was not found in your company.", 404);
  if (shipments.length !== 1 || Number(shipments[0]!.shipmentMatches) !== 1) throw new LogisticsTaskError("Shipment identifier is ambiguous and cannot be assigned.", 409);
  const shipment = shipments[0]!;
  const [approvedRequests] = await connection.execute<RowDataPacket[]>(
    `SELECT 1 FROM customer_booking_requests r JOIN customer_accounts a ON a.customer_account_id=r.customer_account_id AND a.company_id=?
      WHERE r.consignment_no=? AND r.status='APPROVED' LIMIT 1`,
    [args.companyId,args.consignmentNo],
  );
  if (!approvedRequests.length) throw new LogisticsTaskError("Shipment must originate from an Operations-approved customer booking before it can be assigned.", 409);
  if (["delivered", "completed", "on time", "delayed"].includes(String(shipment.deliveryStatus))) throw new LogisticsTaskError("This shipment has a recorded final outcome and cannot be assigned as current work.", 409);
  const prefix = args.taskType === "PICKUP" ? "origin" : "destination";
  const hubField = args.taskType === "PICKUP" ? "originHubId" : "destinationHubId";
  if (shipment[hubField] !== args.hubId) throw new LogisticsTaskError("The selected hub does not match this task's shipment route.", 409);
  if (!shipment.routeId) throw new LogisticsTaskError("Shipment has no configured route.", 409);
  const [routes] = await connection.execute<RowDataPacket[]>(
    `SELECT 1 FROM routes WHERE route_id=? AND company_id=? AND origin_hub_id=? AND destination_hub_id=? LIMIT 1`,
    [shipment.routeId, args.companyId, shipment.originHubId, shipment.destinationHubId],
  );
  if (!routes.length) throw new LogisticsTaskError("Shipment route does not match its company and hub assignments.", 409);
  if (args.taskType === "PICKUP" && shipment.eventType !== "BOOKED") throw new LogisticsTaskError("Pickup can only be assigned after a customer booking has been approved and its BOOKED event recorded.", 409);
  if (args.taskType === "DELIVERY" && (shipment.eventType !== "RECEIVED_AT_DESTINATION_HUB" || shipment.eventHubId !== args.hubId)) throw new LogisticsTaskError("Delivery can only be assigned after physical receipt is recorded at this destination hub.", 409);

  const slot1 = shipment[`${prefix}1`];
  const slot2 = shipment[`${prefix}2`];
  if (slot1 !== args.employeeId && slot2 !== args.employeeId) {
    const slot = slot1 == null ? `${prefix}_logistics_executive_1_id` : slot2 == null ? `${prefix}_logistics_executive_2_id` : null;
    if (!slot) throw new LogisticsTaskError("Both executive assignment slots for this shipment are already in use.", 409);
    await connection.execute<ResultSetHeader>(
      `UPDATE shipments SET ${slot} = ? WHERE company_id = ? AND consignment_no = ? AND ${slot} IS NULL`,
      [args.employeeId, args.companyId, args.consignmentNo],
    );
  }
  try {
    await connection.execute<ResultSetHeader>(
      `INSERT INTO logistics_task_progress (company_id, consignment_no, task_type, status, assigned_by_employee_id)
       VALUES (?, ?, ?, 'PENDING', ?)` ,
      [args.companyId, args.consignmentNo, args.taskType, args.managerId],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new LogisticsTaskError("A progress record already exists for this task.", 409);
    throw error;
  }
  return { taskKey: `${args.taskType}:${args.consignmentNo}`, taskType: args.taskType, consignmentNo: args.consignmentNo, status: "PENDING" };
}

export async function performExecutiveTaskAction(connection: PoolConnection, args: {
  companyId: number; employeeId: string; taskType: TaskType; consignmentNo: string; action: Action; trackingId?: string; reason?: string;
}) {
  const prefix = args.taskType === "PICKUP" ? "origin" : "destination";
  const [shipments] = await connection.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo, s.origin_hub_id AS originHubId, s.destination_hub_id AS destinationHubId,
            s.delivery_status AS shipmentStatus, LOWER(COALESCE(s.delivery_status,'')) AS deliveryStatus,
            (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=s.consignment_no) AS shipmentMatches
       FROM shipments s WHERE s.company_id=? AND s.consignment_no=?
        AND (s.${prefix}_logistics_executive_1_id=? OR s.${prefix}_logistics_executive_2_id=?)
      LIMIT 2 FOR UPDATE`,
    [args.companyId, args.consignmentNo, args.employeeId, args.employeeId],
  );
  if (!shipments.length) throw new LogisticsTaskError("Task was not found in your assigned work.", 404);
  if (shipments.length !== 1 || Number(shipments[0]!.shipmentMatches) !== 1) throw new LogisticsTaskError("Task shipment identifier is ambiguous.", 409);
  const shipment = shipments[0]!;
  if (["delivered", "completed", "on time", "delayed"].includes(String(shipment.deliveryStatus))) throw new LogisticsTaskError("This shipment has a recorded final outcome; task actions are disabled.", 409);
  const hubId = String(args.taskType === "PICKUP" ? shipment.originHubId : shipment.destinationHubId);
  const [assignments] = await connection.execute<RowDataPacket[]>(
    `SELECT 1 FROM employee_hubs eh JOIN employees e ON e.employee_id=eh.employee_id AND e.company_id=? AND UPPER(e.status)='ACTIVE' AND UPPER(e.role)='LOGISTICS_EXECUTIVE'
       JOIN hubs h ON h.hub_id=eh.hub_id AND h.company_id=e.company_id AND UPPER(h.status)='ACTIVE'
      WHERE eh.employee_id=? AND eh.hub_id=? AND UPPER(eh.status)='ACTIVE' LIMIT 1`,
    [args.companyId, args.employeeId, hubId],
  );
  if (!assignments.length) throw new LogisticsTaskError("Your active assignment to this task hub is required.", 403);
  const [stateRows] = await connection.execute<RowDataPacket[]>(
    `SELECT status, failure_reason AS failureReason FROM logistics_task_progress WHERE company_id=? AND consignment_no=? AND task_type=? FOR UPDATE`,
    [args.companyId, args.consignmentNo, args.taskType],
  );
  const [eventRows] = await connection.execute<RowDataPacket[]>(
    `SELECT se.event_type AS eventType, se.hub_id AS hubId FROM shipment_events se
      WHERE se.consignment_no=? AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=se.consignment_no)=1
      ORDER BY se.event_time DESC,se.event_id DESC LIMIT 1 FOR UPDATE`,
    [args.consignmentNo],
  );
  const latest = eventRows[0];
  const explicitStatus = stateRows[0]?.status as string | undefined;
  const status = explicitStatus ?? (args.taskType === "PICKUP"
    ? latest?.eventType === "PICKUP_EXCEPTION" ? "FAILED" : latest?.eventType === "RECEIVED_AT_ORIGIN_HUB" ? "COMPLETED" : latest?.eventType === "PICKED_UP" ? "IN_PROGRESS" : "PENDING"
    : latest?.eventType === "DELIVERY_EXCEPTION" ? "FAILED" : latest?.eventType === "DELIVERED" ? "COMPLETED" : latest?.eventType === "OUT_FOR_DELIVERY" ? "IN_PROGRESS" : "PENDING");
  if (args.trackingId !== undefined && args.trackingId !== args.consignmentNo) throw new LogisticsTaskError("Tracking ID does not match the assigned shipment.", 400);

  let nextStatus: string | null = null;
  let event: { type: string; status: string; notes: string | null; hubId: string | null } | null = null;
  if (args.action === "accept" && status === "PENDING") nextStatus = "ACCEPTED";
  else if (args.action === "start" && status === "ACCEPTED") {
    if (args.taskType === "PICKUP" && latest && latest.eventType !== "BOOKED") throw new LogisticsTaskError("Pickup can start only before operational pickup has begun.", 409);
    if (args.taskType === "DELIVERY" && (latest?.eventType !== "RECEIVED_AT_DESTINATION_HUB" || latest.hubId !== hubId)) throw new LogisticsTaskError("Delivery work can start only after destination hub physical receipt is recorded.", 409);
    nextStatus = "IN_PROGRESS";
  } else if (args.action === "pickup" && args.taskType === "PICKUP" && status === "IN_PROGRESS") {
    if (latest && latest.eventType !== "BOOKED") throw new LogisticsTaskError("Shipment is no longer eligible for pickup.", 409);
    if (!args.trackingId) throw new LogisticsTaskError("Enter the exact tracking ID to confirm physical pickup.", 400);
    const [payAtPickup] = await connection.execute<RowDataPacket[]>(
      `SELECT r.payment_status AS paymentStatus,r.collection_method AS collectionMethod FROM customer_booking_requests r
        WHERE r.consignment_no=? AND r.status='APPROVED' LIMIT 1 FOR UPDATE`, [args.consignmentNo],
    );
    if (payAtPickup[0]?.collectionMethod === "PAY_AT_PICKUP" && payAtPickup[0]?.paymentStatus !== "COLLECTED") throw new LogisticsTaskError("Record the sender's shipping charge collection before confirming pickup.", 409);
    event = { type: "PICKED_UP", status: "COMPLETED", notes: null, hubId: null };
  } else if (args.action === "handover" && args.taskType === "PICKUP" && status === "IN_PROGRESS") {
    if (latest?.eventType !== "PICKED_UP") throw new LogisticsTaskError("Record physical pickup before hub handover.", 409);
    if (hubId !== shipment.originHubId) throw new LogisticsTaskError("Pickup handover hub does not match shipment origin.", 409);
    event = { type: "HANDED_OVER_AT_ORIGIN_HUB", status: "COMPLETED", notes: null, hubId };
    nextStatus = "COMPLETED";
  } else if (args.action === "out-for-delivery" && args.taskType === "DELIVERY" && status === "IN_PROGRESS") {
    if (latest?.eventType !== "RECEIVED_AT_DESTINATION_HUB" || latest.hubId !== hubId) throw new LogisticsTaskError("Shipment must be physically received at this destination hub before delivery.", 409);
    if (!args.trackingId) throw new LogisticsTaskError("Enter the exact tracking ID to confirm the shipment.", 400);
    event = { type: "OUT_FOR_DELIVERY", status: "IN_PROGRESS", notes: null, hubId };
  } else if (args.action === "deliver" && args.taskType === "DELIVERY" && status === "IN_PROGRESS") {
    if (latest?.eventType !== "OUT_FOR_DELIVERY" || latest.hubId !== hubId) throw new LogisticsTaskError("Record out-for-delivery before confirming delivery.", 409);
    if (!args.trackingId) throw new LogisticsTaskError("Enter the exact tracking ID to confirm physical delivery.", 400);
    const [dueRows] = await connection.execute<RowDataPacket[]>(
      `SELECT r.payment_status AS paymentStatus,r.collection_method AS collectionMethod,s.cod_amount AS codAmount,ps.cod_enabled AS codEnabled
         FROM customer_booking_requests r JOIN shipments s ON s.company_id=? AND s.consignment_no=r.consignment_no
         LEFT JOIN company_payment_settings ps ON ps.company_id=s.company_id
        WHERE r.consignment_no=? AND r.status='APPROVED' LIMIT 1 FOR UPDATE`, [args.companyId,args.consignmentNo],
    );
    if (dueRows[0]?.collectionMethod === "PAY_AT_DELIVERY" && dueRows[0]?.paymentStatus !== "COLLECTED") throw new LogisticsTaskError("Record the receiver's shipping charge before confirming delivery.", 409);
    if (Number(dueRows[0]?.codEnabled) === 1 && Number(dueRows[0]?.codAmount ?? 0) > 0) {
      const [codRows] = await connection.execute<RowDataPacket[]>("SELECT 1 FROM shipment_collections WHERE company_id=? AND consignment_no=? AND collection_method='COD' AND collection_status='COLLECTED' LIMIT 1 FOR UPDATE",[args.companyId,args.consignmentNo]);
      if (!codRows.length) throw new LogisticsTaskError("Record the separate COD goods collection before confirming delivery.", 409);
    }
    event = { type: "DELIVERED", status: "COMPLETED", notes: null, hubId };
    nextStatus = "COMPLETED";
  } else if (args.action === "fail" && ["ACCEPTED", "IN_PROGRESS"].includes(status)) {
    if (!args.reason || args.reason.trim().length < 5 || args.reason.length > 500) throw new LogisticsTaskError("Provide an exception reason of 5 to 500 characters.", 400);
    event = { type: args.taskType === "PICKUP" ? "PICKUP_EXCEPTION" : "DELIVERY_EXCEPTION", status: "FAILED", notes: args.reason.trim(), hubId };
    nextStatus = "FAILED";
  } else throw new LogisticsTaskError("This action is not valid for the task's current state.", 409);

  if (event) {
    await connection.execute<ResultSetHeader>(
      `INSERT INTO shipment_events (consignment_no,event_time,event_type,event_status,hub_id,employee_id,notes)
       VALUES (?,CURRENT_TIMESTAMP(),?,?,?,?,?)`,
      [args.consignmentNo, event.type, event.status, event.hubId, args.employeeId, event.notes],
    );
  }
  if (nextStatus) {
    await connection.execute<ResultSetHeader>(
      `INSERT INTO logistics_task_progress (company_id,consignment_no,task_type,status,failure_reason)
       VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),failure_reason=VALUES(failure_reason),updated_at=CURRENT_TIMESTAMP()`,
      [args.companyId, args.consignmentNo, args.taskType, nextStatus, args.action === "fail" ? args.reason!.trim() : null],
    );
  }
  return { taskKey: `${args.taskType}:${args.consignmentNo}`, taskType: args.taskType, consignmentNo: args.consignmentNo, status: nextStatus ?? status, eventType: event?.type ?? null, hubId };
}

export async function recordExecutiveCollection(connection: PoolConnection, args: {
  companyId:number;employeeId:string;taskType:TaskType;consignmentNo:string;kind:"SHIPPING"|"COD";channel:"DEMO_CASH"|"DEMO_UPI";idempotencyKey:string;
}) {
  if(!config.demoPaymentsEnabled) throw new LogisticsTaskError("Demo collections are disabled in this environment.",403);
  const prefix=args.taskType==="PICKUP"?"origin":"destination";
  const [rows]=await connection.execute<RowDataPacket[]>(
    `SELECT s.origin_hub_id AS originHubId,s.destination_hub_id AS destinationHubId,s.cod_amount AS codAmount,
            r.booking_request_id AS bookingRequestId,r.collection_method AS collectionMethod,r.payment_status AS paymentStatus,
            COALESCE(p.amount,s.total_amount) AS shippingAmount,ps.cod_enabled AS codEnabled
       FROM shipments s JOIN customer_booking_requests r ON r.consignment_no=s.consignment_no AND r.status='APPROVED'
       LEFT JOIN shipment_payments p ON p.company_id=s.company_id AND p.booking_request_id=r.booking_request_id
       LEFT JOIN company_payment_settings ps ON ps.company_id=s.company_id
      WHERE s.company_id=? AND s.consignment_no=? AND (s.${prefix}_logistics_executive_1_id=? OR s.${prefix}_logistics_executive_2_id=?)
      LIMIT 2 FOR UPDATE`,
    [args.companyId,args.consignmentNo,args.employeeId,args.employeeId],
  );
  if(rows.length!==1) throw new LogisticsTaskError("Assigned task payment was not found for this company and executive.",404);
  const row=rows[0]!;
  const hubId=String(args.taskType==="PICKUP"?row.originHubId:row.destinationHubId);
  const [assignedHub]=await connection.execute<RowDataPacket[]>(
    `SELECT 1 FROM employee_hubs eh JOIN employees e ON e.employee_id=eh.employee_id AND e.company_id=? AND UPPER(e.role)='LOGISTICS_EXECUTIVE' AND UPPER(e.status)='ACTIVE'
       JOIN hubs h ON h.hub_id=eh.hub_id AND h.company_id=e.company_id AND UPPER(h.status)='ACTIVE'
      WHERE eh.employee_id=? AND eh.hub_id=? AND UPPER(eh.status)='ACTIVE' LIMIT 1`,[args.companyId,args.employeeId,hubId]);
  if(!assignedHub.length) throw new LogisticsTaskError("Your active assignment to this task hub is required.",403);
  const [prior]=await connection.execute<RowDataPacket[]>("SELECT collection_id AS collectionId,consignment_no AS consignmentNo,amount,collection_method AS collectionMethod,collection_channel AS collectionChannel,recorded_at AS recordedAt FROM shipment_collections WHERE company_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE",[args.companyId,args.idempotencyKey]);
  if(prior[0]) { if(prior[0].consignmentNo!==args.consignmentNo) throw new LogisticsTaskError("Collection idempotency key belongs to another shipment.",409); return {...prior[0],duplicate:true}; }
  const collectionMethod=args.kind==="COD"?"COD":row.collectionMethod;
  if(args.kind==="COD") {
    if(args.taskType!=="DELIVERY"||Number(row.codEnabled)!==1||Number(row.codAmount??0)<=0) throw new LogisticsTaskError("COD collection is unavailable for this assigned delivery task.",409);
  } else {
    const expected=args.taskType==="PICKUP"?"PAY_AT_PICKUP":"PAY_AT_DELIVERY";
    if(row.collectionMethod!==expected) throw new LogisticsTaskError("The shipping charge is not due for collection on this task.",409);
    if(row.paymentStatus!=="COLLECTION_DUE") throw new LogisticsTaskError("Shipping charge is not pending collection.",409);
  }
  const [taskStates]=await connection.execute<RowDataPacket[]>("SELECT status FROM logistics_task_progress WHERE company_id=? AND consignment_no=? AND task_type=? FOR UPDATE",[args.companyId,args.consignmentNo,args.taskType]);
  if(!["ACCEPTED","IN_PROGRESS"].includes(String(taskStates[0]?.status))) throw new LogisticsTaskError("Accept the assigned task before recording a collection.",409);
  const [latestRows]=await connection.execute<RowDataPacket[]>("SELECT event_type AS eventType,hub_id AS hubId FROM shipment_events WHERE consignment_no=? ORDER BY event_time DESC,event_id DESC LIMIT 1 FOR UPDATE",[args.consignmentNo]);
  const latest=latestRows[0];
  if(args.kind==="SHIPPING"&&args.taskType==="PICKUP"&&latest?.eventType!=="BOOKED") throw new LogisticsTaskError("Pickup collection must be recorded before physical pickup.",409);
  if((args.kind==="COD"||args.taskType==="DELIVERY")&&(latest?.eventType!=="OUT_FOR_DELIVERY"||latest.hubId!==hubId)) throw new LogisticsTaskError("Delivery collections require an active out-for-delivery task at the assigned hub.",409);
  const amount=Number(args.kind==="COD"?row.codAmount:row.shippingAmount);
  if(!Number.isFinite(amount)||amount<=0) throw new LogisticsTaskError("A positive amount due was not found.",409);
  const [already]=await connection.execute<RowDataPacket[]>("SELECT 1 FROM shipment_collections WHERE company_id=? AND consignment_no=? AND collection_method=? AND collection_status='COLLECTED' LIMIT 1 FOR UPDATE",[args.companyId,args.consignmentNo,collectionMethod]);
  if(already.length) throw new LogisticsTaskError("This amount has already been collected.",409);
  await connection.execute(`INSERT INTO shipment_collections (company_id,consignment_no,task_type,amount,collection_method,collection_channel,recorded_by_employee_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?)`,[args.companyId,args.consignmentNo,args.taskType,amount,collectionMethod,args.channel,args.employeeId,args.idempotencyKey]);
  if(args.kind==="SHIPPING") {
    await connection.execute("UPDATE shipment_payments SET payment_status='COLLECTED',completed_at=CURRENT_TIMESTAMP() WHERE company_id=? AND booking_request_id=? AND payment_status='COLLECTION_DUE'",[args.companyId,row.bookingRequestId]);
    await connection.execute("UPDATE customer_booking_requests SET payment_status='COLLECTED' WHERE booking_request_id=? AND status='APPROVED'",[row.bookingRequestId]);
  }
  return {consignmentNo:args.consignmentNo,kind:args.kind,amount,currency:"INR",collectionMethod,collectionChannel:args.channel,status:"COLLECTED",demo:true};
}

export function parseTaskAction(value: string): Action | null {
  return ["accept", "start", "pickup", "handover", "out-for-delivery", "deliver", "fail"].includes(value) ? value as Action : null;
}

export function parseTaskType(value: string): TaskType | null {
  return value === "PICKUP" || value === "DELIVERY" ? value : null;
}
