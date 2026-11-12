import { useMemo, useState } from "react";

type HubPoint = { hubId: string; city: string | null; latitude: number | string | null; longitude: number | string | null };
type ShipmentEvent = { eventTime: string; eventType: string; hubId: string | null; hubCity: string | null; hubLatitude?: number | string | null; hubLongitude?: number | string | null };
type ShipmentRoute = { consignmentNo: string; status: string | null; origin: HubPoint; destination: HubPoint; events: ShipmentEvent[] };
type Stop = { hubId: string; city: string; latitude: number; longitude: number; eventType?: string };

function point(hub: HubPoint, eventType?: string): Stop | null {
  if (hub.latitude === null || hub.latitude === undefined || hub.longitude === null || hub.longitude === undefined || String(hub.latitude).trim() === "" || String(hub.longitude).trim() === "") return null;
  const latitude = Number(hub.latitude), longitude = Number(hub.longitude);
  if (!hub.hubId || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { hubId: hub.hubId, city: hub.city?.trim() || hub.hubId, latitude, longitude, eventType };
}

export function CustomerShipmentRouteMap({ shipment }: { shipment: ShipmentRoute }) {
  const [routeSelected, setRouteSelected] = useState(false);
  const model = useMemo(() => {
    const origin = point(shipment.origin);
    const destination = point(shipment.destination);
    const movementTypes = new Set(["ARRIVED_AT_ORIGIN_HUB", "RECEIVED_AT_ORIGIN_HUB", "ARRIVED_AT_HUB", "RECEIVED_AT_HUB", "ARRIVED_AT_DESTINATION_HUB", "RECEIVED_AT_DESTINATION_HUB", "DELIVERED"]);
    const eventStops = shipment.events.flatMap((event) => {
      if (!movementTypes.has(event.eventType) || !event.hubId) return [];
      const stop = point({ hubId: event.hubId, city: event.hubCity, latitude: event.hubLatitude ?? null, longitude: event.hubLongitude ?? null }, event.eventType);
      return stop ? [stop] : [];
    });
    const observed = [...(origin ? [origin] : [])];
    for (const stop of eventStops) if (observed.at(-1)?.hubId !== stop.hubId) observed.push(stop);
    const hasFinalArrival = eventStops.some((stop) => stop.hubId === shipment.destination.hubId && ["ARRIVED_AT_DESTINATION_HUB", "RECEIVED_AT_DESTINATION_HUB", "DELIVERED"].includes(stop.eventType ?? ""));
    if (hasFinalArrival && destination && observed.at(-1)?.hubId !== destination.hubId) observed.push(destination);
    const coords = [...observed, ...(destination ? [destination] : [])];
    if (!coords.length) return { stops: [] as Array<Stop & { x: number; y: number }>, destinationMarker: null, path: "", hasFinalArrival };
    const minLon = Math.min(...coords.map((stop) => stop.longitude));
    const maxLon = Math.max(...coords.map((stop) => stop.longitude));
    const minLat = Math.min(...coords.map((stop) => stop.latitude));
    const maxLat = Math.max(...coords.map((stop) => stop.latitude));
    const width = 800, height = 420, pad = 64;
    const lonSpan = Math.max(maxLon - minLon, 0.15), latSpan = Math.max(maxLat - minLat, 0.15);
    const scale = Math.min((width - pad * 2) / lonSpan, (height - pad * 2) / latSpan);
    const mapWidth = lonSpan * scale, mapHeight = latSpan * scale;
    const xOffset = (width - mapWidth) / 2, yOffset = (height - mapHeight) / 2;
    const projectStop = (stop: Stop) => ({ ...stop, x: xOffset + (stop.longitude - minLon) * scale, y: height - yOffset - (stop.latitude - minLat) * scale });
    const projected = observed.map(projectStop);
    return { stops: projected, destinationMarker: destination ? projectStop(destination) : null, path: projected.map((stop, index) => `${index ? "L" : "M"}${stop.x.toFixed(2)},${stop.y.toFixed(2)}`).join(" "), hasFinalArrival };
  }, [shipment]);
  const completed = shipment.events.some((event) => event.eventType === "DELIVERED");
  const hasCoordinates = model.stops.length > 0;

  if (!hasCoordinates) return <section className="customer-shipment-route-map" aria-label="Shipment route map"><p className="customer-pricing-note">A route map is unavailable because verified coordinates are missing for the recorded hubs.</p></section>;
  return <section className="customer-shipment-route-map" aria-label={`Recorded route for ${shipment.consignmentNo}`}>
    <div className="customer-shipment-route-map-heading"><div><span className="customer-kicker">RECORDED HUB MOVEMENT</span><h3>{completed ? "Completed route" : "Recorded progress"}</h3></div><span className={`customer-route-state ${completed ? "is-complete" : "is-active"}`}>{completed ? "Delivered event recorded" : "In progress / incomplete"}</span></div>
    {model.path ? <div className="customer-shipment-route-map-frame"><svg viewBox="0 0 800 420" role="img" aria-label={`${completed ? "Completed" : "Recorded"} shipment route map`} preserveAspectRatio="xMidYMid meet"><defs><marker id="customer-route-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill={completed ? "#139a70" : "#2484c3"}/></marker></defs><path d={model.path} className={`customer-recorded-route-line${completed ? " is-complete" : " is-active"}`} markerEnd="url(#customer-route-arrow)" role="button" tabIndex={0} onClick={() => setRouteSelected((value) => !value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setRouteSelected((value) => !value); } }}><title>{shipment.consignmentNo} · {model.stops.length} recorded hub stops · select for route details</title></path>{model.stops.map((stop, index) => <g key={`${stop.hubId}-${index}`} className="customer-recorded-route-stop"><circle cx={stop.x} cy={stop.y} r={index === 0 || index === model.stops.length - 1 ? 9 : 7}/><text x={stop.x} y={stop.y - 16} textAnchor="middle">{stop.city}</text><title>{stop.city} · {stop.hubId}{stop.eventType ? ` · ${stop.eventType.replaceAll("_", " ")}` : " · Shipment origin"}</title></g>)}{model.destinationMarker && !model.hasFinalArrival && <g className="customer-recorded-destination-marker"><circle cx={model.destinationMarker.x} cy={model.destinationMarker.y} r="10"/><text x={model.destinationMarker.x} y={model.destinationMarker.y - 17} textAnchor="middle">{model.destinationMarker.city} · destination</text><title>{model.destinationMarker.city} · {model.destinationMarker.hubId} · final destination, arrival not recorded</title></g>}</svg></div> : <p className="customer-pricing-note">The shipment has hub coordinates, but no persisted movement event is available to draw a traveled route. No route has been inferred.</p>}
    {routeSelected && <div className="customer-recorded-route-details" aria-live="polite"><strong>{shipment.consignmentNo} · 1 shipment</strong><ol>{model.stops.map((stop, index) => <li key={`${stop.hubId}-${index}`}><span>{stop.city} · {stop.hubId}</span><small>{stop.eventType ? stop.eventType.replaceAll("_", " ") : "Recorded origin"}</small></li>)}</ol></div>}
    <p className="customer-pricing-note">Stops come from persisted shipment events and hub coordinates. Missing coordinates and unrecorded intermediate hubs are not guessed.</p>
  </section>;
}
