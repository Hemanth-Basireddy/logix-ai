import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { authenticatedFetch } from "./auth";

type Hub = { hubId: string; city: string };
type EligibleShipment = { consignmentNo: string; shipmentDate: string | null; mode: string; destinationHubId: string; destinationCity: string; finalDestinationHubId: string; finalDestinationCity: string; recipientName: string | null; lastEvent: string; lastEventAt: string | null };
type ManifestRow = { consignmentNo: string; loadingStatus: "PENDING" | "LOADED" | "RECEIVED" | "MISSING" | "DAMAGED"; shipmentOriginCity: string | null; shipmentDestinationCity: string | null; receivingCondition: string | null; exceptionReason: string | null };
type Trip = { tripId: number; originHubId: string; originCity: string; destinationHubId: string; destinationCity: string; vehicleNumber: string; driverName: string; driverPhone: string | null; status: string; scheduledDeparture: string | null; actualDeparture: string | null; actualArrival: string | null; shipmentCount: number; pendingCount: number; loadedCount: number; receivedCount: number; exceptionCount: number; manifest: ManifestRow[] };

export function HubManagerTransport({ hubs, refreshKey, onChanged }: { hubs: Hub[]; refreshKey: number; onChanged: () => void }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [eligible, setEligible] = useState<EligibleShipment[]>([]);
  const [originHubId, setOriginHubId] = useState(hubs[0]?.hubId ?? "");
  const [destinationHubId, setDestinationHubId] = useState("");
  const [selectedShipments, setSelectedShipments] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [departure, setDeparture] = useState("");
  const [remarks, setRemarks] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [exceptionReasons, setExceptionReasons] = useState<Record<string, string>>({});

  const loadTrips = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch("/api/hub-manager/trips", { credentials: "same-origin" });
      const payload = await response.json() as { trips?: Trip[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Transport trips could not be loaded.");
      setTrips(payload.trips ?? []);
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Transport trips could not be loaded."); }
    finally { setLoading(false); }
  }, []);

  const loadEligible = useCallback(async () => {
    setEligible([]);
    setSelectedShipments([]);
    setDestinationHubId("");
    if (!originHubId) return;
    setEligibleLoading(true);
    try {
      const response = await authenticatedFetch(`/api/hub-manager/trips/eligible?hubId=${encodeURIComponent(originHubId)}`, { credentials: "same-origin" });
      const payload = await response.json() as { shipments?: EligibleShipment[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Eligible shipments could not be loaded.");
      setEligible(payload.shipments ?? []);
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Eligible shipments could not be loaded."); }
    finally { setEligibleLoading(false); }
  }, [originHubId]);

  useEffect(() => { void loadTrips(); }, [loadTrips, refreshKey]);
  useEffect(() => { void loadEligible(); }, [loadEligible]);
  useEffect(() => { if (hubs.length && !hubs.some((hub) => hub.hubId === originHubId)) setOriginHubId(hubs[0]!.hubId); }, [hubs, originHubId]);

  const destinations = useMemo(() => {
    const groups = new Map<string, { hubId: string; city: string; count: number }>();
    for (const shipment of eligible) {
      const group = groups.get(shipment.destinationHubId) ?? { hubId: shipment.destinationHubId, city: shipment.destinationCity, count: 0 };
      group.count += 1;
      groups.set(shipment.destinationHubId, group);
    }
    return [...groups.values()].sort((a, b) => a.city.localeCompare(b.city));
  }, [eligible]);
  const visibleShipments = useMemo(() => eligible.filter((shipment) => shipment.destinationHubId === destinationHubId && shipment.consignmentNo.toLowerCase().includes(search.trim().toLowerCase())), [eligible, destinationHubId, search]);
  const selectedRows = eligible.filter((shipment) => selectedShipments.includes(shipment.consignmentNo) && shipment.destinationHubId === destinationHubId);
  const origin = hubs.find((hub) => hub.hubId === originHubId);

  async function mutate(path: string, body?: unknown) {
    setBusy(true); setError(""); setSuccess("");
    try {
      const response = await authenticatedFetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Transport operation could not be completed.");
      setSuccess("Transport update saved.");
      await Promise.all([loadTrips(), loadEligible()]);
      onChanged();
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Transport operation could not be completed."); return false; }
    finally { setBusy(false); }
  }

  async function createTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedShipments.length || !destinationHubId) { setError("Select shipments for one destination before creating a load."); return; }
    const saved = await mutate("/api/hub-manager/trips", {
      originHubId, destinationHubId, vehicleNumber, driverName, driverPhone: driverPhone || undefined,
      scheduledDeparture: departure ? new Date(departure).toISOString() : undefined,
      remarks: remarks || undefined,
      consignmentNos: selectedShipments,
    });
    if (saved) {
      setModalOpen(false); setSelectedShipments([]); setVehicleNumber(""); setDriverName(""); setDriverPhone("");
      setDeparture(""); setRemarks("");
    }
  }

  function canManageOrigin(trip: Trip) { return hubs.some((hub) => hub.hubId === trip.originHubId); }
  function canManageDestination(trip: Trip) { return hubs.some((hub) => hub.hubId === trip.destinationHubId); }
  function loadCard(trip: Trip) {
    const ref = `LOAD-${String(trip.tripId).padStart(8, "0")}`;
    return <section className="op-panel op-transport-trip" key={trip.tripId}>
      <div className="op-panel-heading"><div><span className="op-eyebrow">{ref} · {trip.originHubId} → {trip.destinationHubId}</span><h3>{trip.originCity} to {trip.destinationCity}</h3></div><span className="op-status-pill">{trip.status.replaceAll("_", " ")}</span></div>
      <div className="op-transport-meta"><span>Vehicle <strong>{trip.vehicleNumber}</strong></span><span>Driver <strong>{trip.driverName}</strong></span>{trip.driverPhone && <span>Phone <strong>{trip.driverPhone}</strong></span>}<span>Manifest <strong>{trip.shipmentCount}</strong></span><span>Loaded <strong>{trip.loadedCount}</strong></span><span>Received <strong>{trip.receivedCount}</strong></span><span>Exceptions <strong>{trip.exceptionCount}</strong></span>{trip.scheduledDeparture && <span>Scheduled <strong>{new Date(trip.scheduledDeparture).toLocaleString()}</strong></span>}{trip.actualDeparture && <span>Departed <strong>{new Date(trip.actualDeparture).toLocaleString()}</strong></span>}{trip.actualArrival && <span>Arrived <strong>{new Date(trip.actualArrival).toLocaleString()}</strong></span>}</div>
      <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Shipment</th><th>Shipment route</th><th>Manifest state</th><th>Receiving condition / exception</th><th>Action</th></tr></thead><tbody>{trip.manifest.map((item) => <tr key={`${trip.tripId}-${item.consignmentNo}`}><td>{item.consignmentNo}</td><td>{item.shipmentOriginCity ?? "—"} → {item.shipmentDestinationCity ?? "—"}</td><td>{item.loadingStatus}</td><td>{item.exceptionReason ?? (item.receivingCondition ?? "Not reconciled")}</td><td>
        {canManageOrigin(trip) && item.loadingStatus === "PENDING" && ["PLANNED", "LOADING"].includes(trip.status) && <button className="op-row-link" type="button" disabled={busy} onClick={() => void mutate(`/api/hub-manager/trips/${trip.tripId}/load`, { consignmentNo: item.consignmentNo })}>Confirm loaded</button>}
        {canManageDestination(trip) && trip.status === "ARRIVED" && item.loadingStatus === "LOADED" && <div className="op-transport-reconcile"><input aria-label={`Exception reason for ${item.consignmentNo}`} placeholder="Reason for missing/damaged" value={exceptionReasons[item.consignmentNo] ?? ""} onChange={(event) => setExceptionReasons((current) => ({ ...current, [item.consignmentNo]: event.target.value }))} /><button className="op-row-link" type="button" disabled={busy} onClick={() => void mutate(`/api/hub-manager/trips/${trip.tripId}/manifest/${encodeURIComponent(item.consignmentNo)}/reconcile`, { condition: "RECEIVED" })}>Confirm physical receipt</button><button className="op-row-link" type="button" disabled={busy || (exceptionReasons[item.consignmentNo] ?? "").trim().length < 5} onClick={() => void mutate(`/api/hub-manager/trips/${trip.tripId}/manifest/${encodeURIComponent(item.consignmentNo)}/reconcile`, { condition: "MISSING", reason: exceptionReasons[item.consignmentNo] })}>Record missing</button><button className="op-row-link" type="button" disabled={busy || (exceptionReasons[item.consignmentNo] ?? "").trim().length < 5} onClick={() => void mutate(`/api/hub-manager/trips/${trip.tripId}/manifest/${encodeURIComponent(item.consignmentNo)}/reconcile`, { condition: "DAMAGED", reason: exceptionReasons[item.consignmentNo] })}>Record damaged</button></div>}
        {canManageDestination(trip) && ["ARRIVED", "CLOSED"].includes(trip.status) && ["MISSING", "DAMAGED"].includes(item.loadingStatus) && <div className="op-transport-reconcile"><input aria-label={`Resolution details for ${item.consignmentNo}`} placeholder="How was this exception resolved?" value={exceptionReasons[item.consignmentNo] ?? ""} onChange={(event) => setExceptionReasons((current) => ({ ...current, [item.consignmentNo]: event.target.value }))} /><button className="op-row-link" type="button" disabled={busy || (exceptionReasons[item.consignmentNo] ?? "").trim().length < 5} onClick={() => void mutate(`/api/hub-manager/trips/${trip.tripId}/manifest/${encodeURIComponent(item.consignmentNo)}/resolve`, { reason: exceptionReasons[item.consignmentNo] })}>Resolve + confirm receipt</button></div>}
        </td></tr>)}</tbody></table></div>
      {canManageOrigin(trip) && trip.status === "READY_TO_DEPART" && <button className="op-button-primary" type="button" disabled={busy} onClick={() => void mutate(`/api/hub-manager/trips/${trip.tripId}/dispatch`)}>Dispatch load</button>}
      {canManageDestination(trip) && trip.status === "IN_TRANSIT" && <button className="op-button-primary" type="button" disabled={busy} onClick={() => void mutate(`/api/hub-manager/trips/${trip.tripId}/arrive`)}>Arrived at hub · packages remain unreconciled</button>}
      {trip.status === "ARRIVED" && trip.pendingCount > 0 && <p className="op-method-note">Vehicle arrival is recorded. Reconcile each package individually before the trip closes.</p>}
    </section>;
  }
  const activeTripStatuses = new Set(["PLANNED", "LOADING", "READY_TO_DEPART", "IN_TRANSIT", "ARRIVED"]);
  const activeTrips = trips.filter((trip) => activeTripStatuses.has(trip.status));
  const outgoingTrips = activeTrips.filter(canManageOrigin);
  const incomingTrips = activeTrips.filter(canManageDestination);
  const loadHistory = trips.filter((trip) => ["CLOSED", "CANCELLED"].includes(trip.status));

  return <div className="op-transport-page">
    <section className="op-panel">
      <div className="op-panel-heading"><div><span className="op-eyebrow">HUB-TO-HUB MOVEMENT</span><h2>Hub Transport</h2></div></div>
      <label className="op-transport-origin"><span>Origin hub assigned to you</span><select required value={originHubId} onChange={(event) => setOriginHubId(event.target.value)}><option value="">Choose assigned hub</option>{hubs.map((hub) => <option key={hub.hubId} value={hub.hubId}>{hub.city} · {hub.hubId}</option>)}</select></label>
      {origin && <p className="op-method-note">Origin: <strong>{origin.city} · {origin.hubId}</strong>. Eligible shipments have a persisted physical receipt at this hub and are not assigned to an active load.</p>}
      <div className="op-transport-destinations" aria-label="Destination shipment counts">
        {!eligibleLoading && destinations.length === 0 && <p className="op-empty-inline">No shipments with a recorded receipt are ready to transport from this hub.</p>}
        {eligibleLoading && <p className="op-empty-inline" role="status" aria-busy="true">Loading eligible shipment destinations…</p>}
        {destinations.map((destination) => <button key={destination.hubId} className={destinationHubId === destination.hubId ? "op-transport-destination is-active" : "op-transport-destination"} type="button" onClick={() => { setDestinationHubId(destination.hubId); setSelectedShipments([]); setSearch(""); }}><span>{destination.city}<small>{destination.hubId}</small></span><strong>{destination.count}</strong></button>)}
      </div>
    </section>

    {destinationHubId && <section className="op-panel">
      <div className="op-panel-heading"><div><span className="op-eyebrow">DESTINATION MANIFEST</span><h2>{destinations.find((item) => item.hubId === destinationHubId)?.city ?? destinationHubId}</h2></div><span className="op-status-pill">{visibleShipments.length} shown · {selectedShipments.length}/30 selected</span></div>
      <p className="op-method-note">A load can contain up to 30 shipments. Select fewer to create another load for the remaining shipments.</p>
      <div className="op-transport-list-tools"><label>Search consignment<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Enter consignment number" /></label><button className="op-row-link" type="button" disabled={!visibleShipments.length || selectedShipments.length >= 30} onClick={() => setSelectedShipments((current) => { const selected = new Set(current); for (const shipment of visibleShipments) { if (selected.size >= 30) break; selected.add(shipment.consignmentNo); } return [...selected].slice(0, 30); })}>Select all shown</button><button className="op-row-link" type="button" onClick={() => setSelectedShipments((current) => current.filter((no) => !eligible.some((item) => item.destinationHubId === destinationHubId && item.consignmentNo === no)))}>Clear selection</button></div>
      <div className="op-table-wrap"><table className="op-table"><thead><tr><th>Select</th><th>Consignment</th><th>Customer / recipient</th><th>Next hop</th><th>Final destination</th><th>Milestone</th><th>Last updated</th><th>Eligibility</th></tr></thead><tbody>{visibleShipments.map((shipment) => <tr key={shipment.consignmentNo}><td><input aria-label={`Select ${shipment.consignmentNo}`} type="checkbox" checked={selectedShipments.includes(shipment.consignmentNo)} disabled={!selectedShipments.includes(shipment.consignmentNo) && selectedShipments.length >= 30} onChange={(event) => setSelectedShipments((current) => event.target.checked ? current.length < 30 ? [...current, shipment.consignmentNo] : current : current.filter((no) => no !== shipment.consignmentNo))} /></td><td>{shipment.consignmentNo}</td><td>{shipment.recipientName || "Name not recorded"}</td><td>{shipment.destinationCity} · {shipment.destinationHubId}</td><td>{shipment.finalDestinationCity} · {shipment.finalDestinationHubId}</td><td>{shipment.lastEvent.replaceAll("_", " ")}</td><td>{shipment.lastEventAt ? new Date(shipment.lastEventAt).toLocaleString() : "Not recorded"}</td><td><span className="op-status-pill">Eligible</span></td></tr>)}{!eligibleLoading && visibleShipments.length === 0 && <tr><td colSpan={8}>No eligible shipments match this destination and search.</td></tr>}</tbody></table></div>
      <div className="op-transport-selection-summary"><span>{selectedShipments.length} shipment(s) selected</span><button className="op-button-primary" type="button" disabled={!selectedShipments.length || busy} onClick={() => setModalOpen(true)}>Create Load</button></div>
    </section>}

    {error && <p className="op-error" role="alert">{error}</p>}{success && <p className="op-success" role="status">{success}</p>}
    <section className="op-transport-load-section"><div className="op-panel-heading"><div><span className="op-eyebrow">ORIGIN HUB</span><h2>Active / Created Loads</h2></div></div>{loading && <p className="op-empty-inline" role="status" aria-busy="true">Loading transport loads…</p>}{!loading && outgoingTrips.length === 0 && <p className="op-empty-inline">No loads created from your assigned hubs.</p>}{outgoingTrips.map(loadCard)}</section>
    <section className="op-transport-load-section"><div className="op-panel-heading"><div><span className="op-eyebrow">DESTINATION HUB</span><h2>Incoming Loads</h2></div></div>{!loading && incomingTrips.length === 0 && <p className="op-empty-inline">No incoming loads are addressed to your assigned hubs.</p>}{incomingTrips.map(loadCard)}</section>

    <section className="op-transport-load-section" aria-label="Completed transport load history">
      <div className="op-panel-heading"><div><span className="op-eyebrow">PERSISTED TRANSPORT RECORDS</span><h2>Load History</h2></div><span className="op-status-pill">{loadHistory.length} completed / cancelled</span></div>
      <p className="op-method-note">This list contains only loads recorded in the transport database. Shipment associations, manifest states, and timestamps come from saved records.</p>
      {loading && <p className="op-empty-inline" role="status" aria-busy="true">Loading load history…</p>}
      {!loading && loadHistory.length === 0 && <p className="op-empty-inline">No completed or cancelled transport loads are recorded for your assigned hubs.</p>}
      {loadHistory.map(loadCard)}
    </section>

    {modalOpen && <div className="op-transport-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setModalOpen(false); }}><section className="op-panel op-transport-modal" role="dialog" aria-modal="true" aria-labelledby="transport-modal-title"><div className="op-panel-heading"><div><span className="op-eyebrow">REVIEW MANIFEST</span><h2 id="transport-modal-title">Create transport load</h2></div><button type="button" className="op-row-link" disabled={busy} onClick={() => setModalOpen(false)}>Close</button></div><p className="op-method-note">{origin?.city} · {originHubId} → {destinations.find((item) => item.hubId === destinationHubId)?.city} · {selectedRows.length} selected (maximum 30)</p><div className="op-transport-modal-manifest">{selectedRows.map((shipment) => <div key={shipment.consignmentNo}><strong>{shipment.consignmentNo}</strong><span>{shipment.recipientName || "Name not recorded"} · Next: {shipment.destinationCity} · Final: {shipment.finalDestinationCity}</span></div>)}</div><form className="op-transport-create" onSubmit={(event) => void createTrip(event)}><label><span>Vehicle registration</span><input required maxLength={30} value={vehicleNumber} onChange={(event) => setVehicleNumber(event.target.value)} /></label><label><span>Driver name</span><input required maxLength={255} value={driverName} onChange={(event) => setDriverName(event.target.value)} /></label><label><span>Driver phone (optional)</span><input maxLength={40} value={driverPhone} onChange={(event) => setDriverPhone(event.target.value)} /></label><label><span>Scheduled departure (optional)</span><input type="datetime-local" value={departure} onChange={(event) => setDeparture(event.target.value)} /></label><label><span>Remarks (optional)</span><input maxLength={1000} value={remarks} onChange={(event) => setRemarks(event.target.value)} /></label><button className="op-button-primary" type="submit" disabled={busy || !selectedRows.length || selectedRows.length > 30}>{busy ? "Creating load…" : `Confirm load · ${selectedRows.length} shipments`}</button></form></section></div>}
  </div>;
}
