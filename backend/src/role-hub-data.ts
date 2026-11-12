import type { RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";

type QueryExecutor = Pick<PoolConnection, "execute">;

type AssignmentRow = RowDataPacket & {
  assigned: number;
};

export type HubShipmentRow = RowDataPacket & {
  consignmentNo: string;
  shipmentDate: string;
  status: string;
  origin: string;
  destination: string;
  mode: string;
};

export class HubAccessError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("You are not authorized to access this hub.");
    this.name = "HubAccessError";
  }
}

export async function listAssignedHubShipments(
  executor: QueryExecutor,
  companyId: number,
  employeeId: string,
  hubId: string,
): Promise<HubShipmentRow[]> {
  const [assignments] = await executor.execute<AssignmentRow[]>(
    `SELECT 1 AS assigned
       FROM employee_hubs eh
       JOIN employees e
         ON e.employee_id = eh.employee_id
        AND e.company_id = ?
        AND UPPER(e.status) = 'ACTIVE'
       JOIN hubs h
         ON h.hub_id = eh.hub_id
        AND h.company_id = e.company_id
        AND UPPER(h.status) = 'ACTIVE'
      WHERE eh.employee_id = ?
        AND eh.hub_id = ?
        AND UPPER(eh.status) = 'ACTIVE'
      LIMIT 1`,
    [companyId, employeeId, hubId],
  );
  if (assignments.length !== 1) {
    throw new HubAccessError();
  }

  const [shipments] = await executor.execute<HubShipmentRow[]>(
    `SELECT s.consignment_no AS consignmentNo,
            s.shipment_date AS shipmentDate,
            s.delivery_status AS status,
            COALESCE(oh.city, 'Unavailable') AS origin,
            COALESCE(dh.city, 'Unavailable') AS destination,
            s.mode
       FROM shipments s
       LEFT JOIN hubs oh
         ON oh.hub_id = s.origin_hub_id
        AND oh.company_id = s.company_id
       LEFT JOIN hubs dh
         ON dh.hub_id = s.destination_hub_id
        AND dh.company_id = s.company_id
      WHERE s.company_id = ?
        AND (s.origin_hub_id = ? OR s.destination_hub_id = ?)
      ORDER BY s.shipment_date DESC, s.consignment_no
      LIMIT 100`,
    [companyId, hubId, hubId],
  );
  return shipments;
}
