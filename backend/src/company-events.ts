export type CompanyDataEvent = {
  id: number;
  companyId: number;
  type: "shipment.changed" | "hub-assignment.changed" | "exception.changed" | "company-data.changed";
  occurredAt: string;
  hubId?: string;
  customerId?: string;
};

type Subscriber = (event: CompanyDataEvent) => void;

const retainedEvents: CompanyDataEvent[] = [];
const subscribers = new Map<number, Set<Subscriber>>();
const maximumRetainedEvents = 500;
let nextEventId = 1;

export function publishCompanyDataChanged(
  companyId: number,
  type: CompanyDataEvent["type"] = "company-data.changed",
  hubId?: string,
  customerId?: string,
): CompanyDataEvent {
  const event: CompanyDataEvent = {
    id: nextEventId++,
    companyId,
    type,
    occurredAt: new Date().toISOString(),
    ...(hubId ? { hubId } : {}),
    ...(customerId ? { customerId } : {}),
  };
  retainedEvents.push(event);
  if (retainedEvents.length > maximumRetainedEvents) retainedEvents.shift();

  for (const subscriber of subscribers.get(companyId) ?? []) {
    try {
      subscriber(event);
    } catch (error) {
      subscribers.get(companyId)?.delete(subscriber);
      console.error(
        "Unable to deliver company update event:",
        error instanceof Error ? error.message : "Unknown subscriber error",
      );
    }
  }
  return event;
}

export async function publishAfterCommit<T>(
  commit: () => Promise<void>,
  companyId: number,
  type: CompanyDataEvent["type"],
  result: T,
  hubId?: string,
  customerId?: string,
): Promise<T> {
  await commit();
  publishCompanyDataChanged(companyId, type, hubId, customerId);
  return result;
}

export async function runCompanyDataTransaction<T>(
  companyId: number,
  type: CompanyDataEvent["type"],
  operation: (connection: import("mysql2/promise").PoolConnection) => Promise<T>,
  hubId?: string,
  customerId?: string,
  consignmentNo?: string | string[],
): Promise<T> {
  const { pool } = await import("./db.js");
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    let scopedCustomerIds = customerId ? [customerId] : [];
    const resultConsignments = result && typeof result === "object" && "consignmentNos" in result
      ? (result as { consignmentNos?: unknown }).consignmentNos
      : undefined;
    const shipmentRefs = consignmentNo ?? (Array.isArray(resultConsignments) ? resultConsignments.filter((id): id is string => typeof id === "string") : undefined);
    if (!customerId && shipmentRefs && type === "shipment.changed") {
      const ids = Array.isArray(shipmentRefs) ? shipmentRefs : [shipmentRefs];
      if (ids.length) {
        const [rows] = await connection.execute<import("mysql2/promise").RowDataPacket[]>(
          `SELECT DISTINCT customer_id AS customerId FROM shipments WHERE company_id = ? AND consignment_no IN (${ids.map(() => "?").join(",")})`,
          [companyId, ...ids],
        );
        scopedCustomerIds = rows.map((row) => String(row.customerId));
      }
    }
    if (scopedCustomerIds.length > 1) {
      await connection.commit();
      for (const id of scopedCustomerIds) publishCompanyDataChanged(companyId, type, hubId, id);
    } else {
      await publishAfterCommit(() => connection.commit(), companyId, type, result, hubId, scopedCustomerIds[0]);
    }
    committed = true;
    return result;
  } catch (error) {
    if (!committed) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Unable to roll back company data transaction:",
          rollbackError instanceof Error ? rollbackError.message : "Unknown rollback error",
        );
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

export function subscribeToCompanyData(
  companyId: number,
  lastEventId: string | undefined,
  subscriber: Subscriber,
  allowedHubIds?: string[],
  allowedCustomerId?: string,
): { replay: CompanyDataEvent[]; recoveryRequired: boolean; unsubscribe: () => void } {
  const cursor = lastEventId === undefined ? null : Number(lastEventId);
  const validCursor = cursor !== null && Number.isSafeInteger(cursor) && cursor >= 0;
  const oldestRetainedId = retainedEvents[0]?.id ?? nextEventId;
  const recoveryRequired =
    lastEventId !== undefined &&
    (!validCursor || (cursor !== null && cursor < oldestRetainedId - 1) || (cursor !== null && cursor >= nextEventId));
  const replay =
    validCursor && cursor !== null && !recoveryRequired
      ? retainedEvents.filter((event) =>
          event.companyId === companyId &&
          event.id > cursor &&
          (allowedCustomerId === undefined || event.customerId === allowedCustomerId) &&
          (!allowedHubIds || !event.hubId || allowedHubIds.includes(event.hubId)))
      : [];

  let companySubscribers = subscribers.get(companyId);
  if (!companySubscribers) {
    companySubscribers = new Set();
    subscribers.set(companyId, companySubscribers);
  }
  const scopedSubscriber = (event: CompanyDataEvent) => {
    if (allowedCustomerId !== undefined && event.customerId !== allowedCustomerId) return;
    if (allowedHubIds && event.hubId && !allowedHubIds.includes(event.hubId)) return;
    subscriber(event);
  };
  companySubscribers.add(scopedSubscriber);

  return {
    replay,
    recoveryRequired,
    unsubscribe: () => {
      companySubscribers?.delete(scopedSubscriber);
      if (companySubscribers?.size === 0) subscribers.delete(companyId);
    },
  };
}
