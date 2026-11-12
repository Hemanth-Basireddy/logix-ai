import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Executor = Pick<Pool | PoolConnection, "execute">;

const currentEventSql = `(SELECT NULLIF(se.event_type,'') FROM shipment_events se
  WHERE se.consignment_no=s.consignment_no
    AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=se.consignment_no)=1
  ORDER BY se.event_time DESC,se.event_id DESC LIMIT 1)`;

const personalShipmentScope = `
  SELECT s.consignment_no,s.shipment_date,s.origin_hub_id,s.destination_hub_id,s.sender_state,s.receiver_state,
    ${currentEventSql} AS current_event
  FROM shipments s WHERE s.company_id=? AND s.customer_id=?`;

const companyShipmentScope = `
  SELECT s.consignment_no,s.customer_id,s.sender_state,s.receiver_state,s.origin_hub_id,s.destination_hub_id,
    ${currentEventSql} AS current_event
  FROM shipments s WHERE s.company_id=?`;

const activeEvents = "'PICKED_UP','ARRIVED_AT_ORIGIN_HUB','RECEIVED_AT_ORIGIN_HUB','ASSIGNED_TO_TRANSPORT','LOADED_ON_TRANSPORT','DISPATCHED','ARRIVED_AT_HUB','RECEIVED_AT_HUB','RECEIVED_AT_DESTINATION_HUB','ARRIVED_AT_DESTINATION_HUB','OUT_FOR_DELIVERY'";

export async function getCustomerDashboardSummary(executor: Executor, companyId: number, customerId: string) {
  const [networkCounts] = await executor.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS total,
      COALESCE(SUM(current_event='DELIVERED'),0) AS delivered,
      COALESCE(SUM(current_event IN (${activeEvents})),0) AS active,
      COUNT(DISTINCT NULLIF(TRIM(customer_id),'')) AS customersServed
    FROM (${companyShipmentScope}) company_shipments`, [companyId],
  );
  const [networkStates] = await executor.execute<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT NULLIF(UPPER(TRIM(state_name)),'')) AS total FROM (
      SELECT sender_state AS state_name FROM shipments WHERE company_id=?
      UNION ALL SELECT receiver_state AS state_name FROM shipments WHERE company_id=?
    ) company_states`, [companyId, companyId],
  );
  const [networkHubs] = await executor.execute<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT NULLIF(TRIM(hub_id),'')) AS total FROM (
      SELECT origin_hub_id AS hub_id FROM shipments WHERE company_id=?
      UNION ALL SELECT destination_hub_id AS hub_id FROM shipments WHERE company_id=?
    ) company_hubs`, [companyId, companyId],
  );
  const [networkRoutes] = await executor.execute<RowDataPacket[]>(
    `SELECT COALESCE(MAX(NULLIF(TRIM(sender_state),'')),'State not recorded') AS origin,
      COALESCE(MAX(NULLIF(TRIM(receiver_state),'')),'State not recorded') AS destination,
      COUNT(*) AS shipments,COALESCE(SUM(current_event='DELIVERED'),0) AS delivered,
      COALESCE(SUM(current_event IN (${activeEvents})),0) AS active
    FROM (${companyShipmentScope}) company_shipments
    GROUP BY COALESCE(NULLIF(UPPER(TRIM(sender_state)),''),'State not recorded'),
      COALESCE(NULLIF(UPPER(TRIM(receiver_state)),''),'State not recorded')
    ORDER BY shipments DESC,origin,destination LIMIT 8`, [companyId],
  );
  const [networkDestinations] = await executor.execute<RowDataPacket[]>(
    `SELECT COALESCE(MAX(NULLIF(TRIM(receiver_state),'')),'State not recorded') AS destination,
      COUNT(*) AS shipments,COALESCE(SUM(current_event='DELIVERED'),0) AS delivered,
      COALESCE(SUM(current_event IN (${activeEvents})),0) AS active
    FROM (${companyShipmentScope}) company_shipments
    GROUP BY COALESCE(NULLIF(UPPER(TRIM(receiver_state)),''),'State not recorded')
    ORDER BY shipments DESC,destination`, [companyId],
  );
  const [networkDestinationHubs] = await executor.execute<RowDataPacket[]>(
    `SELECT COALESCE(MAX(NULLIF(TRIM(s.receiver_state),'')),'State not recorded') AS destination,
      h.hub_id AS hubId,COALESCE(NULLIF(TRIM(h.city),''),'City not recorded') AS city,COUNT(*) AS shipments
    FROM shipments s
    JOIN hubs h ON h.company_id=s.company_id AND h.hub_id=s.destination_hub_id
    WHERE s.company_id=? AND NULLIF(TRIM(s.receiver_state),'') IS NOT NULL
    GROUP BY COALESCE(NULLIF(UPPER(TRIM(s.receiver_state)),''),'State not recorded'),h.hub_id,h.city
    ORDER BY destination,shipments DESC,city`, [companyId],
  );
  const [networkMonthly] = await executor.execute<RowDataPacket[]>(
    `SELECT DATE_FORMAT(shipment_date,'%Y-%m') AS month,COUNT(*) AS shipments
      FROM shipments WHERE company_id=? AND shipment_date>=DATE_SUB(CURRENT_DATE(),INTERVAL 11 MONTH)
      GROUP BY DATE_FORMAT(shipment_date,'%Y-%m') ORDER BY month`, [companyId],
  );
  const [personalCounts] = await executor.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS total,
      COALESCE(SUM(current_event='DELIVERED'),0) AS delivered,
      COALESCE(SUM(current_event IN (${activeEvents})),0) AS active,
      COALESCE(SUM(current_event IN ('PICKUP_EXCEPTION','DELIVERY_EXCEPTION','TRANSPORT_MISSING_EXCEPTION','TRANSPORT_DAMAGED_EXCEPTION')),0) AS exceptions,
      COALESCE(SUM(current_event IS NULL OR current_event='BOOKED'),0) AS awaitingEvent
    FROM (${personalShipmentScope}) customer_shipments`, [companyId, customerId],
  );
  const [personalStates] = await executor.execute<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT NULLIF(UPPER(TRIM(state_name)),'')) AS total FROM (
      SELECT sender_state AS state_name FROM shipments WHERE company_id=? AND customer_id=?
      UNION ALL SELECT receiver_state AS state_name FROM shipments WHERE company_id=? AND customer_id=?
    ) customer_states`, [companyId, customerId, companyId, customerId],
  );
  const [personalRoutes] = await executor.execute<RowDataPacket[]>(
    `SELECT COALESCE(oh.city,s.origin_hub_id) AS origin,COALESCE(dh.city,s.destination_hub_id) AS destination,
      COUNT(*) AS shipments,COALESCE(SUM(s.current_event='DELIVERED'),0) AS delivered,
      COALESCE(SUM(s.current_event IN (${activeEvents})),0) AS active
    FROM (${personalShipmentScope}) s
      LEFT JOIN hubs oh ON oh.company_id=? AND oh.hub_id=s.origin_hub_id
      LEFT JOIN hubs dh ON dh.company_id=? AND dh.hub_id=s.destination_hub_id
    GROUP BY s.origin_hub_id,s.destination_hub_id,oh.city,dh.city
    ORDER BY shipments DESC,origin,destination LIMIT 6`, [companyId, customerId, companyId, companyId],
  );
  const [monthly] = await executor.execute<RowDataPacket[]>(
    `SELECT DATE_FORMAT(shipment_date,'%Y-%m') AS month,COUNT(*) AS shipments
      FROM shipments WHERE company_id=? AND customer_id=? AND shipment_date>=DATE_SUB(CURRENT_DATE(),INTERVAL 11 MONTH)
      GROUP BY DATE_FORMAT(shipment_date,'%Y-%m') ORDER BY month`, [companyId, customerId],
  );
  const [pending] = await executor.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM customer_booking_requests r
      JOIN customer_accounts a ON a.customer_account_id=r.customer_account_id AND a.company_id=? AND a.customer_id=?
      WHERE r.status='PENDING_APPROVAL'`, [companyId, customerId],
  );
  const [recent] = await executor.execute<RowDataPacket[]>(
    `SELECT s.consignment_no AS consignmentNo,s.shipment_date AS shipmentDate,
      s.origin_hub_id AS originHubId,s.destination_hub_id AS destinationHubId,s.mode,s.total_amount AS totalAmount,
      (SELECT NULLIF(se.event_type,'') FROM shipment_events se WHERE se.consignment_no=s.consignment_no
        AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=se.consignment_no)=1
        ORDER BY se.event_time DESC,se.event_id DESC LIMIT 1) AS status,
      (SELECT MAX(se.event_time) FROM shipment_events se WHERE se.consignment_no=s.consignment_no
        AND (SELECT COUNT(*) FROM shipments u WHERE u.consignment_no=se.consignment_no)=1) AS lastEventAt
    FROM shipments s WHERE s.company_id=? AND s.customer_id=?
    ORDER BY s.shipment_date DESC,s.consignment_no DESC LIMIT 5`, [companyId, customerId],
  );

  const network = networkCounts[0];
  const personal = personalCounts[0];
  const destinationHubs = new Map<string, Array<{ hubId: string; city: string; shipments: number }>>();
  for (const item of networkDestinationHubs) {
    const destination = String(item.destination);
    const hubs = destinationHubs.get(destination) ?? [];
    hubs.push({ hubId: String(item.hubId), city: String(item.city), shipments: Number(item.shipments) });
    destinationHubs.set(destination, hubs);
  }
  return {
    companyNetwork: {
      totalShipments: Number(network?.total ?? 0),
      deliveredShipments: Number(network?.delivered ?? 0),
      activeShipments: Number(network?.active ?? 0),
      customersServed: Number(network?.customersServed ?? 0),
      statesCovered: Number(networkStates[0]?.total ?? 0),
      hubsCovered: Number(networkHubs[0]?.total ?? 0),
      monthlyShipmentActivity: networkMonthly.map((item) => ({ month: String(item.month), shipments: Number(item.shipments) })),
      destinationSummary: networkDestinations.map((item) => ({
        destination: String(item.destination), shipments: Number(item.shipments),
        delivered: Number(item.delivered), active: Number(item.active),
        hubs: destinationHubs.get(String(item.destination)) ?? [],
      })),
      routeSummary: networkRoutes.map((route) => ({
        origin: String(route.origin), destination: String(route.destination),
        shipments: Number(route.shipments), delivered: Number(route.delivered), active: Number(route.active),
      })),
    },
    personal: {
      totalShipments: Number(personal?.total ?? 0),
      deliveredShipments: Number(personal?.delivered ?? 0),
      activeShipments: Number(personal?.active ?? 0),
      exceptionShipments: Number(personal?.exceptions ?? 0),
      awaitingEvent: Number(personal?.awaitingEvent ?? 0),
      pendingApproval: Number(pending[0]?.total ?? 0),
      statesCovered: Number(personalStates[0]?.total ?? 0),
      topRoutes: personalRoutes.map((route) => ({
        origin: String(route.origin), destination: String(route.destination),
        shipments: Number(route.shipments), delivered: Number(route.delivered), active: Number(route.active),
      })),
      monthlyActivity: monthly.map((item) => ({ month: String(item.month), shipments: Number(item.shipments) })),
    },
    recentShipments: recent.map((item) => ({
      consignmentNo: String(item.consignmentNo),
      shipmentDate: item.shipmentDate ? new Date(item.shipmentDate).toISOString() : null,
      originHubId: String(item.originHubId), destinationHubId: String(item.destinationHubId),
      mode: String(item.mode), status: item.status ? String(item.status) : null,
      lastEventAt: item.lastEventAt ? new Date(item.lastEventAt).toISOString() : null,
      totalAmount: item.totalAmount === null ? null : Number(item.totalAmount),
    })),
  };
}
