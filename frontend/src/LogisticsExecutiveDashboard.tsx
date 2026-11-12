import { useEffect, useMemo, useState } from "react";
import { authenticatedFetch, useAuth } from "./auth";
import { ShipmentQrCode } from "./ShipmentQrCode";
import { ShipmentQrScanner } from "./ShipmentQrScanner";

type Task = {
  taskKey: string;
  taskType: "PICKUP" | "DELIVERY";
  status: "PENDING" | "ACCEPTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  hubId: string;
  hubCity: string;
  consignmentNo: string;
  shipmentDate: string | null;
  expectedDeliveryDate: string | null;
  shipmentStatus: string;
  mode: string;
  originHubId: string;
  originCity: string;
  destinationHubId: string;
  destinationCity: string;
  senderName: string | null;
  senderPhone: string | null;
  senderAddress: string | null;
  senderCity: string | null;
  senderState: string | null;
  senderPincode: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  recipientAddress: string | null;
  recipientCity: string | null;
  recipientState: string | null;
  recipientPincode: string | null;
  chargePayer?: "SENDER" | "RECEIVER" | null;
  collectionMethod?: "PAY_AT_PICKUP" | "PAY_AT_DELIVERY" | "DEMO_UPI" | null;
  paymentStatus?: string | null;
  shippingCharge?: number | string | null;
  shippingCollected?: number | string | null;
  codAmount?: number | string | null;
  codCollected?: number | string | null;
  codEnabled?: number | string | null;
  failureReason: string | null;
  assignedAt: string | null;
  lastEvent: string | null;
  lastEventAt: string | null;
  events?: Array<{ eventTime: string; eventType: string; eventStatus: string; hubId: string | null; city: string | null; employeeName: string | null; notes: string | null }>;
};

type AssignmentHistory = {
  taskKey: string; taskType: "PICKUP" | "DELIVERY"; consignmentNo: string;
  shipmentDate: string | null; recordedOutcome: string; expectedDeliveryDate: string | null;
  mode: string; hubId: string; hubCity: string; originCity: string; destinationCity: string;
  originHubId: string; destinationHubId: string;
  senderName: string | null; senderPhone: string | null; senderAddress: string | null;
  senderCity: string | null; senderState: string | null; senderPincode: string | null;
  recipientName: string | null; recipientPhone: string | null; recipientAddress: string | null;
  recipientCity: string | null; recipientState: string | null; recipientPincode: string | null;
  eventCount: number; pickedUpAt: string | null; handedOverAt: string | null;
  outForDeliveryAt: string | null; deliveredAt: string | null; failedAttemptCount: number;
  events?: Array<{ eventTime: string; eventType: string; eventStatus: string; hubId: string | null; city: string | null; employeeName: string | null; notes: string | null }>;
};

const statuses = ["ALL", "PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "FAILED"] as const;
const dateTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "Not recorded";

export function LogisticsExecutiveDashboard() {
  const { employee } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [status, setStatus] = useState<(typeof statuses)[number]>("ALL");
  const [type, setType] = useState<"ALL" | "PICKUP" | "DELIVERY">("ALL");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Task | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [trackingId, setTrackingId] = useState("");
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeView, setActiveView] = useState<"tasks" | "history">("tasks");
  const [assignmentHistory, setAssignmentHistory] = useState<AssignmentHistory[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [historyDetail, setHistoryDetail] = useState<AssignmentHistory | null>(null);
  const [historyDetailError, setHistoryDetailError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ status: "ALL" });
    if (type !== "ALL") params.set("type", type);
    if (query) params.set("search", query);
    setLoading(true);
    setError(null);
    authenticatedFetch(`/api/logistics-executive/tasks?${params}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { tasks?: Task[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Your tasks could not be loaded.");
        return payload.tasks ?? [];
      })
      .then(setTasks)
      .catch((caught: unknown) => { if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(caught instanceof Error ? caught.message : "Your tasks could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [status, type, query, reload]);

  useEffect(() => {
    if (activeView !== "history") return;
    const controller = new AbortController();
    setHistoryLoading(true);
    setHistoryError(null);
    const params = new URLSearchParams({ offset: String(historyOffset), limit: "50" });
    if (type !== "ALL") params.set("type", type);
    if (query) params.set("search", query);
    authenticatedFetch(`/api/logistics-executive/history?${params}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { assignments?: AssignmentHistory[]; total?: number; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Assignment history could not be loaded.");
        return payload;
      })
      .then((payload) => {
        setAssignmentHistory((current) => historyOffset === 0 ? payload.assignments ?? [] : [...current, ...(payload.assignments ?? [])]);
        setHistoryTotal(payload.total ?? 0);
      })
      .catch((caught: unknown) => { if (!(caught instanceof DOMException && caught.name === "AbortError")) setHistoryError(caught instanceof Error ? caught.message : "Assignment history could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [activeView, historyOffset, type, query, reload]);

  useEffect(() => {
    const stream = new EventSource("/api/logistics-executive/events");
    const refresh = () => { setHistoryOffset(0); setReload((value) => value + 1); };
    stream.addEventListener("workspace-invalidated", refresh);
    stream.addEventListener("recovery-required", refresh);
    return () => stream.close();
  }, []);

  useEffect(() => {
    if (selectedId === null) { setDetail(null); return; }
    const separator = selectedId.indexOf(":");
    const taskType = selectedId.slice(0, separator);
    const consignmentNo = selectedId.slice(separator + 1);
    const controller = new AbortController();
    setDetailError(null);
    authenticatedFetch(`/api/logistics-executive/tasks/${taskType}/${encodeURIComponent(consignmentNo)}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { task?: Task; error?: string };
        if (!response.ok || !payload.task) throw new Error(payload.error ?? "Task details could not be loaded.");
        return payload.task;
      })
      .then(setDetail)
      .catch((caught: unknown) => { if (!(caught instanceof DOMException && caught.name === "AbortError")) setDetailError(caught instanceof Error ? caught.message : "Task details could not be loaded."); });
    return () => controller.abort();
  }, [selectedId, reload]);

  useEffect(() => {
    if (selectedHistoryId === null) { setHistoryDetail(null); return; }
    const separator = selectedHistoryId.indexOf(":");
    const taskType = selectedHistoryId.slice(0, separator);
    const consignmentNo = selectedHistoryId.slice(separator + 1);
    const controller = new AbortController();
    setHistoryDetailError(null);
    authenticatedFetch(`/api/logistics-executive/history/${taskType}/${encodeURIComponent(consignmentNo)}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { assignment?: AssignmentHistory; error?: string };
        if (!response.ok || !payload.assignment) throw new Error(payload.error ?? "Historical assignment details could not be loaded.");
        return payload.assignment;
      })
      .then(setHistoryDetail)
      .catch((caught: unknown) => { if (!(caught instanceof DOMException && caught.name === "AbortError")) setHistoryDetailError(caught instanceof Error ? caught.message : "Historical assignment details could not be loaded."); });
    return () => controller.abort();
  }, [selectedHistoryId, reload]);

  useEffect(() => {
    if (!selectedId) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) setSelectedId(null); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [selectedId, busy]);

  const grouped = useMemo(() => statuses.slice(1).map((value) => ({ status: value, count: tasks.filter((task) => task.status === value).length })), [tasks]);
  const visibleTasks = useMemo(() => status === "ALL" ? tasks : tasks.filter((task) => task.status === status), [tasks, status]);

  async function perform(action: string, requiresTracking = false) {
    if (!detail) return;
    if (requiresTracking && trackingId.trim() !== detail.consignmentNo) {
      setActionError("Enter the exact tracking ID shown for this shipment to confirm the physical action.");
      return;
    }
    if (action === "fail" && reason.trim().length < 5) { setActionError("Add a reason of at least 5 characters."); return; }
    setBusy(true); setActionError(null); setSuccess(null);
    try {
      const response = await authenticatedFetch(`/api/logistics-executive/tasks/${detail.taskType}/${encodeURIComponent(detail.consignmentNo)}/actions/${action}`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(requiresTracking ? { trackingId: trackingId.trim() } : {}), ...(action === "fail" ? { reason: reason.trim() } : {}) }),
      });
      const payload = await response.json() as { error?: string; task?: { status: string } };
      if (!response.ok) throw new Error(payload.error ?? "Task action could not be recorded.");
      setSuccess(`Task updated to ${payload.task?.status ?? "complete"}.`);
      setTrackingId(""); setReason(""); setReload((value) => value + 1);
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : "Task action could not be recorded."); }
    finally { setBusy(false); }
  }

  async function recordCollection(kind:"SHIPPING"|"COD",channel:"DEMO_CASH"|"DEMO_UPI") {
    if(!detail)return;
    setBusy(true);setActionError(null);setSuccess(null);
    try {
      const response=await authenticatedFetch(`/api/logistics-executive/tasks/${detail.taskType}/${encodeURIComponent(detail.consignmentNo)}/collections`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind,channel,idempotencyKey:crypto.randomUUID()})});
      const payload=await response.json() as {error?:string;collection?:{amount:number;collectionMethod:string;collectionChannel:string}};
      if(!response.ok||!payload.collection)throw new Error(payload.error??"Demo collection could not be recorded.");
      setSuccess(`DEMO collection recorded · ₹${payload.collection.amount.toFixed(2)} · ${payload.collection.collectionMethod} · ${payload.collection.collectionChannel}`);setReload(value=>value+1);
    }catch(caught){setActionError(caught instanceof Error?caught.message:"Demo collection could not be recorded.");}
    finally{setBusy(false);}
  }

  function collectionActions(task:Task) {
    const actions:Array<{kind:"SHIPPING"|"COD";label:string;amount:number}>=[];
    const active=["ACCEPTED","IN_PROGRESS"].includes(task.status);
    if(active&&task.collectionMethod==="PAY_AT_PICKUP"&&task.taskType==="PICKUP"&&task.paymentStatus==="COLLECTION_DUE"&&task.lastEvent==="BOOKED")actions.push({kind:"SHIPPING",label:"Sender shipping charge",amount:Number(task.shippingCharge??0)});
    if(active&&task.collectionMethod==="PAY_AT_DELIVERY"&&task.taskType==="DELIVERY"&&task.paymentStatus==="COLLECTION_DUE"&&task.lastEvent==="OUT_FOR_DELIVERY")actions.push({kind:"SHIPPING",label:"Receiver shipping charge",amount:Number(task.shippingCharge??0)});
    if(active&&task.taskType==="DELIVERY"&&Number(task.codEnabled)===1&&Number(task.codAmount??0)>0&&Number(task.codCollected??0)===0&&task.lastEvent==="OUT_FOR_DELIVERY")actions.push({kind:"COD",label:"COD goods amount",amount:Number(task.codAmount)});
    return actions;
  }

  async function resolveExecutiveQr(consignmentNo: string) {
    let lastError = "This shipment is not assigned to your executive account.";
    for (const taskType of ["PICKUP", "DELIVERY"] as const) {
      const response = await authenticatedFetch(`/api/logistics-executive/tasks/${taskType}/${encodeURIComponent(consignmentNo)}`, { credentials: "same-origin" });
      const payload = await response.json() as { task?: Task; error?: string };
      if (response.ok && payload.task) {
        setSelectedId(payload.task.taskKey);
        setTrackingId(consignmentNo);
        setActionError(null);
        return;
      }
      lastError = payload.error ?? lastError;
    }
    throw new Error(lastError);
  }

  function taskActions(task: Task) {
    const buttons: Array<{ action: string; label: string; tracking?: boolean }> = [];
    if (task.status === "PENDING") buttons.push({ action: "accept", label: "Accept task" });
    if (task.status === "ACCEPTED") buttons.push({ action: "start", label: "Start work" });
    if (task.status === "IN_PROGRESS" && task.taskType === "PICKUP") {
      if (task.lastEvent !== "PICKED_UP") buttons.push({ action: "pickup", label: "Confirm pickup", tracking: true });
      else buttons.push({ action: "handover", label: "Confirm hub handover" });
      buttons.push({ action: "fail", label: "Record exception" });
    }
    if (task.status === "IN_PROGRESS" && task.taskType === "DELIVERY") {
      if (task.lastEvent === "ARRIVED_AT_DESTINATION_HUB") buttons.push({ action: "out-for-delivery", label: "Mark out for delivery", tracking: true });
      if (task.lastEvent === "OUT_FOR_DELIVERY") buttons.push({ action: "deliver", label: "Confirm delivery", tracking: true });
      buttons.push({ action: "fail", label: "Record exception" });
    }
    return buttons;
  }

  return (
    <section className="le-workspace" aria-label="Logistics Executive workspace">
      <header className="le-heading"><div><span className="le-eyebrow">FIELD OPERATIONS · {employee?.company.name}</span><h1>{activeView === "tasks" ? "My tasks" : "Dataset assignment history"}</h1><p>{activeView === "tasks" ? "Pickups and deliveries assigned to you." : "Historical pickup and delivery assignments with persisted event evidence."}</p></div><span className="le-identity">{employee?.name}</span></header>
      <nav className="le-view-switch" aria-label="Executive work views"><button aria-pressed={activeView === "tasks"} className={activeView === "tasks" ? "selected" : ""} onClick={() => setActiveView("tasks")} type="button">Operational tasks</button><button aria-pressed={activeView === "history"} className={activeView === "history" ? "selected" : ""} onClick={() => { setActiveView("history"); setHistoryOffset(0); }} type="button">Assignment history</button></nav>
      {activeView === "tasks" && <>      <div className="le-summary" aria-label="Task counts">{grouped.map((item) => <div key={item.status}><span>{item.status.replaceAll("_", " ")}</span><strong>{item.count}</strong></div>)}</div>
      <section className="le-panel">
        <div className="le-toolbar"><div className="le-tabs" aria-label="Filter tasks by status">{statuses.map((value) => <button aria-pressed={status === value} className={status === value ? "selected" : ""} key={value} onClick={() => setStatus(value)} type="button">{value === "ALL" ? "All tasks" : value.replaceAll("_", " ")}</button>)}</div>
          <form className="le-filters" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); }}>
            <label><span>Task type</span><select value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="ALL">All types</option><option value="PICKUP">Pickup</option><option value="DELIVERY">Delivery</option></select></label>
            <label><span>Search tasks</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tracking ID or contact" /></label>
            <button type="submit">Search</button>
          </form>
        </div>
        {error && <p className="le-alert" role="alert">{error}</p>}
        <div className="le-table-wrap"><table className="le-table"><thead><tr><th>Task</th><th>Tracking ID</th><th>Hub / route</th><th>Contact</th><th>State</th><th>Expected delivery</th><th /></tr></thead>
          <tbody>{visibleTasks.map((task) => <tr key={task.taskKey}><td><span className={`le-kind ${task.taskType.toLowerCase()}`}>{task.taskType}</span><small>Assigned {dateTime(task.assignedAt)}</small></td><td><strong>{task.consignmentNo}</strong><small>{task.mode || "Mode not recorded"} · {task.shipmentStatus || "Status not recorded"}</small></td><td>{task.hubCity}<small>{task.originCity} → {task.destinationCity}</small></td><td>{task.taskType === "PICKUP" ? task.senderName || "Sender" : task.recipientName || "Recipient"}<small>{task.taskType === "PICKUP" ? task.senderPhone : task.recipientPhone}</small></td><td><span className={`le-status ${task.status.toLowerCase()}`}>{task.status.replaceAll("_", " ")}</span>{task.failureReason && <small>{task.failureReason}</small>}</td><td>{dateTime(task.expectedDeliveryDate)}</td><td><button className="le-inspect" onClick={() => { setSelectedId(task.taskKey); setActionError(null); setSuccess(null); }} type="button">View task</button></td></tr>)}
          {!loading && visibleTasks.length === 0 && <tr><td colSpan={7} className="le-empty-cell"><strong>No current operational tasks</strong><span>Eligible pickup and delivery assignments for your active hubs will appear here.</span></td></tr>}
          {loading && visibleTasks.length === 0 && <tr><td colSpan={7} className="le-empty-cell">Loading your assigned tasks…</td></tr>}
          </tbody></table></div>
        {loading && tasks.length > 0 && <p className="le-loading" aria-live="polite">Refreshing tasks…</p>}
      </section>
      </>}
      {selectedId !== null && <div className="le-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setSelectedId(null); }}><section className="le-dialog" role="dialog" aria-modal="true" aria-labelledby="le-task-title">
        <header><div><span className="le-eyebrow">{detail?.taskType ?? "ASSIGNED TASK"} · {detail?.hubCity ?? ""}</span><h2 id="le-task-title">{detail?.consignmentNo ?? `Task ${selectedId}`}</h2></div><button aria-label="Close task details" onClick={() => setSelectedId(null)} type="button">×</button></header>
        <div className="le-dialog-content">
          {detailError && <p className="le-alert" role="alert">{detailError}</p>}
          {!detail && !detailError && <p>Loading authorized task details…</p>}
          {detail && <>
            <div className="le-detail-grid"><div><span>Task state</span><strong>{detail.status.replaceAll("_", " ")}</strong></div><div><span>Shipment status</span><strong>{detail.shipmentStatus || "Not recorded"}</strong></div><div><span>Route</span><strong>{detail.originCity} → {detail.destinationCity}</strong></div><div><span>Expected delivery</span><strong>{dateTime(detail.expectedDeliveryDate)}</strong></div><div><span>Assigned hub</span><strong>{detail.hubCity} · {detail.hubId}</strong></div><div><span>Last event</span><strong>{detail.lastEvent ?? "No event recorded"} · {dateTime(detail.lastEventAt)}</strong></div></div>
            {(detail.collectionMethod||Number(detail.codAmount??0)>0)&&<section className="le-collection-panel"><h3>DEMO payment collection</h3>{detail.collectionMethod&&<p>Shipping: ₹{Number(detail.shippingCharge??0).toFixed(2)} · {detail.chargePayer??"Payer not set"} · {detail.collectionMethod} · {detail.paymentStatus??"Not recorded"}</p>}{Number(detail.codAmount??0)>0&&<p>COD goods amount: ₹{Number(detail.codAmount).toFixed(2)} · separately recorded · collected ₹{Number(detail.codCollected??0).toFixed(2)}</p>}{collectionActions(detail).map((item)=><div className="le-collection-actions" key={item.kind}><strong>{item.label} · ₹{item.amount.toFixed(2)}</strong><button disabled={busy} type="button" onClick={()=>void recordCollection(item.kind,"DEMO_CASH")}>Record demo cash</button><button disabled={busy} type="button" onClick={()=>void recordCollection(item.kind,"DEMO_UPI")}>Record demo UPI</button></div>)}<small>These are demo records only. No money is transferred.</small></section>}
            <ShipmentQrCode consignmentNo={detail.consignmentNo} />
            <div className="le-contact-grid"><section className="le-contact"><h3>Sender · pickup address</h3><strong>{detail.senderName || "Name not recorded"}</strong><span>{detail.senderPhone || "Phone not recorded"}</span><p>{[detail.senderAddress, detail.senderCity, detail.senderState, detail.senderPincode].filter(Boolean).join(", ") || "Address not recorded"}</p></section><section className="le-contact"><h3>Recipient · delivery address</h3><strong>{detail.recipientName || "Name not recorded"}</strong><span>{detail.recipientPhone || "Phone not recorded"}</span><p>{[detail.recipientAddress, detail.recipientCity, detail.recipientState, detail.recipientPincode].filter(Boolean).join(", ") || "Address not recorded"}</p></section></div>
            <h3 className="le-history-title">Recorded shipment events</h3>{!detail.events?.length ? <p className="le-muted">No event history is stored for this shipment.</p> : <div className="le-history">{detail.events.map((event, index) => <div key={`${event.eventTime}-${event.eventType}-${index}`}><i /><strong>{event.eventType}</strong><span>{event.eventStatus} · {event.city || "Location not recorded"} · {dateTime(event.eventTime)}</span>{event.notes && <small>{event.notes}</small>}</div>)}</div>}
            {taskActions(detail).length > 0 && <section className="le-actions"><h3>Record an action</h3>
              {taskActions(detail).some((item) => item.tracking) && <><ShipmentQrScanner onResolve={resolveExecutiveQr} /><label><span>Tracking ID verification · manual fallback</span><input autoComplete="off" value={trackingId} onChange={(event) => setTrackingId(event.target.value)} /></label></>}
              {taskActions(detail).some((item) => item.action === "fail") && <label><span>Exception reason</span><textarea maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}
              <div className="le-action-buttons">{taskActions(detail).map((item) => <button disabled={busy} key={item.action} className={item.action === "fail" ? "secondary" : "primary"} onClick={() => void perform(item.action, item.tracking)} type="button">{busy ? "Saving…" : item.label}</button>)}</div>
              {actionError && <p className="le-alert" role="alert">{actionError}</p>}{success && <p className="le-success" role="status">{success}</p>}
            </section>}
      </>}

        </div>

    </section></div>}
        {activeView === "history" && <section className="le-panel le-assignment-history" aria-label="Dataset assignment history">
        <div className="le-history-toolbar"><strong>{historyTotal.toLocaleString()} historical assignments</strong><form className="le-filters" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setHistoryOffset(0); }}>
          <label><span>Assignment type</span><select value={type} onChange={(event) => { setType(event.target.value as typeof type); setHistoryOffset(0); }}><option value="ALL">All types</option><option value="PICKUP">Origin pickup</option><option value="DELIVERY">Destination delivery</option></select></label>
          <label><span>Search history</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tracking ID or contact" /></label><button type="submit">Search</button>
        </form></div>
        <p className="le-history-disclaimer">Historical dataset assignments. Legacy shipment outcomes such as On Time or Delayed do not prove that an Executive completed an individual pickup or delivery. Missing event times are not inferred.</p>
        {historyError && <p className="le-alert" role="alert">{historyError}</p>}
        <div className="le-table-wrap"><table className="le-table"><thead><tr><th>Assignment</th><th>Tracking / outcome</th><th>Hub / route</th><th>Contact</th><th>Persisted event evidence</th><th /></tr></thead><tbody>
          {assignmentHistory.map((item) => <tr key={item.taskKey}><td><span className={`le-kind ${item.taskType.toLowerCase()}`}>{item.taskType === "PICKUP" ? "ORIGIN PICKUP" : "DESTINATION DELIVERY"}</span><small>Shipment date {dateTime(item.shipmentDate)}</small></td><td><strong>{item.consignmentNo}</strong><small>Dataset outcome: {item.recordedOutcome}</small></td><td>{item.hubCity}<small>{item.originCity} → {item.destinationCity}</small></td><td>{item.taskType === "PICKUP" ? item.senderName || "Sender" : item.recipientName || "Recipient"}<small>{item.taskType === "PICKUP" ? item.senderPhone : item.recipientPhone}</small></td><td><small>Pickup {dateTime(item.pickedUpAt)} · Hub handover {dateTime(item.handedOverAt)}</small><small>Out for delivery {dateTime(item.outForDeliveryAt)} · Delivered {dateTime(item.deliveredAt)}</small><small>{item.eventCount} persisted events · {item.failedAttemptCount} recorded exceptions</small></td><td><button className="le-inspect" onClick={() => setSelectedHistoryId(item.taskKey)} type="button">View record</button></td></tr>)}
          {!historyLoading && assignmentHistory.length === 0 && <tr><td colSpan={6} className="le-empty-cell"><strong>No dataset assignment history</strong><span>Historical assignments for your active hubs will appear here.</span></td></tr>}
          {historyLoading && assignmentHistory.length === 0 && <tr><td colSpan={6} className="le-empty-cell">Loading assignment history…</td></tr>}
        </tbody></table></div>
        {historyLoading && assignmentHistory.length > 0 && <p className="le-loading" aria-live="polite">Loading more history…</p>}
        {assignmentHistory.length < historyTotal && !historyLoading && <button className="le-history-more" onClick={() => setHistoryOffset(assignmentHistory.length)} type="button">Load more assignments</button>}
      </section>}
      {selectedHistoryId !== null && <div className="le-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedHistoryId(null); }}><section className="le-dialog" role="dialog" aria-modal="true" aria-labelledby="le-history-title">
        <header><div><span className="le-eyebrow">DATASET ASSIGNMENT · {historyDetail?.taskType ?? "HISTORY"}</span><h2 id="le-history-title">{historyDetail?.consignmentNo ?? "Historical shipment"}</h2></div><button aria-label="Close historical details" onClick={() => setSelectedHistoryId(null)} type="button">×</button></header>
        <div className="le-dialog-content">{historyDetailError && <p className="le-alert" role="alert">{historyDetailError}</p>}{!historyDetail && !historyDetailError && <p>Loading authorized historical details…</p>}{historyDetail && <>
          <div className="le-detail-grid"><div><span>Dataset outcome</span><strong>{historyDetail.recordedOutcome}</strong></div><div><span>Shipment date</span><strong>{dateTime(historyDetail.shipmentDate)}</strong></div><div><span>Assignment hub</span><strong>{historyDetail.hubCity} · {historyDetail.hubId}</strong></div><div><span>Route</span><strong>{historyDetail.originCity} → {historyDetail.destinationCity}</strong></div><div><span>Persisted event count</span><strong>{historyDetail.eventCount}</strong></div><div><span>Recorded exceptions</span><strong>{historyDetail.failedAttemptCount}</strong></div><div><span>Pickup time</span><strong>{dateTime(historyDetail.pickedUpAt)}</strong></div><div><span>Origin hub handover</span><strong>{dateTime(historyDetail.handedOverAt)}</strong></div><div><span>Out for delivery</span><strong>{dateTime(historyDetail.outForDeliveryAt)}</strong></div><div><span>Delivery time</span><strong>{dateTime(historyDetail.deliveredAt)}</strong></div></div>
          <div className="le-contact-grid"><section className="le-contact"><h3>Sender · origin contact</h3><strong>{historyDetail.senderName || "Name not recorded"}</strong><span>{historyDetail.senderPhone || "Phone not recorded"}</span><p>{[historyDetail.senderAddress, historyDetail.senderCity, historyDetail.senderState, historyDetail.senderPincode].filter(Boolean).join(", ") || "Address not recorded"}</p></section><section className="le-contact"><h3>Recipient · destination contact</h3><strong>{historyDetail.recipientName || "Name not recorded"}</strong><span>{historyDetail.recipientPhone || "Phone not recorded"}</span><p>{[historyDetail.recipientAddress, historyDetail.recipientCity, historyDetail.recipientState, historyDetail.recipientPincode].filter(Boolean).join(", ") || "Address not recorded"}</p></section></div>
          <h3 className="le-history-title">Persisted shipment events</h3>{!historyDetail.events?.length ? <p className="le-muted">No event history is stored for this shipment.</p> : <div className="le-history">{historyDetail.events.map((event, index) => <div key={`${event.eventTime}-${event.eventType}-${index}`}><i /><strong>{event.eventType}</strong><span>{event.eventStatus} · {event.city || "Location not recorded"} · {dateTime(event.eventTime)}</span>{event.notes && <small>{event.notes}</small>}</div>)}</div>}
        </>}</div>
      </section></div>}
    </section>
  );
}
