import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { Pool, PoolConnection } from "mysql2/promise";

type Executor = Pick<Pool | PoolConnection, "execute">;

export class TransportError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409) {
    super(message);
    this.name = "TransportError";
  }
}

async function requireHub(executor: Executor, companyId: number, employeeId: string, hubId: string) {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT 1 FROM employee_hubs eh JOIN employees e ON e.employee_id=eh.employee_id
      JOIN hubs h ON h.hub_id=eh.hub_id AND h.company_id=e.company_id
     WHERE e.company_id=? AND e.employee_id=? AND UPPER(e.role)='HUB_MANAGER'
       AND UPPER(e.status)='ACTIVE' AND eh.hub_id=? AND UPPER(eh.status)='ACTIVE'
       AND UPPER(h.status)='ACTIVE' LIMIT 1`,
    [companyId, employeeId, hubId],
  );
  if (!rows.length) throw new TransportError("You are not authorized to manage this hub.", 403);
}

async function latestShipmentEvent(executor: Executor, companyId: number, consignmentNo: string) {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT se.event_type AS eventType,se.hub_id AS hubId FROM shipment_events se
      WHERE se.consignment_no=? AND EXISTS (SELECT 1 FROM shipments s WHERE s.company_id=? AND s.consignment_no=se.consignment_no)
        AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=se.consignment_no)=1
      ORDER BY se.event_time DESC,se.event_id DESC LIMIT 1`,
    [consignmentNo, companyId],
  );
  return rows[0] ?? null;
}

type RouteRow = RowDataPacket & { originHubId: string; destinationHubId: string; destinationCity: string };
type RouteGraph = { nextHubs: Map<string, Array<{ hubId: string; city: string }>>; edges: Map<string, Set<string>> };

async function activeRouteGraph(executor: Executor, companyId: number): Promise<RouteGraph> {
  const [routes] = await executor.execute<RouteRow[]>(
    `SELECT r.origin_hub_id AS originHubId,r.destination_hub_id AS destinationHubId,d.city AS destinationCity
       FROM routes r
       JOIN hubs o ON o.company_id=r.company_id AND o.hub_id=r.origin_hub_id AND UPPER(o.status)='ACTIVE'
       JOIN hubs d ON d.company_id=r.company_id AND d.hub_id=r.destination_hub_id AND UPPER(d.status)='ACTIVE'
      WHERE r.company_id=? AND UPPER(COALESCE(r.status,'ACTIVE'))='ACTIVE'`,
    [companyId],
  );
  const nextHubs = new Map<string, Array<{ hubId: string; city: string }>>();
  const edges = new Map<string, Set<string>>();
  for (const route of routes) {
    const originHubId = String(route.originHubId);
    const destinationHubId = String(route.destinationHubId);
    const next = nextHubs.get(originHubId) ?? [];
    if (!next.some((item) => item.hubId === destinationHubId)) next.push({ hubId: destinationHubId, city: String(route.destinationCity) });
    nextHubs.set(originHubId, next);
    const destinations = edges.get(originHubId) ?? new Set<string>();
    destinations.add(destinationHubId);
    edges.set(originHubId, destinations);
  }
  return { nextHubs, edges };
}

function routeCanReach(graph: RouteGraph, fromHubId: string, finalHubId: string): boolean {
  if (fromHubId === finalHubId) return true;
  const visited = new Set([fromHubId]);
  const pending = [fromHubId];
  while (pending.length) {
    const hubId = pending.shift()!;
    for (const next of graph.edges.get(hubId) ?? []) {
      if (next === finalHubId) return true;
      if (!visited.has(next)) { visited.add(next); pending.push(next); }
    }
  }
  return false;
}

export async function listTransportTrips(executor: Executor, companyId: number, employeeId: string) {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT t.trip_id AS tripId,t.origin_hub_id AS originHubId,oh.city AS originCity,
            t.destination_hub_id AS destinationHubId,dh.city AS destinationCity,
            t.vehicle_number AS vehicleNumber,t.driver_name AS driverName,t.driver_phone AS driverPhone,
            t.status,t.scheduled_departure AS scheduledDeparture,t.actual_departure AS actualDeparture,
            t.actual_arrival AS actualArrival,t.created_at AS createdAt,
            COUNT(m.consignment_no) AS shipmentCount,
            SUM(m.loading_status='PENDING') AS pendingCount,
            SUM(m.loading_status='LOADED') AS loadedCount,
            SUM(m.loading_status='RECEIVED') AS receivedCount,
            SUM(m.loading_status IN ('MISSING','DAMAGED')) AS exceptionCount
       FROM transport_trips t
       JOIN hubs oh ON oh.hub_id=t.origin_hub_id AND oh.company_id=t.company_id
       JOIN hubs dh ON dh.hub_id=t.destination_hub_id AND dh.company_id=t.company_id
       LEFT JOIN transport_trip_shipments m ON m.trip_id=t.trip_id AND m.company_id=t.company_id
      WHERE t.company_id=? AND (
        EXISTS (SELECT 1 FROM employee_hubs eh WHERE eh.employee_id=? AND eh.hub_id=t.origin_hub_id AND UPPER(eh.status)='ACTIVE') OR
        EXISTS (SELECT 1 FROM employee_hubs eh WHERE eh.employee_id=? AND eh.hub_id=t.destination_hub_id AND UPPER(eh.status)='ACTIVE'))
      GROUP BY t.trip_id,oh.city,dh.city
      ORDER BY CASE t.status WHEN 'IN_TRANSIT' THEN 0 WHEN 'ARRIVED' THEN 1 WHEN 'LOADING' THEN 2 WHEN 'READY_TO_DEPART' THEN 3 WHEN 'PLANNED' THEN 4 ELSE 5 END,t.created_at DESC
      `,
    [companyId, employeeId, employeeId],
  );
  const tripIds = rows.map((row) => Number(row.tripId));
  if (!tripIds.length) return { trips: [] };
  const [manifest] = await executor.execute<RowDataPacket[]>(
    `SELECT m.trip_id AS tripId,m.consignment_no AS consignmentNo,m.loading_status AS loadingStatus,
            m.loaded_at AS loadedAt,m.received_at AS receivedAt,m.receiving_condition AS receivingCondition,
            m.exception_reason AS exceptionReason,s.shipment_date AS shipmentDate,s.origin_hub_id AS shipmentOriginHubId,
            s.destination_hub_id AS shipmentDestinationHubId,oh.city AS shipmentOriginCity,dh.city AS shipmentDestinationCity
       FROM transport_trip_shipments m JOIN transport_trips t ON t.trip_id=m.trip_id AND t.company_id=m.company_id
       JOIN shipments s ON s.company_id=m.company_id AND s.consignment_no=m.consignment_no
       LEFT JOIN hubs oh ON oh.hub_id=s.origin_hub_id AND oh.company_id=s.company_id
       LEFT JOIN hubs dh ON dh.hub_id=s.destination_hub_id AND dh.company_id=s.company_id
      WHERE m.company_id=? AND m.trip_id IN (${tripIds.map(() => "?").join(",")})
      ORDER BY m.trip_id,m.consignment_no`,
    [companyId, ...tripIds],
  );
  return { trips: rows.map((row) => ({ ...row, manifest: manifest.filter((item) => Number(item.tripId) === Number(row.tripId)) })) };
}

export async function listEligibleTransportShipments(executor: Executor, companyId: number, employeeId: string, hubId: string) {
  await requireHub(executor, companyId, employeeId, hubId);
  const graph = await activeRouteGraph(executor, companyId);
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo,s.shipment_date AS shipmentDate,s.mode,
            s.destination_hub_id AS finalDestinationHubId,h.city AS finalDestinationCity,latest.event_type AS lastEvent,
            latest.event_time AS lastEventAt,s.recipient_name AS recipientName
       FROM shipments s
       JOIN (SELECT se.consignment_no,se.event_type,se.hub_id,se.event_time,
                    ROW_NUMBER() OVER (PARTITION BY se.consignment_no ORDER BY se.event_time DESC,se.event_id DESC) AS rn
               FROM shipment_events se
              WHERE EXISTS (SELECT 1 FROM shipments unique_s WHERE unique_s.company_id=? AND unique_s.consignment_no=se.consignment_no)
                AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=se.consignment_no)=1) latest
         ON latest.consignment_no=s.consignment_no AND latest.rn=1
       JOIN hubs h ON h.company_id=s.company_id AND h.hub_id=s.destination_hub_id
      WHERE s.company_id=? AND latest.hub_id=? AND s.destination_hub_id<>?
        AND latest.event_type IN ('RECEIVED_AT_ORIGIN_HUB','RECEIVED_AT_HUB','RECEIVED_AT_DESTINATION_HUB')
        AND LOWER(COALESCE(s.delivery_status,'')) NOT IN ('delivered','completed','on time','delayed')
        AND NOT EXISTS (SELECT 1 FROM transport_trip_shipments m JOIN transport_trips t ON t.trip_id=m.trip_id AND t.company_id=m.company_id
          WHERE m.company_id=s.company_id AND m.consignment_no=s.consignment_no AND t.status IN ('PLANNED','LOADING','READY_TO_DEPART','IN_TRANSIT','ARRIVED'))
      ORDER BY s.shipment_date,s.consignment_no`,
    [companyId, companyId, hubId, hubId],
  );
  return rows.flatMap((shipment) => (graph.nextHubs.get(hubId) ?? [])
    .filter((next) => next.hubId !== hubId && routeCanReach(graph, next.hubId, String(shipment.finalDestinationHubId)))
    .map((next) => ({ ...shipment, destinationHubId: next.hubId, destinationCity: next.city })));
}

export async function createTransportTrip(connection: PoolConnection, args: {
  companyId: number; employeeId: string; originHubId: string; destinationHubId: string;
  vehicleNumber: string; driverName: string; driverPhone?: string; scheduledDeparture?: string;
  remarks?: string; consignmentNos: string[];
}) {
  await requireHub(connection, args.companyId, args.employeeId, args.originHubId);
  if (args.originHubId === args.destinationHubId) throw new TransportError("Trip origin and destination must be different hubs.", 400);
  if (!args.consignmentNos.length || args.consignmentNos.length > 30 || new Set(args.consignmentNos).size !== args.consignmentNos.length) {
    throw new TransportError("Add between 1 and 30 unique shipments to the manifest. Create multiple loads for larger batches.", 400);
  }
  const [destinations] = await connection.execute<RowDataPacket[]>(
    "SELECT 1 FROM hubs WHERE company_id=? AND hub_id=? AND UPPER(status)='ACTIVE' LIMIT 1",
    [args.companyId, args.destinationHubId],
  );
  if (!destinations.length) throw new TransportError("Destination hub is not active in your company.", 403);
  const graph = await activeRouteGraph(connection, args.companyId);
  if (!(graph.edges.get(args.originHubId)?.has(args.destinationHubId))) throw new TransportError("No active company route connects these hubs.", 409);

  const shipments: Array<{ consignmentNo: string; eventType: string }> = [];
  for (const consignmentNo of args.consignmentNos) {
    const [shipmentRows] = await connection.execute<RowDataPacket[]>(
      "SELECT consignment_no AS consignmentNo,origin_hub_id AS originHubId,destination_hub_id AS destinationHubId,delivery_status AS deliveryStatus FROM shipments WHERE company_id=? AND consignment_no=? LIMIT 2 FOR UPDATE",
      [args.companyId, consignmentNo],
    );
    if (shipmentRows.length !== 1) throw new TransportError("A manifest shipment was not found uniquely in your company.", 404);
    const shipment = shipmentRows[0]!;
    if (!routeCanReach(graph, args.destinationHubId, String(shipment.destinationHubId))) throw new TransportError("The selected next hub is not on an active route to this shipment's final destination.", 409);
    const latest = await latestShipmentEvent(connection, args.companyId, consignmentNo);
    if (String(shipment.deliveryStatus ?? "").toLowerCase().match(/^(delivered|completed|on time|delayed)$/)) {
      throw new TransportError("A shipment with a recorded final outcome cannot be placed on a trip.", 409);
    }
    if (latest?.hubId !== args.originHubId || !["RECEIVED_AT_ORIGIN_HUB", "RECEIVED_AT_HUB"].includes(String(latest?.eventType))) {
      throw new TransportError("Each shipment must have a persisted physical receipt at this trip's origin hub.", 409);
    }
    const [active] = await connection.execute<RowDataPacket[]>(
      `SELECT 1 FROM transport_trip_shipments m JOIN transport_trips t ON t.trip_id=m.trip_id AND t.company_id=m.company_id
        WHERE m.company_id=? AND m.consignment_no=? AND t.status IN ('PLANNED','LOADING','READY_TO_DEPART','IN_TRANSIT','ARRIVED') LIMIT 1 FOR UPDATE`,
      [args.companyId, consignmentNo],
    );
    if (active.length) throw new TransportError("Shipment is already assigned to an active transport trip.", 409);
    shipments.push({ consignmentNo, eventType: String(latest.eventType) });
  }
  const [created] = await connection.execute<ResultSetHeader>(
    `INSERT INTO transport_trips (company_id,origin_hub_id,destination_hub_id,vehicle_number,driver_name,driver_phone,status,scheduled_departure,created_by_employee_id)
     VALUES (?,?,?,?,?,?,'PLANNED',?,?)`,
    [args.companyId, args.originHubId, args.destinationHubId, args.vehicleNumber, args.driverName, args.driverPhone ?? null, args.scheduledDeparture ? new Date(args.scheduledDeparture).toISOString().slice(0, 19).replace("T", " ") : null, args.employeeId],
  );
  const tripId = Number(created.insertId);
  await connection.execute(
    `INSERT INTO transport_trip_events (trip_id,company_id,event_type,hub_id,recorded_by_employee_id,notes) VALUES (?,?,'CREATED',?,?,?)`,
    [tripId, args.companyId, args.originHubId, args.employeeId, [args.remarks?.trim(), `Manifest contains ${shipments.length} shipment(s).`].filter(Boolean).join(" · ")],
  );
  for (const shipment of shipments) {
    await connection.execute(
      "INSERT INTO transport_trip_shipments (trip_id,company_id,consignment_no,loading_status) VALUES (?,?,?,'PENDING')",
      [tripId, args.companyId, shipment.consignmentNo],
    );
    await connection.execute(
      `INSERT INTO transport_trip_events (trip_id,company_id,event_type,consignment_no,hub_id,recorded_by_employee_id)
       VALUES (?,?,'SHIPMENT_ADDED',?,?,?)`,
      [tripId, args.companyId, shipment.consignmentNo, args.originHubId, args.employeeId],
    );
    await connection.execute(
      `INSERT INTO shipment_events (consignment_no,event_time,event_type,event_status,hub_id,employee_id,notes)
       VALUES (?,CURRENT_TIMESTAMP(),'ASSIGNED_TO_TRANSPORT','PLANNED',?,?,?)`,
      [shipment.consignmentNo, args.originHubId, args.employeeId, `Trip ${tripId} to ${args.destinationHubId}`],
    );
  }
  return { tripId, status: "PLANNED", shipmentCount: shipments.length, consignmentNos: shipments.map((shipment) => shipment.consignmentNo) };
}

async function getTripForHub(connection: PoolConnection, companyId: number, employeeId: string, tripId: number, action: "origin" | "destination") {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT t.* FROM transport_trips t WHERE t.company_id=? AND t.trip_id=? FOR UPDATE`,
    [companyId, tripId],
  );
  const trip = rows[0];
  if (!trip) throw new TransportError("Transport trip was not found in your company.", 404);
  const hubId = String(action === "origin" ? trip.origin_hub_id : trip.destination_hub_id);
  await requireHub(connection, companyId, employeeId, hubId);
  return trip;
}

export async function markTransportShipmentLoaded(connection: PoolConnection, args: { companyId: number; employeeId: string; tripId: number; consignmentNo: string }) {
  const trip = await getTripForHub(connection, args.companyId, args.employeeId, args.tripId, "origin");
  if (!["PLANNED", "LOADING"].includes(String(trip.status))) throw new TransportError("This trip is no longer accepting loads.", 409);
  const latest = await latestShipmentEvent(connection, args.companyId, args.consignmentNo);
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT loading_status AS loadingStatus FROM transport_trip_shipments WHERE company_id=? AND trip_id=? AND consignment_no=? FOR UPDATE",
    [args.companyId, args.tripId, args.consignmentNo],
  );
  if (!rows.length) throw new TransportError("Shipment is not on this trip manifest.", 404);
  if (rows[0]!.loadingStatus !== "PENDING") throw new TransportError("Shipment has already been loaded or reconciled.", 409);
  if (latest?.hubId !== trip.origin_hub_id || !["RECEIVED_AT_ORIGIN_HUB", "RECEIVED_AT_HUB", "ASSIGNED_TO_TRANSPORT"].includes(String(latest?.eventType))) {
    throw new TransportError("Shipment is not physically available at this origin hub.", 409);
  }
  await connection.execute("UPDATE transport_trip_shipments SET loading_status='LOADED',loaded_at=CURRENT_TIMESTAMP() WHERE trip_id=? AND company_id=? AND consignment_no=? AND loading_status='PENDING'", [args.tripId, args.companyId, args.consignmentNo]);
  await connection.execute("UPDATE transport_trips SET status='LOADING' WHERE trip_id=? AND company_id=? AND status='PLANNED'", [args.tripId, args.companyId]);
  await connection.execute("INSERT INTO shipment_events (consignment_no,event_time,event_type,event_status,hub_id,employee_id,notes) VALUES (?,CURRENT_TIMESTAMP(),'LOADED_ON_TRANSPORT','LOADED',?,?,?)", [args.consignmentNo, trip.origin_hub_id, args.employeeId, `Trip ${args.tripId}`]);
  await connection.execute("INSERT INTO transport_trip_events (trip_id,company_id,event_type,consignment_no,hub_id,recorded_by_employee_id) VALUES (?,?,'SHIPMENT_LOADED',?,?,?)", [args.tripId, args.companyId, args.consignmentNo, trip.origin_hub_id, args.employeeId]);
  const [remaining] = await connection.execute<RowDataPacket[]>("SELECT COUNT(*) AS pending FROM transport_trip_shipments WHERE trip_id=? AND company_id=? AND loading_status='PENDING'", [args.tripId, args.companyId]);
  if (Number(remaining[0]?.pending ?? 0) === 0) await connection.execute("UPDATE transport_trips SET status='READY_TO_DEPART' WHERE trip_id=? AND company_id=? AND status IN ('PLANNED','LOADING')", [args.tripId, args.companyId]);
  return { tripId: args.tripId, consignmentNo: args.consignmentNo, consignmentNos: [args.consignmentNo], loadingStatus: "LOADED", readyToDepart: Number(remaining[0]?.pending ?? 0) === 0 };
}

export async function dispatchTransportTrip(connection: PoolConnection, args: { companyId: number; employeeId: string; tripId: number }) {
  const trip = await getTripForHub(connection, args.companyId, args.employeeId, args.tripId, "origin");
  if (trip.status !== "READY_TO_DEPART") throw new TransportError("Every manifest shipment must be loaded before dispatch.", 409);
  const graph = await activeRouteGraph(connection, args.companyId);
  if (!graph.edges.get(String(trip.origin_hub_id))?.has(String(trip.destination_hub_id))) throw new TransportError("This trip no longer has an active route between its hubs.", 409);
  const [manifest] = await connection.execute<RowDataPacket[]>("SELECT m.consignment_no AS consignmentNo,s.destination_hub_id AS finalDestinationHubId FROM transport_trip_shipments m JOIN shipments s ON s.company_id=m.company_id AND s.consignment_no=m.consignment_no WHERE m.company_id=? AND m.trip_id=? AND m.loading_status='LOADED' FOR UPDATE", [args.companyId, args.tripId]);
  if (!manifest.length) throw new TransportError("An empty trip cannot be dispatched.", 409);
  for (const item of manifest) {
    if (!routeCanReach(graph, String(trip.destination_hub_id), String(item.finalDestinationHubId))) throw new TransportError("The trip destination is no longer on an active route to a manifest shipment's final destination.", 409);
    const latest = await latestShipmentEvent(connection, args.companyId, String(item.consignmentNo));
    if (latest?.hubId !== trip.origin_hub_id || latest?.eventType !== "LOADED_ON_TRANSPORT") throw new TransportError("A manifest shipment is not confirmed loaded at this trip's origin.", 409);
  }
  await connection.execute("UPDATE transport_trips SET status='IN_TRANSIT',actual_departure=CURRENT_TIMESTAMP() WHERE company_id=? AND trip_id=? AND status='READY_TO_DEPART'", [args.companyId, args.tripId]);
  await connection.execute("INSERT INTO transport_trip_events (trip_id,company_id,event_type,hub_id,recorded_by_employee_id) VALUES (?,?,'DEPARTED',?,?)", [args.tripId, args.companyId, trip.origin_hub_id, args.employeeId]);
  for (const item of manifest) {
    await connection.execute("INSERT INTO shipment_events (consignment_no,event_time,event_type,event_status,hub_id,employee_id,notes) VALUES (?,CURRENT_TIMESTAMP(),'DISPATCHED','IN_TRANSIT',?,?,?)", [item.consignmentNo, trip.origin_hub_id, args.employeeId, `Trip ${args.tripId} to hub ${trip.destination_hub_id}`]);
  }
  return { tripId: args.tripId, status: "IN_TRANSIT", actualDeparture: new Date().toISOString(), shipmentCount: manifest.length, consignmentNos: manifest.map((item) => String(item.consignmentNo)) };
}

export async function arriveTransportTrip(connection: PoolConnection, args: { companyId: number; employeeId: string; tripId: number }) {
  const trip = await getTripForHub(connection, args.companyId, args.employeeId, args.tripId, "destination");
  if (trip.status !== "IN_TRANSIT") throw new TransportError("Only an in-transit trip can confirm arrival.", 409);
  await connection.execute("UPDATE transport_trips SET status='ARRIVED',actual_arrival=CURRENT_TIMESTAMP() WHERE company_id=? AND trip_id=? AND status='IN_TRANSIT'", [args.companyId, args.tripId]);
  await connection.execute("INSERT INTO transport_trip_events (trip_id,company_id,event_type,hub_id,recorded_by_employee_id) VALUES (?,?,'ARRIVED',?,?)", [args.tripId, args.companyId, trip.destination_hub_id, args.employeeId]);
  const [manifest] = await connection.execute<RowDataPacket[]>("SELECT consignment_no AS consignmentNo FROM transport_trip_shipments WHERE company_id=? AND trip_id=? AND loading_status='LOADED'", [args.companyId, args.tripId]);
  for (const item of manifest) {
    const [shipmentRows] = await connection.execute<RowDataPacket[]>("SELECT destination_hub_id AS destinationHubId FROM shipments WHERE company_id=? AND consignment_no=? LIMIT 1", [args.companyId, item.consignmentNo]);
    const atFinalDestination = shipmentRows[0]?.destinationHubId === trip.destination_hub_id;
    const eventType = atFinalDestination ? "ARRIVED_AT_DESTINATION_HUB" : "ARRIVED_AT_HUB";
    await connection.execute("INSERT INTO shipment_events (consignment_no,event_time,event_type,event_status,hub_id,employee_id,notes) VALUES (?,CURRENT_TIMESTAMP(),?,'ARRIVED',?,?,?)", [item.consignmentNo, eventType, trip.destination_hub_id, args.employeeId, `Trip ${args.tripId}; physical receipt must be confirmed per shipment`]);
  }
  return { tripId: args.tripId, status: "ARRIVED", shipmentCount: manifest.length, physicalReceiptRequired: true, consignmentNos: manifest.map((item) => String(item.consignmentNo)) };
}

export async function reconcileTransportShipment(connection: PoolConnection, args: { companyId: number; employeeId: string; tripId: number; consignmentNo: string; condition: "RECEIVED" | "MISSING" | "DAMAGED"; reason?: string }) {
  const trip = await getTripForHub(connection, args.companyId, args.employeeId, args.tripId, "destination");
  if (trip.status !== "ARRIVED") throw new TransportError("Confirm trip arrival before reconciling packages.", 409);
  if (["MISSING", "DAMAGED"].includes(args.condition) && (!args.reason || args.reason.trim().length < 5 || args.reason.length > 500)) throw new TransportError("Provide an exception reason of 5 to 500 characters.", 400);
  const [rows] = await connection.execute<RowDataPacket[]>("SELECT loading_status AS loadingStatus FROM transport_trip_shipments WHERE company_id=? AND trip_id=? AND consignment_no=? FOR UPDATE", [args.companyId, args.tripId, args.consignmentNo]);
  if (!rows.length) throw new TransportError("Shipment is not on this trip manifest.", 404);
  if (rows[0]!.loadingStatus !== "LOADED") throw new TransportError("This package has already been reconciled.", 409);
  const [shipmentRows] = await connection.execute<RowDataPacket[]>("SELECT destination_hub_id AS destinationHubId FROM shipments WHERE company_id=? AND consignment_no=? LIMIT 1 FOR UPDATE", [args.companyId, args.consignmentNo]);
  if (!shipmentRows.length) throw new TransportError("Shipment is not in your company.", 404);
  const finalDestination = shipmentRows[0]!.destinationHubId === trip.destination_hub_id;
  const condition = args.condition === "RECEIVED" ? "GOOD" : args.condition;
  const manifestState = args.condition === "RECEIVED" ? "RECEIVED" : args.condition;
  await connection.execute("UPDATE transport_trip_shipments SET loading_status=?,received_at=IF(?='RECEIVED',CURRENT_TIMESTAMP(),NULL),receiving_condition=?,exception_reason=? WHERE company_id=? AND trip_id=? AND consignment_no=? AND loading_status='LOADED'", [manifestState, args.condition, condition, args.reason?.trim() ?? null, args.companyId, args.tripId, args.consignmentNo]);
  const eventType = args.condition === "RECEIVED" ? (finalDestination ? "RECEIVED_AT_DESTINATION_HUB" : "RECEIVED_AT_HUB") : `TRANSPORT_${args.condition}_EXCEPTION`;
  await connection.execute("INSERT INTO shipment_events (consignment_no,event_time,event_type,event_status,hub_id,employee_id,notes) VALUES (?,CURRENT_TIMESTAMP(),?,?,?, ?,?)", [args.consignmentNo, eventType, args.condition, trip.destination_hub_id, args.employeeId, args.reason?.trim() ?? `Trip ${args.tripId}`]);
  const tripEvent = args.condition === "RECEIVED" ? "SHIPMENT_RECEIVED" : args.condition === "MISSING" ? "SHIPMENT_MISSING" : "SHIPMENT_DAMAGED";
  await connection.execute("INSERT INTO transport_trip_events (trip_id,company_id,event_type,consignment_no,hub_id,recorded_by_employee_id,notes) VALUES (?,?,?,?,?,?,?)", [args.tripId, args.companyId, tripEvent, args.consignmentNo, trip.destination_hub_id, args.employeeId, args.reason?.trim() ?? null]);
  const [remaining] = await connection.execute<RowDataPacket[]>("SELECT COUNT(*) AS pending FROM transport_trip_shipments WHERE company_id=? AND trip_id=? AND loading_status IN ('PENDING','LOADED')", [args.companyId, args.tripId]);
  const closed = Number(remaining[0]?.pending ?? 0) === 0;
  if (closed) {
    await connection.execute("UPDATE transport_trips SET status='CLOSED' WHERE company_id=? AND trip_id=? AND status='ARRIVED'", [args.companyId, args.tripId]);
    await connection.execute("INSERT INTO transport_trip_events (trip_id,company_id,event_type,hub_id,recorded_by_employee_id) VALUES (?,?,'CLOSED',?,?)", [args.tripId, args.companyId, trip.destination_hub_id, args.employeeId]);
  }
  return { tripId: args.tripId, consignmentNo: args.consignmentNo, consignmentNos: [args.consignmentNo], condition: args.condition, eventType, tripClosed: closed };
}

export async function resolveTransportException(connection: PoolConnection, args: { companyId: number; employeeId: string; tripId: number; consignmentNo: string; reason: string }) {
  const trip = await getTripForHub(connection, args.companyId, args.employeeId, args.tripId, "destination");
  if (!["ARRIVED", "CLOSED"].includes(String(trip.status))) throw new TransportError("A transport exception can be resolved only after the vehicle has arrived.", 409);
  if (args.reason.trim().length < 5 || args.reason.length > 500) throw new TransportError("Explain how the missing or damaged shipment was resolved (5 to 500 characters).", 400);
  const [manifest] = await connection.execute<RowDataPacket[]>(
    "SELECT loading_status AS loadingStatus FROM transport_trip_shipments WHERE company_id=? AND trip_id=? AND consignment_no=? FOR UPDATE",
    [args.companyId, args.tripId, args.consignmentNo],
  );
  if (!manifest[0] || !["MISSING", "DAMAGED"].includes(String(manifest[0].loadingStatus))) throw new TransportError("This manifest item has no unresolved missing or damaged exception.", 409);
  const latest = await latestShipmentEvent(connection, args.companyId, args.consignmentNo);
  if (latest?.hubId !== trip.destination_hub_id || !["TRANSPORT_MISSING_EXCEPTION", "TRANSPORT_DAMAGED_EXCEPTION"].includes(String(latest?.eventType))) {
    throw new TransportError("The shipment's latest event is not a resolvable transport exception at this hub.", 409);
  }
  const [shipmentRows] = await connection.execute<RowDataPacket[]>(
    "SELECT destination_hub_id AS destinationHubId FROM shipments WHERE company_id=? AND consignment_no=? FOR UPDATE",
    [args.companyId, args.consignmentNo],
  );
  if (!shipmentRows[0]) throw new TransportError("Shipment is not in your company.", 404);
  const atFinalDestination = String(shipmentRows[0].destinationHubId) === String(trip.destination_hub_id);
  const receiptType = atFinalDestination ? "RECEIVED_AT_DESTINATION_HUB" : "RECEIVED_AT_HUB";
  await connection.execute(
    "UPDATE transport_trip_shipments SET loading_status='RECEIVED',received_at=CURRENT_TIMESTAMP(),receiving_condition='GOOD' WHERE company_id=? AND trip_id=? AND consignment_no=? AND loading_status IN ('MISSING','DAMAGED')",
    [args.companyId, args.tripId, args.consignmentNo],
  );
  await connection.execute(
    "INSERT INTO shipment_events (consignment_no,event_time,event_type,event_status,hub_id,employee_id,notes) VALUES (?,CURRENT_TIMESTAMP(),?,'RECEIVED',?,?,?)",
    [args.consignmentNo, receiptType, trip.destination_hub_id, args.employeeId, `Transport exception resolved at trip ${args.tripId}: ${args.reason.trim()}`],
  );
  await connection.execute(
    "INSERT INTO transport_trip_events (trip_id,company_id,event_type,consignment_no,hub_id,recorded_by_employee_id,notes) VALUES (?,?,'SHIPMENT_RECEIVED',?,?,?,?)",
    [args.tripId, args.companyId, args.consignmentNo, trip.destination_hub_id, args.employeeId, `Exception resolved: ${args.reason.trim()}`],
  );
  return { tripId: args.tripId, consignmentNo: args.consignmentNo, status: "RECEIVED", eventType: receiptType };
}
