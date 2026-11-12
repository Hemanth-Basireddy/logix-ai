import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { authenticatedFetch, useAuth } from "./auth";
import { ShipmentQrCode } from "./ShipmentQrCode";
import { ShipmentQrScanner } from "./ShipmentQrScanner";
import { HubManagerTransport } from "./HubManagerTransport";

type View =
  | "overview"
  | "inbound"
  | "outbound"
  | "tasks"
  | "inventory"
  | "exceptions"
  | "staff"
  | "routes"
  | "notifications"
  | "transport"
  | "reports";

type Shipment = {
  consignmentNo: string;
  shipmentDate: string;
  status: string;
  mode: string;
  routeId: string | null;
  originHubId: string;
  destinationHubId: string;
  origin: string;
  destination: string;
  lastEventAt: string | null;
  lastEvent: string | null;
  lastEventStatus: string | null;
  currentHubId: string | null;
  currentHubCity: string | null;
  recipientName?: string | null;
  originExecutive1Id?: string | null;
  originExecutive2Id?: string | null;
  destinationExecutive1Id?: string | null;
  destinationExecutive2Id?: string | null;
  originExecutiveNames?: string | null;
  destinationExecutiveNames?: string | null;
  operationalState?: string;
  nextAction?: string;
  requiredTaskType?: "PICKUP" | "DELIVERY" | null;
  hubId?: string;
};

type ShipmentEvent = {
  eventTime: string;
  eventType: string;
  eventStatus: string;
  hubId: string | null;
  city: string | null;
  employeeName: string | null;
};

type Detail = Shipment & { events: ShipmentEvent[] };
type AssignedTask = {
  taskKey: string; taskType: "PICKUP" | "DELIVERY"; status: string; hubId: string; hubCity: string;
  consignmentNo: string; employeeId: string; employeeName: string; shipmentStatus: string; assignedAt: string;
};

type Workspace = {
  scope: { assignedHubCount: number };
  hubs: Array<{ hubId: string; city: string }>;
  hubWorkload: Array<{
    hubId: string;
    city: string;
    shipments: number;
    inboundPending: number;
    arrivalPending?: number;
    receiptPending?: number;
    assignmentPending?: number;
    outboundReady: number;
    dispatched?: number;
    inventory: number;
  }>;
  kpis: {
    shipments: number;
    inboundPending: number;
    outboundReady: number;
    inventory: number;
    exceptions: number;
    staleTracking: number;
    tasks: number;
  };
  statusCounts: Array<{ status: string; total: number }>;
  volumeTrend: Array<{ day: string; total: number }>;
  inbound: Shipment[];
  pickupQueue: Array<{ consignmentNo: string; hubId: string; origin: string; destination: string; lastEventAt: string | null }>;
  outbound: Shipment[];
  inventory: Shipment[];
  exceptions: Array<{
    consignmentNo: string;
    reason: string;
    status: string;
    eventTime: string;
    hubId: string;
    hubCity: string;
  }>;
  staleTracking: Array<{
    consignmentNo: string;
    hubId: string;
    hubCity: string;
    lastEventAt: string;
    lastEvent: string;
  }>;
  staff: Array<{ employeeId: string; name: string; role: string; hubId: string; city: string }>;
  routes: Array<{
    routeId: string;
    mode: string;
    estimatedTransitDays: number | null;
    originHubId: string;
    origin: string;
    destinationHubId: string;
    destination: string;
    shipments: number;
    recordedDelayed: number;
  }>;
  recentEvents: Array<{
    consignmentNo: string;
    eventTime: string;
    eventType: string;
    eventStatus: string;
    hubId: string;
    hubCity: string;
  }>;
  capabilities: {
    taskAssignments: boolean;
    qrScanning: boolean;
    trackingIdVerification: boolean;
    receipt: boolean;
    dispatch: boolean;
    persistentNotifications: boolean;
  };
};

const navigation: Array<{ id: View; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "◫" },
  { id: "inbound", label: "Inbound Shipments", icon: "↓" },
  { id: "outbound", label: "Outbound & Dispatch", icon: "↑" },
  { id: "tasks", label: "Pickup & Delivery Tasks", icon: "✓" },
  { id: "inventory", label: "Hub Inventory", icon: "▣" },
  { id: "exceptions", label: "Exceptions", icon: "△" },
  { id: "staff", label: "Staff", icon: "♧" },
  { id: "routes", label: "Routes", icon: "⌁" },
  { id: "notifications", label: "Notifications", icon: "◉" },
  { id: "reports", label: "Reports", icon: "▥" },
];
navigation.splice(navigation.length - 1, 0, { id: "transport", label: "Hub Transport", icon: "⇄" });

function asView(value: string | null): View {
  return navigation.find((item) => item.id === value)?.id ?? "overview";
}

function count(value: number | undefined): string {
  return (value ?? 0).toLocaleString("en-IN");
}

function dateTime(value: string | null | undefined): string {
  if (!value) return "No event recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function shipmentView(view: View): "all" | "inbound" | "outbound" | "inventory" | "exceptions" {
  if (view === "inbound" || view === "outbound" || view === "inventory" || view === "exceptions") return view;
  return "all";
}

export function HubManagerDashboard() {
  const { employee } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView = asView(searchParams.get("view"));
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [notices, setNotices] = useState<Array<{ type: string; time: string }>>([]);
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [hubId, setHubId] = useState(searchParams.get("hubId") ?? "");
  const [status, setStatus] = useState(searchParams.get("status") ?? "");
  const [assignmentFilter, setAssignmentFilter] = useState(searchParams.get("assignment") ?? "");
  const [fromDate, setFromDate] = useState(searchParams.get("from") ?? "");
  const [toDate, setToDate] = useState(searchParams.get("to") ?? "");
  const [page, setPage] = useState(Number(searchParams.get("page") ?? "1"));
  const [pageSize, setPageSize] = useState(25);
  const [rows, setRows] = useState<Shipment[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [verifiedTrackingId, setVerifiedTrackingId] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [tasks, setTasks] = useState<AssignedTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [taskSuccess, setTaskSuccess] = useState<string | null>(null);
  const [taskHubId, setTaskHubId] = useState("");
  const [taskEmployeeId, setTaskEmployeeId] = useState("");
  const [taskConsignmentNo, setTaskConsignmentNo] = useState("");
  const [taskType, setTaskType] = useState<"PICKUP" | "DELIVERY">("PICKUP");
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskStatusFilter, setTaskStatusFilter] = useState("ALL");
  const [assignmentShipment, setAssignmentShipment] = useState<Shipment | null>(null);
  const [assignmentEmployeeId, setAssignmentEmployeeId] = useState("");
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [assignmentSaving, setAssignmentSaving] = useState(false);

  useEffect(() => {
    setSearch(searchParams.get("q") ?? "");
    setHubId(searchParams.get("hubId") ?? "");
    setStatus(searchParams.get("status") ?? "");
    setAssignmentFilter(searchParams.get("assignment") ?? "");
    setFromDate(searchParams.get("from") ?? "");
    setToDate(searchParams.get("to") ?? "");
    setPage(Number(searchParams.get("page") ?? "1"));
  }, [searchParams]);

  useEffect(() => {
    if (!workspace?.hubs.length) return;
    setTaskHubId((current) => workspace.hubs.some((hub) => hub.hubId === current) ? current : workspace.hubs[0]!.hubId);
  }, [workspace]);

  useEffect(() => {
    const controller = new AbortController();
    setWorkspaceLoading(true);
    setError(null);
    authenticatedFetch("/api/hub-manager/workspace", {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as Workspace & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Hub workspace could not be loaded.");
        return payload;
      })
      .then(setWorkspace)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Hub workspace could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setWorkspaceLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    const source = new EventSource("/api/hub-manager/events");
    source.onopen = () => setConnection("connected");
    source.onerror = () => setConnection("reconnecting");
    const refresh = (event: Event) => {
      const message = event as MessageEvent<{ type?: string }>;
      setNotices((items) => [
        { type: message.data?.type ?? "hub update", time: new Date().toISOString() },
        ...items,
      ].slice(0, 20));
      setReloadKey((value) => value + 1);
    };
    source.addEventListener("hub-data-changed", refresh);
    source.addEventListener("recovery-required", refresh);
    return () => source.close();
  }, []);

  useEffect(() => {
    if (activeView !== "tasks") return;
    const controller = new AbortController();
    const query = new URLSearchParams({ status: taskStatusFilter });
    if (taskHubId) query.set("hubId", taskHubId);
    setTasksLoading(true);
    setTasksError(null);
    authenticatedFetch(`/api/hub-manager/tasks?${query}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { tasks?: AssignedTask[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Hub tasks could not be loaded.");
        return payload.tasks ?? [];
      })
      .then(setTasks)
      .catch((caught: unknown) => { if (!(caught instanceof DOMException && caught.name === "AbortError")) setTasksError(caught instanceof Error ? caught.message : "Hub tasks could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setTasksLoading(false); });
    return () => controller.abort();
  }, [activeView, taskHubId, taskStatusFilter, reloadKey]);

  useEffect(() => {
    if (!["inbound", "outbound", "inventory", "exceptions"].includes(activeView)) return;
    const controller = new AbortController();
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      view: shipmentView(activeView),
    });
    const optionalFilters = [
      ["search", searchParams.get("q") ?? ""],
      ["status", searchParams.get("status") ?? ""],
      ["hubId", searchParams.get("hubId") ?? ""],
      ["assignment", searchParams.get("assignment") ?? ""],
      ["from", searchParams.get("from") ?? ""],
      ["to", searchParams.get("to") ?? ""],
    ] as const;
    for (const [key, value] of optionalFilters) {
      if (value) query.set(key, value);
    }
    setListLoading(true);
    setListError(null);
    authenticatedFetch(`/api/hub-manager/shipments?${query}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as { shipments?: Shipment[]; total?: number; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Hub shipments could not be loaded.");
        return payload;
      })
      .then((payload) => {
        setRows(payload.shipments ?? []);
        setTotal(payload.total ?? 0);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setListError(caught instanceof Error ? caught.message : "Hub shipments could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });
    return () => controller.abort();
  }, [activeView, page, pageSize, reloadKey, searchParams]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setVerifiedTrackingId("");
      setActionError(null);
      return;
    }
    const controller = new AbortController();
    setDetailError(null);
    authenticatedFetch(`/api/hub-manager/shipments/${encodeURIComponent(selectedId)}/events`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as { shipment?: Detail; error?: string };
        if (!response.ok || !payload.shipment) throw new Error(payload.error ?? "Shipment details could not be loaded.");
        return payload.shipment;
      })
      .then(setDetail)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setDetailError(caught instanceof Error ? caught.message : "Shipment details could not be loaded.");
      });
    return () => controller.abort();
  }, [reloadKey, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !actionLoading) setSelectedId(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [actionLoading, selectedId]);

  const title = navigation.find((item) => item.id === activeView)?.label ?? "Overview";
  const maxTrend = useMemo(() => Math.max(1, ...(workspace?.volumeTrend.map((item) => item.total) ?? [])), [workspace]);
  const hasHubs = Boolean(workspace?.scope.assignedHubCount);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const isActionView = activeView === "inbound" || activeView === "outbound";
  const queueCounts = useMemo(() => {
    const hubs = (workspace?.hubWorkload ?? []).filter((item) => !hubId || item.hubId === hubId);
    return hubs.reduce((total, item) => ({
      transit: total.transit + item.inboundPending,
      arrival: total.arrival + (item.arrivalPending ?? 0),
      receipt: total.receipt + (item.receiptPending ?? 0),
      received: total.received + item.inventory,
      assignment: total.assignment + (item.assignmentPending ?? 0),
      ready: total.ready + item.outboundReady,
      dispatched: total.dispatched + (item.dispatched ?? 0),
    }), { transit: 0, arrival: 0, receipt: 0, received: 0, assignment: 0, ready: 0, dispatched: 0 });
  }, [hubId, workspace]);

  function goTo(view: View, extra?: Record<string, string>) {
    setPage(1);
    setSearchParams({ view, ...extra });
  }

  function applyFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: Record<string, string> = { view: activeView };
    if (search.trim()) next.q = search.trim();
    if (hubId) next.hubId = hubId;
    if (status) next.status = status;
    if (assignmentFilter) next.assignment = assignmentFilter;
    if (fromDate) next.from = fromDate;
    if (toDate) next.to = toDate;
    setPage(1);
    setSearchParams(next);
  }

  function openShipment(consignmentNo: string) {
    setSelectedId(consignmentNo);
    setVerifiedTrackingId("");
    setActionError(null);
  }

  async function performAction(action: "arrive" | "receive" | "dispatch") {
    if (!detail || verifiedTrackingId.trim() !== detail.consignmentNo) {
      setActionError("Enter the exact tracking ID shown for this shipment to confirm.");
      return;
    }
    const actionHubId = action === "dispatch" ? detail.originHubId
      : detail.lastEvent === "HANDED_OVER_AT_ORIGIN_HUB" || detail.lastEvent === "ARRIVED_AT_ORIGIN_HUB" || detail.lastEvent === "RECEIVED_AT_ORIGIN_HUB" ? detail.originHubId
        : detail.destinationHubId;
    setActionLoading(true);
    setActionError(null);
    try {
      const response = await authenticatedFetch(
        `/api/hub-manager/hubs/${encodeURIComponent(actionHubId)}/shipments/${encodeURIComponent(detail.consignmentNo)}/${action}`,
        { method: "POST", credentials: "same-origin" },
      );
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Shipment ${action} could not be recorded.`);
      setVerifiedTrackingId("");
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : `Shipment ${action} could not be recorded.`);
    } finally {
      setActionLoading(false);
    }
  }

  async function resolveHubQr(consignmentNo: string) {
    const response = await authenticatedFetch(`/api/hub-manager/shipments/${encodeURIComponent(consignmentNo)}/events`, { credentials: "same-origin" });
    const payload = await response.json() as { shipment?: Detail; error?: string };
    if (!response.ok || !payload.shipment) throw new Error(payload.error ?? "Shipment is outside your assigned hub scope.");
    const currentEvent = payload.shipment.events[0]?.eventType;
    const eligible = activeView === "inbound"
      ? ["DISPATCHED", "HANDED_OVER_AT_ORIGIN_HUB", "ARRIVED_AT_ORIGIN_HUB", "ARRIVED_AT_DESTINATION_HUB"].includes(currentEvent ?? "")
      : currentEvent === "RECEIVED_AT_ORIGIN_HUB";
    if (!eligible) throw new Error("This shipment is not waiting for the action available in the current hub queue.");
    setVerifiedTrackingId(consignmentNo);
    setSelectedId(consignmentNo);
  }

  async function assignFromQueue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assignmentShipment?.requiredTaskType) return;
    setAssignmentSaving(true); setAssignmentError(null);
    try {
      const assignmentHubId = assignmentShipment.requiredTaskType === "PICKUP" ? assignmentShipment.originHubId : assignmentShipment.destinationHubId;
      const response = await authenticatedFetch("/api/hub-manager/tasks", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hubId: assignmentHubId, employeeId: assignmentEmployeeId, consignmentNo: assignmentShipment.consignmentNo, taskType: assignmentShipment.requiredTaskType }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Task could not be assigned.");
      setAssignmentShipment(null); setAssignmentEmployeeId(""); setReloadKey((value) => value + 1);
    } catch (caught) { setAssignmentError(caught instanceof Error ? caught.message : "Task could not be assigned."); }
    finally { setAssignmentSaving(false); }
  }

  async function assignTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTasksError(null); setTaskSuccess(null); setTaskSaving(true);
    try {
      const response = await authenticatedFetch("/api/hub-manager/tasks", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hubId: taskHubId, employeeId: taskEmployeeId, consignmentNo: taskConsignmentNo.trim(), taskType }),
      });
      const payload = await response.json() as { error?: string; task?: { taskKey: string } };
      if (!response.ok) throw new Error(payload.error ?? "Task could not be assigned.");
      setTaskSuccess(`Task ${payload.task?.taskKey ?? ""} assigned successfully.`);
      setTaskConsignmentNo(""); setReloadKey((value) => value + 1);
    } catch (caught) { setTasksError(caught instanceof Error ? caught.message : "Task could not be assigned."); }
    finally { setTaskSaving(false); }
  }

  function renderTable(data: Shipment[], busy: boolean) {
    return (
      <>
        <div className="op-table-wrap">
          <table className="op-table">
            <thead><tr><th>Shipment / recipient</th><th>Route</th><th>Operational state</th><th>Last event</th><th>Next action</th><th>Assignment</th><th>Actions</th></tr></thead>
            <tbody>
              {data.map((row) => {
                const executiveId = row.requiredTaskType === "PICKUP"
                  ? row.originExecutive1Id ?? row.originExecutive2Id
                  : row.destinationExecutive1Id ?? row.destinationExecutive2Id;
                return <tr key={row.consignmentNo}>
                  <td><strong>{row.consignmentNo}</strong><small>{row.recipientName || "Recipient unavailable"} · {row.mode}</small></td>
                  <td>{row.origin} → {row.destination}</td>
                  <td><span className="op-status-pill">{(row.operationalState ?? row.status ?? "Unspecified").replaceAll("_", " ")}</span><small>{row.status || "No shipment status"}</small></td>
                  <td>{row.lastEvent ? <>{row.lastEvent.replaceAll("_", " ")}<small>{dateTime(row.lastEventAt)}</small></> : "No event recorded"}</td>
                  <td>{row.nextAction ?? "Review recorded shipment"}</td>
                  <td>{row.requiredTaskType ? (executiveId ? `Assigned · ${row.requiredTaskType === "PICKUP" ? row.originExecutiveNames ?? executiveId : row.destinationExecutiveNames ?? executiveId}` : "Unassigned") : "—"}</td>
                  <td><button className="op-row-link" onClick={() => openShipment(row.consignmentNo)} type="button">Inspect</button>{row.requiredTaskType && !executiveId && <button className="op-row-link" onClick={() => { setAssignmentShipment(row); setAssignmentEmployeeId(""); setAssignmentError(null); }} type="button">Assign Executive</button>}</td>
                </tr>;
              })}
              {!busy && data.length === 0 && <tr><td className="op-table-empty" colSpan={7}>{activeView === "inbound" ? "No inbound shipments currently require action for this hub." : activeView === "outbound" ? "No outbound shipments currently require action for this hub." : "No matching recorded shipments."}</td></tr>}
              {busy && <tr><td className="op-table-empty" colSpan={7}>Loading hub records…</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="op-pagination">
          <span>{count(total)} matching records</span>
          <div>
            <label htmlFor="hub-page-size">Rows</label>
            <select id="hub-page-size" onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} value={pageSize}>
              <option value={25}>25</option><option value={50}>50</option><option value={100}>100</option>
            </select>
            <button className="op-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">Previous</button>
            <span>Page {page} of {pages}</span>
            <button className="op-button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)} type="button">Next</button>
          </div>
        </div>
      </>
    );
  }
  function renderOverview() {
    if (!workspace) return null;
    const cards: Array<{ label: string; value: number; target: View; hint: string }> = [
      { label: "In-scope shipments", value: workspace.kpis.shipments, target: "inventory", hint: "Origin, destination, or recorded hub history" },
      { label: "Inbound pending receipt", value: workspace.kpis.inboundPending, target: "inbound", hint: "Recorded dispatches addressed to your hubs" },
      { label: "Outbound ready", value: workspace.kpis.outboundReady, target: "outbound", hint: "Physically recorded at an origin hub" },
      { label: "Physical inventory", value: workspace.kpis.inventory, target: "inventory", hint: "Latest recorded event confirms arrival at a hub" },
      { label: "Operational exceptions", value: workspace.kpis.exceptions + workspace.kpis.staleTracking, target: "exceptions", hint: "Recorded exception events and stale dispatched shipments" },
    ];
    return (
      <>
        <div className="op-kpis">
          {cards.map((card) => (
            <button className="op-kpi" key={card.label} onClick={() => goTo(card.target)} type="button">
              <span>{card.label}</span><strong>{workspaceLoading ? "—" : count(card.value)}</strong><small>{card.hint}</small>
            </button>
          ))}
        </div>
        <div className="op-content-grid">
          <section className="op-panel op-trend-panel">
            <div className="op-panel-heading"><div><span className="op-eyebrow">RECORDED BOOKING DATES · 30 DAYS</span><h2>Shipment volume</h2></div><button className="op-link" onClick={() => goTo("reports")} type="button">Reports →</button></div>
            {workspace.volumeTrend.length === 0 ? <p className="op-empty-inline">No recorded shipments for this period.</p> : (
              <div aria-label="Shipment volume by recorded booking date" className="op-trend" role="img">
                {workspace.volumeTrend.map((item) => (
                  <div className="op-trend-column" key={String(item.day)} title={`${dateTime(String(item.day))}: ${count(item.total)} shipments`}>
                    <span style={{ height: `${Math.max(3, item.total / maxTrend * 100)}%` }} />
                    <small>{new Date(item.day).getDate()}</small>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="op-panel">
            <div className="op-panel-heading"><div><span className="op-eyebrow">ACTIVE ASSIGNMENTS</span><h2>Your hubs</h2></div></div>
            <div className="op-hub-bars">
              {workspace.hubWorkload.map((hub) => (
                <button className="op-hub-bar" key={hub.hubId} onClick={() => goTo("inventory", { hubId: hub.hubId })} type="button">
                  <span className="op-hub-bar-label"><strong>{hub.city}</strong><small>{hub.hubId}</small><b>{count(hub.shipments)}</b></span>
                  <span className="op-bar-track"><i style={{ width: `${Math.max(2, hub.shipments / Math.max(1, ...workspace.hubWorkload.map((item) => item.shipments)) * 100)}%` }} /></span>
                  <small>{count(hub.inventory)} on-site · {count(hub.inboundPending)} inbound · {count(hub.outboundReady)} ready to dispatch</small>
                </button>
              ))}
            </div>
          </section>
          <section className="op-panel">
            <div className="op-panel-heading"><div><span className="op-eyebrow">DATABASE STATUS VALUES</span><h2>Shipment outcomes</h2></div></div>
            <div className="op-status-list">
              {workspace.statusCounts.map((row) => (
                <button className="op-status-row" key={row.status} onClick={() => goTo("inventory", { status: row.status })} type="button">
                  <span>{row.status}</span><i><b style={{ width: `${Math.max(1, row.total / Math.max(1, workspace.kpis.shipments) * 100)}%` }} /></i><strong>{count(row.total)}</strong>
                </button>
              ))}
              {workspace.statusCounts.length === 0 && <p className="op-empty-inline">No status data.</p>}
            </div>
          </section>
          <section className="op-panel">
            <div className="op-panel-heading"><div><span className="op-eyebrow">REAL OPERATIONAL EVENTS</span><h2>Recent attention items</h2></div><button className="op-link" onClick={() => goTo("exceptions")} type="button">All exceptions →</button></div>
            {[...workspace.exceptions.slice(0, 3), ...workspace.staleTracking.slice(0, 3)].length === 0
              ? <p className="op-empty-inline">No recorded exception or stale-dispatch events in your hub scope.</p>
              : <div className="op-attention-list">
                  {workspace.exceptions.slice(0, 3).map((item, index) => (
                    <button key={`${item.consignmentNo}-${item.eventTime}-${index}`} onClick={() => openShipment(item.consignmentNo)} type="button">
                      <strong>{item.consignmentNo}</strong><span>{item.reason} · {item.status}</span><small>{item.hubCity} · {dateTime(item.eventTime)}</small>
                    </button>
                  ))}
                  {workspace.staleTracking.slice(0, 3).map((item) => (
                    <button key={`stale-${item.consignmentNo}`} onClick={() => openShipment(item.consignmentNo)} type="button">
                      <strong>{item.consignmentNo}</strong><span>Dispatched shipment has no later event for over 48 hours</span><small>{item.hubCity} · {dateTime(item.lastEventAt)}</small>
                    </button>
                  ))}
                </div>}
          </section>
        </div>
      </>
    );
  }

  function renderContent() {
    if (!workspace) return null;
    if (activeView === "overview") return renderOverview();
    if (activeView === "transport") return <HubManagerTransport hubs={workspace.hubs} refreshKey={reloadKey} onChanged={() => setReloadKey((value) => value + 1)} />;
    if (activeView === "inbound" || activeView === "outbound" || activeView === "inventory" || activeView === "exceptions") {
      return (
        <>
          {activeView === "inbound" && <p className="op-notice">Inbound shows persisted in-transit, arrival-pending, and received work for the selected authorized hub. Record arrival and physical receipt as separate actions.</p>}
          {activeView === "outbound" && <p className="op-notice">Dispatch is available only for shipments with a recorded arrival at this origin hub and a matching company route. Delivery outcome/SLA fields are not overwritten.</p>}
          {activeView === "inventory" && <p className="op-notice">Inventory includes only shipments whose latest recorded event is an arrival at an assigned hub. Origin/destination associations alone do not imply physical presence.</p>}
          {activeView === "exceptions" && <p className="op-notice">Showing only stored exception-like event types and shipments with a latest DISPATCHED event older than 48 hours. Historical “Delayed” outcome labels are not treated as active delays.</p>}
          {activeView === "inbound" && <div className="op-kpis op-queue-counts">{[["In transit", queueCounts.transit], ["Arrival pending", queueCounts.arrival], ["Receipt pending", queueCounts.receipt], ["Received", queueCounts.received]].map(([label, value]) => <div className="op-kpi" key={String(label)}><span>{label}</span><strong>{listLoading ? "—" : count(Number(value))}</strong></div>)}</div>}
          {activeView === "outbound" && <div className="op-kpis op-queue-counts">{[["Ready for dispatch", queueCounts.ready], ["Assignment pending", queueCounts.assignment], ["Dispatch pending", queueCounts.ready], ["Dispatched", queueCounts.dispatched]].map(([label, value]) => <div className="op-kpi" key={String(label)}><span>{label}</span><strong>{listLoading ? "—" : count(Number(value))}</strong></div>)}</div>}
          <form className="op-filters" onSubmit={applyFilters}>
            <label className="op-filter"><span>Find shipment (optional)</span><input onChange={(event) => setSearch(event.target.value)} placeholder="Search consignment" value={search} /></label>
            <label className="op-filter"><span>Assigned hub</span><select onChange={(event) => setHubId(event.target.value)} value={hubId}><option value="">All assigned hubs</option>{workspace.hubs.map((hub) => <option key={hub.hubId} value={hub.hubId}>{hub.city} · {hub.hubId}</option>)}</select></label>
            <label className="op-filter"><span>Recorded status</span><select onChange={(event) => setStatus(event.target.value)} value={status}><option value="">Any recorded status</option>{workspace.statusCounts.map((item) => <option key={item.status}>{item.status}</option>)}</select></label>
            {isActionView && <label className="op-filter"><span>Executive assignment</span><select onChange={(event) => setAssignmentFilter(event.target.value)} value={assignmentFilter}><option value="">Any assignment</option><option value="ASSIGNED">Assigned</option><option value="UNASSIGNED">Unassigned</option></select></label>}
            {isActionView && <label className="op-filter"><span>Booked from</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>}
            {isActionView && <label className="op-filter"><span>Booked to</span><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>}
            <button className="op-button-primary" type="submit">Apply filters</button>
          </form>
          {listError && <p className="op-error" role="alert">{listError}</p>}
          <p className="op-table-meta">{count(total)} records · server-filtered to your authorized hub scope{isActionView ? " · open a record to verify tracking and perform an eligible action" : ""}</p>
          {renderTable(rows, listLoading)}
        </>
      );
    }
    if (activeView === "tasks") {
      const hubExecutives = workspace.staff.filter((person) => person.role === "LOGISTICS_EXECUTIVE" && person.hubId === taskHubId);
      return <div className="op-content-grid">
        <section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">ASSIGN OPERATIONAL WORK</span><h2>Create a pickup or delivery task</h2></div></div>
          <form className="le-assign-form" onSubmit={(event) => void assignTask(event)}>
            <label><span>Assigned hub</span><select required value={taskHubId} onChange={(event) => { setTaskHubId(event.target.value); setTaskEmployeeId(""); }}>{workspace.hubs.map((hub) => <option key={hub.hubId} value={hub.hubId}>{hub.city} · {hub.hubId}</option>)}</select></label>
            <label><span>Task type</span><select value={taskType} onChange={(event) => setTaskType(event.target.value as "PICKUP" | "DELIVERY")}><option value="PICKUP">Pickup at origin</option><option value="DELIVERY">Delivery from destination hub</option></select></label>
            <label><span>Logistics Executive</span><select required value={taskEmployeeId} onChange={(event) => setTaskEmployeeId(event.target.value)}><option value="">Select assigned executive</option>{hubExecutives.map((person) => <option key={person.employeeId} value={person.employeeId}>{person.name} · {person.employeeId}</option>)}</select>{hubExecutives.length === 0 && <small>No active Logistics Executives are assigned to this hub.</small>}</label>
            <label><span>Shipment tracking ID</span><input required maxLength={50} value={taskConsignmentNo} onChange={(event) => setTaskConsignmentNo(event.target.value)} /></label>
            <p className="op-method-note">The API verifies the shipment lifecycle and route. Pickup tasks are available before pickup; delivery tasks require recorded destination hub receipt. Historical final outcomes cannot be assigned.</p>
            <button className="op-button-primary" disabled={taskSaving || !hubExecutives.length || !taskEmployeeId} type="submit">{taskSaving ? "Assigning…" : "Assign task"}</button>
          </form>
          {tasksError && <p className="op-error" role="alert">{tasksError}</p>}{taskSuccess && <p className="op-success" role="status">{taskSuccess}</p>}
        </section>
        <section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">HUB SCOPED TASKS</span><h2>Assigned field work</h2></div><label className="op-filter"><span>State</span><select value={taskStatusFilter} onChange={(event) => setTaskStatusFilter(event.target.value)}><option value="ALL">All states</option>{["PENDING","ACCEPTED","IN_PROGRESS","COMPLETED","FAILED"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label></div>
          {tasksLoading && tasks.length === 0 ? <p className="op-empty-inline">Loading assigned tasks…</p> : <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Type</th><th>Tracking ID</th><th>Executive</th><th>Status</th><th>Assigned</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.taskKey}><td>{task.taskType}</td><td>{task.consignmentNo}</td><td>{task.employeeName}<small>{task.employeeId}</small></td><td><span className="op-status-pill">{task.status.replaceAll("_", " ")}</span></td><td>{dateTime(task.assignedAt)}</td></tr>)}{!tasksLoading && tasks.length === 0 && <tr><td className="op-table-empty" colSpan={5}>No tasks have been assigned for this hub yet.</td></tr>}</tbody></table></div>}
          {tasksLoading && tasks.length > 0 && <p className="op-method-note">Refreshing tasks…</p>}
        </section>
        <section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">APPROVED · AWAITING PICKUP ASSIGNMENT</span><h2>Origin hub queue</h2></div></div><div className="op-table-wrap"><table className="op-table"><thead><tr><th>Tracking ID</th><th>Route</th><th>Origin hub</th><th>Request</th><th /></tr></thead><tbody>{workspace.pickupQueue.map((shipment) => <tr key={shipment.consignmentNo}><td>{shipment.consignmentNo}</td><td>{shipment.origin} → {shipment.destination}</td><td>{shipment.hubId}</td><td>{dateTime(shipment.lastEventAt)}</td><td><button className="op-row-link" type="button" onClick={() => { setTaskHubId(shipment.hubId); setTaskType("PICKUP"); setTaskConsignmentNo(shipment.consignmentNo); setTaskEmployeeId(""); }}>Assign pickup</button></td></tr>)}{workspace.pickupQueue.length === 0 && <tr><td className="op-table-empty" colSpan={5}>No approved shipments are waiting for origin pickup assignment.</td></tr>}</tbody></table></div></section>
      </div>;
    }
    if (activeView === "staff") {
      return <div className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">ACTIVE HUB ASSIGNMENTS</span><h2>Staff at your assigned hubs</h2></div></div><div className="op-table-wrap"><table className="op-table"><thead><tr><th>Name</th><th>Employee ID</th><th>Role</th><th>Assigned hub</th></tr></thead><tbody>{workspace.staff.map((person) => <tr key={`${person.employeeId}-${person.hubId}`}><td>{person.name}</td><td>{person.employeeId}</td><td>{person.role}</td><td>{person.city} · {person.hubId}</td></tr>)}{workspace.staff.length === 0 && <tr><td className="op-table-empty" colSpan={4}>No active assigned staff records.</td></tr>}</tbody></table></div><p className="op-method-note">Staff and assignments are read-only here. Employee management remains a Company Admin function.</p></div>;
    }
    if (activeView === "routes") {
      return <div className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">CONFIGURED ROUTES</span><h2>Routes touching your assigned hubs</h2></div></div><div className="op-table-wrap"><table className="op-table"><thead><tr><th>Route</th><th>Origin</th><th>Destination</th><th>Mode</th><th>Estimated transit</th><th>Recorded shipments</th><th>Recorded delayed</th></tr></thead><tbody>{workspace.routes.map((route) => <tr key={route.routeId}><td>{route.routeId}</td><td>{route.origin} · {route.originHubId}</td><td>{route.destination} · {route.destinationHubId}</td><td>{route.mode}</td><td>{route.estimatedTransitDays ?? "—"} days</td><td>{count(route.shipments)}</td><td>{count(route.recordedDelayed)}</td></tr>)}{workspace.routes.length === 0 && <tr><td className="op-table-empty" colSpan={7}>No configured routes touch your assigned hubs.</td></tr>}</tbody></table></div><p className="op-method-note">Transit values are route estimates. No live vehicle position or route progress is available.</p></div>;
    }
    if (activeView === "notifications") {
      return <div className="op-content-grid"><section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">LIVE CONNECTION</span><h2>Hub event stream</h2></div><span className={`op-connection-dot ${connection}`} /></div><p className="op-notice">The authenticated stream sends invalidations only for your assigned hub events. The records below are persisted shipment events, not generated notifications.</p><div className="op-attention-list">{notices.map((notice, index) => <div key={`${notice.time}-${index}`}><strong>{notice.type}</strong><span>Workspace reloaded from the backend</span><small>{dateTime(notice.time)}</small></div>)}{notices.length === 0 && <p className="op-empty-inline">No new live events received in this session.</p>}</div></section><section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">PERSISTED SHIPMENT EVENTS</span><h2>Recent recorded activity</h2></div></div><div className="op-attention-list">{workspace.recentEvents.map((event, index) => <button key={`${event.consignmentNo}-${event.eventTime}-${index}`} onClick={() => openShipment(event.consignmentNo)} type="button"><strong>{event.eventType} · {event.consignmentNo}</strong><span>{event.eventStatus}</span><small>{event.hubCity} · {dateTime(event.eventTime)}</small></button>)}{workspace.recentEvents.length === 0 && <p className="op-empty-inline">No recorded shipment events in your assigned hubs.</p>}</div><p className="op-method-note">Persistent notification storage is not part of the existing schema; event history is shown instead.</p></section></div>;
    }
    return (
      <div className="op-report-grid">
        <section className="op-panel op-report-wide"><div className="op-panel-heading"><div><span className="op-eyebrow">BOOKING DATE · LAST 30 DAYS</span><h2>Recorded shipment volume</h2></div></div><div className="op-report-trend">{workspace.volumeTrend.map((row) => <div key={String(row.day)}><span>{count(row.total)}</span><i style={{ height: `${Math.max(2, row.total / maxTrend * 100)}%` }} /><small>{new Date(row.day).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></div>)}</div><p className="op-method-note">Historical booking dates are not live operational throughput.</p></section>
        <section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">RECORDED OUTCOMES</span><h2>Status distribution</h2></div></div><div className="op-report-table"><div className="op-report-row op-report-head"><span>Status</span><span>Shipments</span><span>Share</span></div>{workspace.statusCounts.map((row) => <div className="op-report-row" key={row.status}><span>{row.status}</span><span>{count(row.total)}</span><span>{workspace.kpis.shipments ? `${(row.total / workspace.kpis.shipments * 100).toFixed(1)}%` : "—"}</span></div>)}</div><p className="op-method-note">“Delayed” is a recorded delivery outcome, not proof of a currently late shipment.</p></section>
        <section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">ROUTE PERFORMANCE</span><h2>Recorded route data</h2></div></div><div className="op-report-table"><div className="op-report-row op-report-head"><span>Route</span><span>Shipments</span><span>Delayed</span></div>{workspace.routes.slice(0, 12).map((route) => <div className="op-report-row" key={route.routeId}><span>{route.routeId}</span><span>{count(route.shipments)}</span><span>{count(route.recordedDelayed)}</span></div>)}</div></section>
      </div>
    );
  }

  if (workspaceLoading && !workspace) return <div className="op-desktop"><div className="op-loading">Loading your authorized hub data…</div></div>;
  if (error) return <div className="op-desktop"><div className="op-error" role="alert">{error}</div></div>;
  if (!workspace || !employee) return null;
  if (!hasHubs) {
    return <div className="op-desktop"><section className="op-empty-state"><span className="op-empty-mark" aria-hidden="true">⌖</span><h2>No active hub assignments</h2><p>Your Company Admin must assign at least one active hub before hub operations are available. No company-wide shipment data is shown.</p></section></div>;
  }

  return (
    <div className="op-desktop">
      <aside className="op-sidebar">
        <div className="op-sidebar-top"><span className="op-sidebar-kicker">HUB OPERATIONS</span><h2>{employee.company.name}</h2><p>{workspace.hubs.length} authorized hub{workspace.hubs.length === 1 ? "" : "s"}</p></div>
        <nav aria-label="Hub Manager workspace">{navigation.map((item) => <button className={activeView === item.id ? "active" : ""} key={item.id} onClick={() => goTo(item.id)} type="button"><span aria-hidden="true">{item.icon}</span>{item.label}{item.id === "inbound" && workspace.kpis.inboundPending > 0 && <b>{count(workspace.kpis.inboundPending)}</b>}</button>)}</nav>
        <div className="op-sidebar-footer"><i className={`op-connection-dot ${connection}`} />{connection === "connected" ? "Live hub stream connected" : "Reconnecting to hub stream"}</div>
      </aside>
      <main className="op-main">
        <header className="op-topbar"><div><span className="op-eyebrow">HUB MANAGER WORKSPACE</span><h1>{title}</h1></div><div className="op-topbar-meta"><span className="op-snapshot-badge"><i />Authenticated · hub scoped</span><span>{employee.name}</span></div></header>
        <section className="op-page">
          {activeView === "overview" && <p className="op-notice">Live shipment actions appear only after a real tracking ID, company route, assigned hub and valid event lifecycle have all been verified by the backend.</p>}
          {renderContent()}
        </section>
      </main>
      {selectedId && (
        <div className="op-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }} role="presentation">
          <section aria-labelledby="hub-shipment-title" aria-modal="true" className="op-modal" role="dialog">
            <header><div><span className="op-eyebrow">AUTHORIZED SHIPMENT INSPECTION</span><h2 id="hub-shipment-title">{detail?.consignmentNo ?? selectedId}</h2></div><button aria-label="Close shipment details" onClick={() => setSelectedId(null)} type="button">×</button></header>
            <div className="op-modal-content">
              {detailError && <p className="op-error" role="alert">{detailError}</p>}
              {!detail && !detailError && <p className="op-empty-inline">Loading authorized shipment records…</p>}
              {detail && <>
                <div className="op-detail-grid">
                  <div><span>Customer / recipient</span><strong>{detail.recipientName || "Unavailable"}</strong></div>
                  <div><span>Recorded status</span><strong>{detail.status}</strong></div>
                  <div><span>Current hub</span><strong>{detail.events[0]?.city ?? "No hub event recorded"}</strong></div>
                  <div><span>Pickup executive</span><strong>{detail.originExecutiveNames || "Not assigned"}</strong></div>
                  <div><span>Delivery executive</span><strong>{detail.destinationExecutiveNames || "Not assigned"}</strong></div>
                  <div><span>Recorded route</span><strong>{detail.origin} → {detail.destination}</strong></div>
                  <div><span>Route ID / mode</span><strong>{detail.routeId ?? "Unavailable"} · {detail.mode}</strong></div>
                  <div><span>Booking date</span><strong>{String(detail.shipmentDate).slice(0, 10)}</strong></div>
                  <div><span>Last recorded event</span><strong>{detail.events[0]?.eventType ?? "No events recorded"}</strong></div>
                  <div><span>Last event time</span><strong>{dateTime(detail.events[0]?.eventTime)}</strong></div>
                </div>
                <ShipmentQrCode consignmentNo={detail.consignmentNo} />
                <h3 className="op-history-title">Recorded event history</h3>
                {detail.events.length === 0 ? <p className="op-empty-inline">No scan/event history is stored for this shipment.</p> : <div className="op-detail-history">{detail.events.map((event, index) => <div key={`${event.eventTime}-${event.eventType}-${index}`}><i /><strong>{event.eventType}</strong><small>{event.eventStatus} · {event.city ?? "Hub unavailable"} · {dateTime(event.eventTime)}{event.employeeName ? ` · ${event.employeeName}` : ""}</small></div>)}</div>}
                {isActionView && (activeView === "inbound"
                  ? ["DISPATCHED", "HANDED_OVER_AT_ORIGIN_HUB", "ARRIVED_AT_ORIGIN_HUB", "ARRIVED_AT_DESTINATION_HUB"].includes(detail.events[0]?.eventType ?? "")
                  : detail.events[0]?.eventType === "RECEIVED_AT_ORIGIN_HUB") && (
                  <div className="op-action-confirm">
                    <p>Scan the shipment QR or enter the exact tracking ID after verifying the current physical handoff.</p>
                    <ShipmentQrScanner onResolve={resolveHubQr} />
                    <label className="op-filter"><span>Tracking ID confirmation</span><input autoComplete="off" onChange={(event) => setVerifiedTrackingId(event.target.value)} value={verifiedTrackingId} /></label>
                    {activeView === "inbound" && ["DISPATCHED", "HANDED_OVER_AT_ORIGIN_HUB"].includes(detail.events[0]?.eventType ?? "") && <button className="op-button-primary" disabled={actionLoading || verifiedTrackingId.trim() !== detail.consignmentNo} onClick={() => void performAction("arrive")} type="button">{actionLoading ? "Recording…" : "Confirm arrival"}</button>}
                    {activeView === "inbound" && ["ARRIVED_AT_ORIGIN_HUB", "ARRIVED_AT_DESTINATION_HUB"].includes(detail.events[0]?.eventType ?? "") && <button className="op-button-primary" disabled={actionLoading || verifiedTrackingId.trim() !== detail.consignmentNo} onClick={() => void performAction("receive")} type="button">{actionLoading ? "Recording…" : "Confirm physical receipt"}</button>}
                    {activeView === "outbound" && detail.events[0]?.eventType === "RECEIVED_AT_ORIGIN_HUB" && <button className="op-button-primary" disabled={actionLoading || verifiedTrackingId.trim() !== detail.consignmentNo} onClick={() => void performAction("dispatch")} type="button">{actionLoading ? "Recording…" : "Confirm dispatch"}</button>}
                    {actionError && <p className="op-error" role="alert">{actionError}</p>}
                  </div>
                )}
              </>}
            </div>
          </section>
        </div>
      )}
      {assignmentShipment && (
        <div className="op-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !assignmentSaving) setAssignmentShipment(null); }} role="presentation">
          <section aria-labelledby="queue-assignment-title" aria-modal="true" className="op-modal" role="dialog">
            <header><div><span className="op-eyebrow">ASSIGN FROM HUB QUEUE</span><h2 id="queue-assignment-title">{assignmentShipment.consignmentNo}</h2></div><button aria-label="Close assignment" disabled={assignmentSaving} onClick={() => setAssignmentShipment(null)} type="button">×</button></header>
            <div className="op-modal-content">
              <div className="op-detail-grid">
                <div><span>Customer / recipient</span><strong>{assignmentShipment.recipientName || "Unavailable"}</strong></div>
                <div><span>Route</span><strong>{assignmentShipment.origin} → {assignmentShipment.destination}</strong></div>
                <div><span>Current hub</span><strong>{assignmentShipment.currentHubCity ?? assignmentShipment.origin}</strong></div>
                <div><span>Shipment status</span><strong>{assignmentShipment.operationalState?.replaceAll("_", " ")}</strong></div>
                <div><span>Required task</span><strong>{assignmentShipment.requiredTaskType}</strong></div>
                <div><span>Next action</span><strong>{assignmentShipment.nextAction}</strong></div>
              </div>
              <form className="le-assign-form" onSubmit={(event) => void assignFromQueue(event)}>
                <label><span>Eligible executive at {assignmentShipment.requiredTaskType === "PICKUP" ? assignmentShipment.origin : assignmentShipment.destination}</span>
                  <select required value={assignmentEmployeeId} onChange={(event) => setAssignmentEmployeeId(event.target.value)}><option value="">Select executive</option>{workspace.staff.filter((person) => person.role === "LOGISTICS_EXECUTIVE" && person.hubId === (assignmentShipment.requiredTaskType === "PICKUP" ? assignmentShipment.originHubId : assignmentShipment.destinationHubId)).map((person) => <option key={person.employeeId} value={person.employeeId}>{person.name} · {person.employeeId}</option>)}</select>
                </label>
                {assignmentError && <p className="op-error" role="alert">{assignmentError}</p>}
                <button className="op-button-primary" disabled={assignmentSaving || !assignmentEmployeeId} type="submit">{assignmentSaving ? "Assigning…" : "Confirm assignment"}</button>
              </form>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
