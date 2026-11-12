import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { authenticatedFetch, useAuth } from "./auth";

type OperationsView =
  | "overview"
  | "shipments"
  | "hubs"
  | "exceptions"
  | "team"
  | "routes"
  | "notifications"
  | "reports"
  | "booking-requests";

type OperationsWorkspace = {
  scope: { assignedHubCount: number; shipmentVisibility: string };
  hubs: Array<{ id: string; city: string }>;
  kpis: {
    totalShipments: number;
    inTransit: number;
    delayed: number;
    approachingSla: number;
    staleTracking: number;
  };
  statuses: Array<{ status: string; shipments: number }>;
  trend: Array<{ day: string; shipments: number }>;
  hubWorkload: Array<{
    id: string;
    city: string;
    shipments: number;
    active: number;
    delayed: number;
    eligibleDelivered: number;
    historicalDelayPercent: number | null;
  }>;
  routes: Array<{
    id: string;
    mode: string;
    shipments: number;
    delayed: number;
    eligibleDelivered: number;
    historicalDelayPercent: number | null;
  }>;
  team: Array<{ employeeId: string; name: string; role: string; hubId: string; city: string }>;
  exceptions: Array<{
    consignmentNo: string;
    status: string;
    slaDueDate: string | null;
    lastEventAt: string | null;
    lastLocation: string | null;
    reason: string;
    priority: number;
  }>;
  capabilities: { taskAssignments: boolean; notifications: boolean; shipmentActions: boolean };
};

type OperationsShipment = {
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
};

type ShipmentDetail = OperationsShipment & {
  events: Array<{
    eventTime: string;
    eventType: string | null;
    eventStatus: string | null;
    hubId: string | null;
    city: string | null;
  }>;
};
type BookingRequest = { bookingRequestId: number; customerName: string; requestedAt: string; originHubId: string; originCity: string; destinationHubId: string; destinationCity: string; mode: string; pieces: number; weightKg: number; senderName: string; senderPhone: string; senderAddress: string; senderCity: string; senderState: string; senderPincode: string; recipientName: string; recipientPhone: string; recipientAddress: string; recipientCity: string; recipientState: string; recipientPincode: string; baseCharge?: number | string | null; weightCharge?: number | string | null; serviceCharge?: number | string | null; taxAmount?: number | string | null; minimumAdjustment?: number | string | null; totalCharge?: number | string | null; chargePayer?: string | null; collectionMethod?: string | null; paymentStatus?: string | null; paymentMode?: string | null; transactionReference?: string | null };

const navigation: Array<{ id: OperationsView; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "◫" },
  { id: "shipments", label: "Shipments", icon: "▣" },
  { id: "booking-requests", label: "Booking Approvals", icon: "✓" },
  { id: "hubs", label: "My Hubs", icon: "⌖" },
  { id: "exceptions", label: "Delays & Exceptions", icon: "△" },
  { id: "team", label: "Team & Assignments", icon: "♧" },
  { id: "routes", label: "Routes", icon: "⌁" },
  { id: "notifications", label: "Notifications", icon: "♧" },
  { id: "reports", label: "Reports & Analytics", icon: "▥" },
];

function asView(value: string | null): OperationsView {
  return navigation.find((item) => item.id === value)?.id ?? "overview";
}

function formatCount(value: number): string {
  return value.toLocaleString("en-IN");
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "No event recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="op-filter">
      <span>{label}</span>
      <input onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} />
    </label>
  );
}

export function OperationsDashboard() {
  const { employee } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView = asView(searchParams.get("view"));
  const [workspace, setWorkspace] = useState<OperationsWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [eventStatus, setEventStatus] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [eventNotices, setEventNotices] = useState<Array<{ type: string; time: string }>>([]);
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [filterStatus, setFilterStatus] = useState(searchParams.get("status") ?? "");
  const [filterHub, setFilterHub] = useState(searchParams.get("hubId") ?? "");
  const [filterOrigin, setFilterOrigin] = useState(searchParams.get("origin") ?? "");
  const [filterDestination, setFilterDestination] = useState(searchParams.get("destination") ?? "");
  const [filterMode, setFilterMode] = useState(searchParams.get("mode") ?? "");
  const [filterRisk, setFilterRisk] = useState(searchParams.get("risk") ?? "");
  const [page, setPage] = useState(Number(searchParams.get("page") ?? "1"));
  const [pageSize, setPageSize] = useState(25);
  const [sortBy, setSortBy] = useState("shipmentDate");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [shipments, setShipments] = useState<OperationsShipment[]>([]);
  const [shipmentTotal, setShipmentTotal] = useState(0);
  const [shipmentLoading, setShipmentLoading] = useState(false);
  const [shipmentError, setShipmentError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShipmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [bookingRequests, setBookingRequests] = useState<BookingRequest[]>([]);
  const [bookingLoading, setBookingLoading] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [bookingActionId, setBookingActionId] = useState<number | null>(null);

  useEffect(() => {
    setSearch(searchParams.get("q") ?? "");
    setFilterStatus(searchParams.get("status") ?? "");
    setFilterHub(searchParams.get("hubId") ?? "");
    setFilterOrigin(searchParams.get("origin") ?? "");
    setFilterDestination(searchParams.get("destination") ?? "");
    setFilterMode(searchParams.get("mode") ?? "");
    setFilterRisk(searchParams.get("risk") ?? "");
    setPage(Number(searchParams.get("page") ?? "1"));
  }, [searchParams]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    authenticatedFetch("/api/operations/workspace", {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as OperationsWorkspace & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Operations workspace could not be loaded.");
        return payload;
      })
      .then(setWorkspace)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Operations workspace could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    const source = new EventSource("/api/operations/events");
    source.onopen = () => setEventStatus("connected");
    source.onerror = () => setEventStatus("reconnecting");
    const refresh = (event: Event) => {
      const message = event as MessageEvent<{ type?: string }>;
      const type = message.data?.type ?? "workspace update";
      setEventNotices((items) => [{ type, time: new Date().toISOString() }, ...items].slice(0, 20));
      setReloadKey((value) => value + 1);
    };
    source.addEventListener("workspace-invalidated", refresh);
    source.addEventListener("recovery-required", refresh);
    return () => source.close();
  }, []);

  useEffect(() => {
    if (activeView !== "shipments") return;
    const controller = new AbortController();
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      search: searchParams.get("q") ?? "",
      status: searchParams.get("status") ?? "",
      hubId: searchParams.get("hubId") ?? "",
      origin: searchParams.get("origin") ?? "",
      destination: searchParams.get("destination") ?? "",
      mode: searchParams.get("mode") ?? "",
      risk: searchParams.get("risk") ?? "",
      sortBy,
      direction,
    });
    setShipmentLoading(true);
    setShipmentError(null);
    authenticatedFetch(`/api/operations/shipments?${query}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as {
          shipments?: OperationsShipment[];
          total?: number;
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Shipments could not be loaded.");
        return payload;
      })
      .then((payload) => {
        setShipments(payload.shipments ?? []);
        setShipmentTotal(payload.total ?? 0);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setShipmentError(caught instanceof Error ? caught.message : "Shipments could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setShipmentLoading(false);
      });
    return () => controller.abort();
  }, [activeView, direction, page, pageSize, reloadKey, searchParams, sortBy]);

  useEffect(() => {
    if (activeView !== "booking-requests") return;
    const controller = new AbortController();
    setBookingLoading(true); setBookingError(null);
    authenticatedFetch("/api/operations/booking-requests", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => { const payload = await response.json() as { bookingRequests?: BookingRequest[]; error?: string }; if (!response.ok) throw new Error(payload.error ?? "Booking requests could not be loaded."); return payload.bookingRequests ?? []; })
      .then(setBookingRequests)
      .catch((caught: unknown) => { if (!(caught instanceof DOMException && caught.name === "AbortError")) setBookingError(caught instanceof Error ? caught.message : "Booking requests could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setBookingLoading(false); });
    return () => controller.abort();
  }, [activeView, reloadKey]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    authenticatedFetch(`/api/operations/shipments/${encodeURIComponent(selectedId)}/events`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as { shipment?: ShipmentDetail; error?: string };
        if (!response.ok || !payload.shipment) throw new Error(payload.error ?? "Shipment details could not be loaded.");
        return payload.shipment;
      })
      .then(setDetail)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setDetailError(caught instanceof Error ? caught.message : "Shipment details could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId, reloadKey]);

  useEffect(() => {
    if (!selectedId) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setSelectedId(null);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [selectedId]);

  const title = navigation.find((item) => item.id === activeView)?.label ?? "Overview";
  const maxTrend = useMemo(() => Math.max(1, ...(workspace?.trend.map((item) => item.shipments) ?? [])), [workspace]);

  function goTo(view: OperationsView, extra?: Record<string, string>) {
    setMobileNavOpen(false);
    setPage(1);
    setSearchParams({ view, ...extra });
  }

  function applyFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    const next: Record<string, string> = { view: "shipments" };
    if (search.trim()) next.q = search.trim();
    if (filterStatus) next.status = filterStatus;
    if (filterHub) next.hubId = filterHub;
    if (filterOrigin.trim()) next.origin = filterOrigin.trim();
    if (filterDestination.trim()) next.destination = filterDestination.trim();
    if (filterMode.trim()) next.mode = filterMode.trim();
    if (filterRisk) next.risk = filterRisk;
    setSearchParams(next);
  }

  function sort(column: string) {
    if (sortBy === column) setDirection((value) => value === "asc" ? "desc" : "asc");
    else {
      setSortBy(column);
      setDirection("asc");
    }
  }

  async function decideBooking(requestId: number, action: "approve" | "reject") {
    const reason = action === "reject" ? window.prompt("Enter the reason for rejecting this booking request:")?.trim() : undefined;
    if (action === "reject" && (!reason || reason.length < 5)) return;
    setBookingActionId(requestId); setBookingError(null);
    try {
      const response = await authenticatedFetch(`/api/operations/booking-requests/${requestId}/${action}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "reject" ? { reason } : {}) });
      const payload = await response.json() as { error?: string; result?: { consignmentNo?: string } };
      if (!response.ok) throw new Error(payload.error ?? `Booking could not be ${action}d.`);
      setBookingRequests((items) => items.filter((item) => item.bookingRequestId !== requestId));
      if (payload.result?.consignmentNo) setEventNotices((items) => [{ type: `Booking approved · ${payload.result!.consignmentNo}`, time: new Date().toISOString() }, ...items].slice(0, 20));
      setReloadKey((value) => value + 1);
    } catch (caught) { setBookingError(caught instanceof Error ? caught.message : "Booking review failed."); }
    finally { setBookingActionId(null); }
  }

  function renderBookingRequests() {
    return <section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">CUSTOMER BOOKINGS</span><h2>Pending approval</h2></div><span className="op-status-pill">{bookingRequests.length} pending</span></div><p className="op-method-note">Approval creates the official consignment number and active shipment exactly once. Rejection leaves the request visible to its customer with the saved reason.</p>{bookingError && <p className="op-error" role="alert">{bookingError}</p>}{bookingLoading && bookingRequests.length === 0 ? <p className="op-empty-inline">Loading pending booking requests…</p> : <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Request</th><th>Customer</th><th>Origin → destination</th><th>Service / parcel</th><th>Shipping charge</th><th>Requested</th><th>Review</th></tr></thead><tbody>{bookingRequests.map((item) => <tr key={item.bookingRequestId}><td>BR-{item.bookingRequestId}<small>{item.originHubId}</small></td><td>{item.customerName}<small>Sender: {item.senderName} · {item.senderPhone}</small><details><summary>Sender and recipient details</summary><small>Sender: {item.senderAddress}, {item.senderCity}, {item.senderState} {item.senderPincode}</small><small>Recipient: {item.recipientName} · {item.recipientPhone}</small><small>{item.recipientAddress}, {item.recipientCity}, {item.recipientState} {item.recipientPincode}</small></details></td><td>{item.originCity} → {item.destinationCity}<small>{item.originHubId} → {item.destinationHubId}</small></td><td>{item.mode}<small>{item.pieces} piece(s) · {item.weightKg} kg</small></td><td>{item.totalCharge == null ? "Price to be confirmed" : `₹${Number(item.totalCharge).toFixed(2)}`}<small>{item.chargePayer ? `${item.chargePayer} pays` : "Payer not set"} · {item.collectionMethod ?? "No method"}</small><small>{item.paymentStatus ?? "NOT_REQUIRED"}{item.transactionReference ? ` · ${item.transactionReference}` : ""}</small></td><td>{formatDateTime(item.requestedAt)}</td><td><button className="op-button-primary" disabled={bookingActionId !== null} onClick={() => void decideBooking(item.bookingRequestId, "approve")} type="button">{bookingActionId === item.bookingRequestId ? "Saving…" : "Approve"}</button> <button className="op-button" disabled={bookingActionId !== null} onClick={() => void decideBooking(item.bookingRequestId, "reject")} type="button">Reject</button></td></tr>)}{!bookingLoading && bookingRequests.length === 0 && <tr><td className="op-table-empty" colSpan={7}>No pending customer booking requests for your assigned hubs.</td></tr>}</tbody></table></div>}</section>;
  }

  function renderOverview() {
    if (!workspace) return null;
    const cards = [
      { label: "In-scope shipments", value: workspace.kpis.totalShipments, view: "shipments" as const, hint: "Origin, destination or latest recorded event at your hubs" },
      { label: "In transit", value: workspace.kpis.inTransit, view: "shipments" as const, risk: "active", hint: "Non-terminal recorded statuses" },
      { label: "Delayed / overdue", value: workspace.kpis.delayed, view: "exceptions" as const, hint: "Recorded delayed or past recorded SLA date" },
      { label: "Approaching SLA", value: workspace.kpis.approachingSla, view: "exceptions" as const, hint: "SLA due within two days" },
      { label: "Stale tracking", value: workspace.kpis.staleTracking, view: "exceptions" as const, hint: "Latest recorded event older than 48 hours" },
    ];
    return (
      <>
        <div className="op-kpis">
          {cards.map((card) => (
            <button
              className="op-kpi"
              key={card.label}
              onClick={() => goTo(card.view, "risk" in card && card.risk ? { risk: card.risk } : card.label === "Delayed / overdue" ? { risk: "delayed" } : card.label === "Approaching SLA" ? { risk: "approaching" } : card.label === "Stale tracking" ? { risk: "stale" } : {})}
              type="button"
            >
              <span>{card.label}</span>
              <strong>{loading ? "—" : formatCount(card.value)}</strong>
              <small>{card.hint}</small>
            </button>
          ))}
        </div>
        <div className="op-content-grid">
          <section className="op-panel op-trend-panel">
            <div className="op-panel-heading"><div><span className="op-eyebrow">LAST 30 DAYS · BOOKING DATE</span><h2>Shipment volume</h2></div><button className="op-link" onClick={() => goTo("reports")} type="button">View reports →</button></div>
            {workspace.trend.length === 0
              ? <p className="op-empty-inline">No shipment trend data in this hub scope.</p>
              : <div aria-label="Shipment volume by booking date" className="op-trend" role="img">
                  {workspace.trend.map((item) => (
                    <div className="op-trend-column" key={item.day} title={`${formatDate(item.day)}: ${item.shipments} shipments`}>
                      <span style={{ height: `${Math.max(3, item.shipments / maxTrend * 100)}%` }} />
                      <small>{new Date(`${item.day}T00:00:00`).getDate()}</small>
                    </div>
                  ))}
                </div>}
          </section>
          <section className="op-panel">
            <div className="op-panel-heading"><div><span className="op-eyebrow">ASSIGNED LOCATIONS</span><h2>Hub workload</h2></div><button className="op-link" onClick={() => goTo("hubs")} type="button">All hubs →</button></div>
            <div className="op-hub-bars">
              {workspace.hubWorkload.map((hub) => (
                <button className="op-hub-bar" key={hub.id} onClick={() => goTo("shipments", { hubId: hub.id })} type="button">
                  <span className="op-hub-bar-label"><strong>{hub.city}</strong><small>{hub.id}</small><b>{formatCount(hub.shipments)}</b></span>
                  <span className="op-bar-track"><i style={{ width: `${Math.max(2, hub.shipments / Math.max(1, ...workspace.hubWorkload.map((item) => item.shipments)) * 100)}%` }} /></span>
                  <small>{formatCount(hub.active)} active · {formatCount(hub.delayed)} delayed/overdue</small>
                </button>
              ))}
            </div>
          </section>
          <section className="op-panel">
            <div className="op-panel-heading"><div><span className="op-eyebrow">RECORDED STATUS</span><h2>Status distribution</h2></div><button className="op-link" onClick={() => goTo("shipments")} type="button">Shipments →</button></div>
            <div className="op-status-list">
              {workspace.statuses.map((item) => (
                <button className="op-status-row" key={item.status} onClick={() => goTo("shipments", { status: item.status })} type="button">
                  <span>{item.status}</span><i><b style={{ width: `${Math.max(1, item.shipments / Math.max(1, workspace.kpis.totalShipments) * 100)}%` }} /></i><strong>{formatCount(item.shipments)}</strong>
                </button>
              ))}
            </div>
          </section>
          <section className="op-panel op-attention-panel">
            <div className="op-panel-heading"><div><span className="op-eyebrow">PRIORITIZED FROM RECORDS</span><h2>Needs attention</h2></div><button className="op-link" onClick={() => goTo("exceptions")} type="button">View all →</button></div>
            {workspace.exceptions.length === 0
              ? <p className="op-empty-inline">No current rule-based delay or stale-tracking flags in your hub scope.</p>
              : <div className="op-attention-list">{workspace.exceptions.slice(0, 5).map((item) => (
                  <button key={item.consignmentNo} onClick={() => { setSelectedId(item.consignmentNo); }} type="button">
                    <strong>{item.consignmentNo}</strong><span>{item.reason}</span><small>{item.lastLocation ?? "Location unavailable"} · {formatDateTime(item.lastEventAt)}</small>
                  </button>
                ))}</div>}
          </section>
        </div>
      </>
    );
  }

  function renderShipments() {
    const pages = Math.max(1, Math.ceil(shipmentTotal / pageSize));
    return (
      <>
        <form className="op-filters" onSubmit={applyFilters}>
          <FilterInput label="Consignment ID" onChange={setSearch} placeholder="Search tracking ID" value={search} />
          <label className="op-filter"><span>Status</span><select onChange={(event) => setFilterStatus(event.target.value)} value={filterStatus}><option value="">Any status</option>{(workspace?.statuses ?? []).map((row) => <option key={row.status}>{row.status}</option>)}</select></label>
          <label className="op-filter"><span>Assigned/current hub</span><select onChange={(event) => setFilterHub(event.target.value)} value={filterHub}><option value="">All my hubs</option>{workspace?.hubs.map((hub) => <option key={hub.id} value={hub.id}>{hub.city} · {hub.id}</option>)}</select></label>
          <FilterInput label="Origin city" onChange={setFilterOrigin} value={filterOrigin} />
          <FilterInput label="Destination city" onChange={setFilterDestination} value={filterDestination} />
          <FilterInput label="Mode" onChange={setFilterMode} placeholder="Air, surface…" value={filterMode} />
          <label className="op-filter"><span>Risk</span><select onChange={(event) => setFilterRisk(event.target.value)} value={filterRisk}><option value="">Any risk</option><option value="active">In transit</option><option value="delayed">Delayed / overdue</option><option value="approaching">Approaching SLA</option><option value="stale">Stale tracking</option></select></label>
          <button className="op-button-primary" type="submit">Apply filters</button>
        </form>
        <div className="op-table-meta" aria-live="polite">{shipmentLoading ? "Loading scoped shipments…" : `${formatCount(shipmentTotal)} shipments in this view`}</div>
        {shipmentError && <p className="op-error" role="alert">{shipmentError}</p>}
        <div className="op-table-wrap">
          <table className="op-table">
            <thead><tr>
              <th><button onClick={() => sort("consignmentNo")} type="button">Consignment</button></th>
              <th>Route</th><th>Hub IDs</th><th>Mode</th>
              <th><button onClick={() => sort("status")} type="button">Status</button></th>
              <th><button onClick={() => sort("shipmentDate")} type="button">Booked</button></th>
              <th><button onClick={() => sort("expectedDeliveryDate")} type="button">Estimated delivery</button></th>
            </tr></thead>
            <tbody>
              {!shipmentLoading && shipments.length === 0
                ? <tr><td className="op-table-empty" colSpan={7}>No shipment records match this scope and filter.</td></tr>
                : shipments.map((shipment) => (
                    <tr key={shipment.consignmentNo}>
                      <td><button className="op-row-link" onClick={() => setSelectedId(shipment.consignmentNo)} type="button">{shipment.consignmentNo}</button><small>{shipment.customerName ?? "Customer unavailable"}</small></td>
                      <td>{shipment.origin ?? "—"} → {shipment.destination ?? "—"}</td>
                      <td>{shipment.originHubId} → {shipment.destinationHubId}</td>
                      <td>{shipment.mode}</td>
                      <td><span className={`op-status-pill ${shipment.status.toLowerCase().includes("delay") ? "is-risk" : ""}`}>{shipment.status}</span></td>
                      <td>{formatDate(shipment.shipmentDate)}</td>
                      <td>{shipment.expectedDeliveryDate ? formatDate(shipment.expectedDeliveryDate) : "Not recorded"}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        <div className="op-pagination"><span>Page {page} of {pages} · {formatCount(shipmentTotal)} results</span><div><button className="op-button" disabled={page <= 1 || shipmentLoading} onClick={() => { const nextPage = Math.max(1, page - 1); setPage(nextPage); setSearchParams((current) => { const next = new URLSearchParams(current); next.set("page", String(nextPage)); return next; }); }} type="button">Previous</button><button className="op-button" disabled={page >= pages || shipmentLoading} onClick={() => { const nextPage = page + 1; setPage(nextPage); setSearchParams((current) => { const next = new URLSearchParams(current); next.set("page", String(nextPage)); return next; }); }} type="button">Next</button><select aria-label="Rows per page" onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} value={pageSize}><option value={25}>25 rows</option><option value={50}>50 rows</option><option value={100}>100 rows</option></select></div></div>
      </>
    );
  }

  function renderHubs() {
    if (!workspace) return null;
    return <div className="op-hub-grid">{workspace.hubWorkload.map((hub) => (
      <article className="op-hub-card" key={hub.id}>
        <div className="op-hub-card-title"><span className="op-hub-symbol">⌖</span><div><h2>{hub.city}</h2><small>{hub.id}</small></div></div>
        <div className="op-hub-metrics"><div><strong>{formatCount(hub.shipments)}</strong><span>In-scope shipments</span></div><div><strong>{formatCount(hub.active)}</strong><span>Active status</span></div><div><strong>{formatCount(hub.delayed)}</strong><span>Delayed / overdue</span></div><div><strong>{hub.historicalDelayPercent === null ? "—" : `${hub.historicalDelayPercent}%`}</strong><span>Historical SLA delays · delivered with transit data</span></div></div>
        <button className="op-button" onClick={() => goTo("shipments", { hubId: hub.id })} type="button">Inspect hub shipments →</button>
      </article>
    ))}</div>;
  }

  function renderExceptions() {
    if (!workspace) return null;
    const riskFilter = searchParams.get("risk") ?? "";
    const filteredExceptions = workspace.exceptions.filter((item) => {
      if (riskFilter === "delayed") return item.priority <= 2;
      if (riskFilter === "approaching") return item.priority === 3;
      if (riskFilter === "stale") return item.priority === 4;
      return true;
    });
    return (
      <>
        <div className="op-notice">Priorities use recorded status, recorded SLA due dates, and latest shipment-event timestamps. Stale tracking is a derived 48-hour rule, not an external live-feed alert.</div>
        {riskFilter && <button className="op-button" onClick={() => goTo("exceptions")} type="button">Clear KPI filter</button>}
        <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Priority</th><th>Consignment</th><th>Reason</th><th>Recorded status</th><th>SLA due</th><th>Last event / location</th><th /></tr></thead>
          <tbody>{filteredExceptions.length === 0 ? <tr><td className="op-table-empty" colSpan={7}>No flagged shipment records are available for this filter in your assigned hub scope.</td></tr> : filteredExceptions.map((item) => <tr key={item.consignmentNo}><td><span className={`op-priority priority-${item.priority}`}>{item.priority <= 2 ? "High" : item.priority === 3 ? "Watch" : "Stale"}</span></td><td>{item.consignmentNo}</td><td>{item.reason}</td><td>{item.status}</td><td>{formatDate(item.slaDueDate)}</td><td>{item.lastLocation ?? "—"}<small>{formatDateTime(item.lastEventAt)}</small></td><td><button className="op-row-link" onClick={() => setSelectedId(item.consignmentNo)} type="button">Inspect</button></td></tr>)}</tbody>
        </table></div>
      </>
    );
  }

  function renderTeam() {
    if (!workspace) return null;
    return (
      <>
        <div className="op-notice">Read-only directory of active staff with active assignments to one or more of your hubs. Task assignments are not available in the current system, and this role cannot edit employee or hub assignments.</div>
        <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Team member</th><th>Role</th><th>Assigned hub</th><th>City</th></tr></thead><tbody>{workspace.team.length === 0 ? <tr><td className="op-table-empty" colSpan={4}>No active staff assignments are recorded for your hubs.</td></tr> : workspace.team.map((member) => <tr key={`${member.employeeId}-${member.hubId}`}><td>{member.name}<small>{member.employeeId}</small></td><td>{member.role.replaceAll("_", " ")}</td><td>{member.hubId}</td><td>{member.city}</td></tr>)}</tbody></table></div>
      </>
    );
  }

  function renderRoutes() {
    if (!workspace) return null;
    return <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Route ID</th><th>Mode</th><th>In-scope shipments</th><th>Delayed / overdue</th><th>Historical SLA delay</th></tr></thead><tbody>{workspace.routes.length === 0 ? <tr><td className="op-table-empty" colSpan={5}>No route-linked shipments are available in your hub scope.</td></tr> : workspace.routes.map((route) => <tr key={route.id}><td>{route.id}</td><td>{route.mode}</td><td>{formatCount(route.shipments)}</td><td>{formatCount(route.delayed)}</td><td>{route.historicalDelayPercent === null ? "—" : `${route.historicalDelayPercent}% of eligible delivered shipments`}</td></tr>)}</tbody></table></div>;
  }

  function renderNotifications() {
    return (
      <>
        <div className="op-notice">This is an in-session feed of authenticated backend update events. No persistent notification table, external courier feed, or shipment-write workflow is currently configured; no synthetic notifications are generated.</div>
        <div className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">SERVER-SENT EVENTS</span><h2>Connection {eventStatus}</h2></div><span className={`op-connection-dot ${eventStatus}`} /></div>
          {eventNotices.length === 0 ? <p className="op-empty-inline">No backend updates have been received during this session.</p> : <div className="op-attention-list">{eventNotices.map((notice, index) => <div key={`${notice.time}-${index}`}><strong>{notice.type.replaceAll(".", " ")}</strong><span>Authenticated company workspace data was invalidated.</span><small>{formatDateTime(notice.time)}</small></div>)}</div>}
        </div>
      </>
    );
  }

  function renderReports() {
    if (!workspace) return null;
    const max = Math.max(1, ...workspace.hubWorkload.map((hub) => hub.shipments));
    return (
      <div className="op-report-grid">
        <section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">ASSIGNED HUB COMPARISON</span><h2>Shipment volume by hub</h2></div></div><div className="op-hub-bars">{workspace.hubWorkload.map((hub) => <div className="op-hub-bar" key={hub.id}><span className="op-hub-bar-label"><strong>{hub.city}</strong><small>{hub.id}</small><b>{formatCount(hub.shipments)}</b></span><span className="op-bar-track"><i style={{ width: `${Math.max(2, hub.shipments / max * 100)}%` }} /></span></div>)}</div></section>
        <section className="op-panel"><div className="op-panel-heading"><div><span className="op-eyebrow">STATUS MIX</span><h2>Recorded shipment status</h2></div></div><div className="op-status-list">{workspace.statuses.map((item) => <div className="op-status-row" key={item.status}><span>{item.status}</span><i><b style={{ width: `${Math.max(1, item.shipments / Math.max(1, workspace.kpis.totalShipments) * 100)}%` }} /></i><strong>{formatCount(item.shipments)}</strong></div>)}</div></section>
        <section className="op-panel op-report-wide"><div className="op-panel-heading"><div><span className="op-eyebrow">BOOKING DATE · LAST 30 DAYS</span><h2>Shipment volume trend</h2></div></div><div className="op-report-trend">{workspace.trend.map((item) => <div key={item.day}><span>{item.shipments}</span><i style={{ height: `${Math.max(3, item.shipments / maxTrend * 100)}%` }} /><small>{formatDate(item.day)}</small></div>)}</div><p className="op-method-note">Counts are bookings by shipment date within the assigned hub scope. This is a historical database snapshot, not a live vehicle or courier-feed view.</p></section>
        <section className="op-panel op-report-wide"><div className="op-panel-heading"><div><span className="op-eyebrow">DELIVERED RECORDS WITH TRANSIT DATA</span><h2>Historical SLA delay by hub</h2></div></div><div className="op-report-table"><div className="op-report-row op-report-head"><span>Hub</span><span>Eligible delivered</span><span>Historical SLA delay</span></div>{workspace.hubWorkload.map((hub) => <div className="op-report-row" key={hub.id}><span>{hub.city} · {hub.id}</span><span>{formatCount(hub.eligibleDelivered)}</span><span>{hub.historicalDelayPercent === null ? "Not enough recorded data" : `${hub.historicalDelayPercent}%`}</span></div>)}</div><p className="op-method-note">Historical delay is calculated from actual transit days greater than the shipment SLA (or the project’s explicitly non-policy four-day baseline when no SLA is recorded).</p></section>
      </div>
    );
  }

  if (!employee) return null;
  return (
    <section className="op-desktop" aria-label="Operations Manager desktop">
      <aside className={`op-sidebar ${mobileNavOpen ? "is-open" : ""}`}>
        <div className="op-sidebar-top"><span className="op-sidebar-kicker">OPERATIONS DESK</span><h2>Control workspace</h2><p>{employee.company.name}</p></div>
        <nav aria-label="Operations navigation">{navigation.map((item) => <button aria-current={activeView === item.id ? "page" : undefined} className={activeView === item.id ? "active" : ""} key={item.id} onClick={() => goTo(item.id)} type="button"><span>{item.icon}</span>{item.label}{item.id === "exceptions" && workspace && workspace.kpis.delayed + workspace.kpis.approachingSla > 0 ? <b>{workspace.kpis.delayed + workspace.kpis.approachingSla}</b> : null}</button>)}</nav>
        <div className="op-sidebar-footer"><span className={`op-connection-dot ${eventStatus}`} />{eventStatus === "connected" ? "Updates connected" : eventStatus === "reconnecting" ? "Reconnecting…" : "Connecting…"}</div>
      </aside>
      {mobileNavOpen && <button aria-label="Close navigation" className="op-nav-scrim" onClick={() => setMobileNavOpen(false)} type="button" />}
      <main className="op-main">
        <header className="op-topbar"><button aria-label="Open navigation" className="op-mobile-menu" onClick={() => setMobileNavOpen(true)} type="button">☰</button><div><span className="op-eyebrow">{employee.company.name.toUpperCase()} · OPERATIONS MANAGER</span><h1>{title}</h1></div><div className="op-topbar-meta"><span className="op-snapshot-badge"><i /> Database snapshot</span><span>{workspace?.scope.assignedHubCount ?? employee.assignedHubs.length} assigned hubs</span></div></header>
        {error && <p className="op-error" role="alert">{error}</p>}
        {loading && !workspace ? <div className="op-loading">Loading authorized operations data…</div> : workspace?.scope.assignedHubCount === 0 ? (
          <div className="op-empty-state"><div className="op-empty-mark">⌖</div><span className="op-eyebrow">HUB ACCESS REQUIRED</span><h2>No hubs assigned yet</h2><p>Your workspace is limited to hubs assigned to your employee account. Ask your Company Admin to assign your hubs; no company-wide shipment data is shown without those assignments.</p><button className="op-button-primary" onClick={() => goTo("team")} type="button">Check hub-scoped team</button></div>
        ) : workspace ? (
          <div className="op-page">
            {workspace.scope.assignedHubCount < 3 && <div className="op-assignment-note">You have {workspace.scope.assignedHubCount} active hub assignment{workspace.scope.assignedHubCount === 1 ? "" : "s"}. Your access remains restricted to these assigned hubs; contact your Company Admin if this is unexpected.</div>}
            {activeView === "overview" && renderOverview()}
            {activeView === "shipments" && renderShipments()}
            {activeView === "booking-requests" && renderBookingRequests()}
            {activeView === "hubs" && renderHubs()}
            {activeView === "exceptions" && renderExceptions()}
            {activeView === "team" && renderTeam()}
            {activeView === "routes" && renderRoutes()}
            {activeView === "notifications" && renderNotifications()}
            {activeView === "reports" && renderReports()}
            {!workspace.capabilities.taskAssignments && activeView === "team" && <p className="op-method-note">Operational task assignments are managed by Hub Managers. Staff and hub assignments are read-only here.</p>}
          </div>
        ) : null}
      </main>
      {selectedId && <div className="op-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }} role="presentation"><section aria-labelledby="op-detail-title" aria-modal="true" className="op-modal" role="dialog"><header><div><span className="op-eyebrow">RECORDED SHIPMENT DETAILS</span><h2 id="op-detail-title">{selectedId}</h2></div><button aria-label="Close shipment details" onClick={() => setSelectedId(null)} type="button">×</button></header><div className="op-modal-content">{detailLoading && <p>Loading shipment record…</p>}{detailError && <p className="op-error" role="alert">{detailError}</p>}{detail && <><div className="op-detail-grid"><div><span>Customer</span><strong>{detail.customerName ?? "Unavailable"}</strong></div><div><span>Recorded status</span><strong>{detail.status}</strong></div><div><span>Origin / destination</span><strong>{detail.origin ?? "—"} → {detail.destination ?? "—"}</strong></div><div><span>Origin / destination hubs</span><strong>{detail.originHubId} → {detail.destinationHubId}</strong></div><div><span>Mode / chargeable weight</span><strong>{detail.mode} · {detail.chargeableWeight ?? "—"}</strong></div><div><span>Booked</span><strong>{formatDate(detail.shipmentDate)}</strong></div><div><span>Estimated delivery date</span><strong>{formatDate(detail.expectedDeliveryDate)}</strong></div></div><div className="op-detail-history"><h3>Recorded event history</h3>{detail.events.length === 0 ? <p>No shipment events are recorded.</p> : detail.events.map((event, index) => <div className="op-event-row" key={`${event.eventTime}-${event.hubId}-${index}`}><i /><div><strong>{event.eventStatus || event.eventType || "Recorded event"}</strong><span>{event.city ?? event.hubId ?? "Location unavailable"}</span></div><time>{formatDateTime(event.eventTime)}</time></div>)}</div><p className="op-method-note">Estimated delivery is the date recorded in the shipment record. Event history shows recorded events only; no live location or unrecorded ETA is implied.</p></>}</div></section></div>}
    </section>
  );
}
