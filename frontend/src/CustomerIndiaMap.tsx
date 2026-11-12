import { memo, useEffect, useMemo, useState } from "react";

type Point = [number, number, ...number[]];
type Ring = Point[];
type GeoFeature = { properties: { shapeName: string; shapeISO?: string }; geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] } };
type GeoCollection = { features: GeoFeature[] };
type Destination = { destination: string; shipments: number; delivered: number; active: number; hubs: Array<{ hubId: string; city: string; shipments: number }> };
type StateRoute = { origin: string; destination: string; shipments: number };
const NO_STATE_ROUTES: StateRoute[] = [];
const NO_HIGHLIGHTS: string[] = [];

function stateKey(value: string) {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string> = {
    orissa: "odisha", pondicherry: "puducherry", uttaranchal: "uttarakhand",
    andamannicobar: "andamanandnicobarislands", andamanandnicobarislands: "andamanandnicobarislands",
    dadraandnagarhaveli: "dadranagarhavelianddamananddiu",
    dadraandnagarhavelianddamananddiu: "dadranagarhavelianddamananddiu",
    jammuandkashmir: "jammuandkashmir", jammuandkashmirunionterritory: "jammuandkashmir",
    nctofdelhi: "delhi", nationalcapitalterritoryofdelhi: "delhi",
  };
  return aliases[normalized] ?? normalized;
}

function ringsFor(feature: GeoFeature): Ring[] {
  return feature.geometry.type === "Polygon"
    ? [feature.geometry.coordinates[0] ?? []]
    : feature.geometry.coordinates.flatMap((polygon) => polygon[0] ? [polygon[0]] : []);
}

function polygonPath(rings: Ring[], project: (point: Point) => [number, number]) {
  return rings.map((ring) => ring.map((point, index) => {
    const [x, y] = project(point);
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ") + " Z").join(" ");
}

export const CustomerIndiaMap = memo(function CustomerIndiaMap({ destinations, active = true, routes = NO_STATE_ROUTES, highlightStates = NO_HIGHLIGHTS, shipmentRoute, onSelectState }: {
  destinations: Destination[];
  active?: boolean;
  routes?: StateRoute[];
  highlightStates?: string[];
  shipmentRoute?: { origin: string; destination: string; progress: number; milestone: string };
  onSelectState?: (state: string) => void;
}) {
  const [geometry, setGeometry] = useState<GeoCollection | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState("");
  const [hovered, setHovered] = useState("");
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetch("/maps/india-states.geojson")
      .then((response) => { if (!response.ok) throw new Error("Map boundary data unavailable"); return response.json() as Promise<GeoCollection>; })
      .then((data) => { if (!Array.isArray(data?.features) || data.features.length === 0) throw new Error("Map boundary data has no state features"); return data; })
      .then((data) => { if (alive) setGeometry(data); })
      .catch((error: unknown) => { console.error("[Customer India map failed to load]", error); if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, [active]);

  const mapModel = useMemo(() => {
    if (!geometry?.features.length) return null;
    const allPoints = geometry.features.flatMap((feature) => ringsFor(feature)).flat();
    const longitudes = allPoints.map((point) => point[0]);
    const latitudes = allPoints.map((point) => point[1]);
    const minLon = Math.min(...longitudes), maxLon = Math.max(...longitudes);
    const minLat = Math.min(...latitudes), maxLat = Math.max(...latitudes);
    const width = 560, height = 510, padding = 12;
    const scale = Math.min((width - padding * 2) / (maxLon - minLon), (height - padding * 2) / (maxLat - minLat));
    const mapWidth = (maxLon - minLon) * scale, mapHeight = (maxLat - minLat) * scale;
    const xOffset = (width - mapWidth) / 2, yOffset = (height - mapHeight) / 2;
    const project = (point: Point): [number, number] => [xOffset + (point[0] - minLon) * scale, height - yOffset - (point[1] - minLat) * scale];
    const counts = new Map(destinations.map((item) => [stateKey(item.destination), item]));
    const centers = new Map<string, [number, number]>();
    for (const feature of geometry.features) {
      const points = ringsFor(feature).flat();
      if (!points.length) continue;
      const center = project([
        points.reduce((sum, point) => sum + point[0], 0) / points.length,
        points.reduce((sum, point) => sum + point[1], 0) / points.length,
      ]);
      centers.set(stateKey(feature.properties.shapeName), center);
    }
    const curve = (origin: string, destination: string) => {
      const from = centers.get(stateKey(origin)), to = centers.get(stateKey(destination));
      if (!from || !to) return null;
      const bend = Math.max(-34, Math.min(34, (from[0] - to[0]) * 0.12));
      const control: [number, number] = [(from[0] + to[0]) / 2 + bend, (from[1] + to[1]) / 2 - Math.min(46, Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.16)];
      return { from, to, control, path: `M${from[0]},${from[1]} Q${control[0]},${control[1]} ${to[0]},${to[1]}` };
    };
    return {
      features: geometry.features.map((feature) => ({
        name: feature.properties.shapeName,
        route: counts.get(stateKey(feature.properties.shapeName)),
        path: polygonPath(ringsFor(feature), project),
        highlighted: highlightStates.some((state) => stateKey(state) === stateKey(feature.properties.shapeName)),
      })),
      routes: routes.map((route) => ({ ...route, curve: curve(route.origin, route.destination) })).filter((route) => route.curve),
      shipmentRoute: shipmentRoute ? curve(shipmentRoute.origin, shipmentRoute.destination) : null,
      shipmentPoint: shipmentRoute ? (() => {
        const route = curve(shipmentRoute.origin, shipmentRoute.destination);
        if (!route) return null;
        const t = Math.max(0, Math.min(1, shipmentRoute.progress));
        const u = 1 - t;
        return [u * u * route.from[0] + 2 * u * t * route.control[0] + t * t * route.to[0], u * u * route.from[1] + 2 * u * t * route.control[1] + t * t * route.to[1]] as [number, number];
      })() : null,
      viewBox: `0 0 ${width} ${height}`,
    };
  }, [geometry, destinations, routes, highlightStates, shipmentRoute]);

  const selectedSummary = destinations.find((item) => stateKey(item.destination) === stateKey(selected));
  const maximum = Math.max(1, ...destinations.map((item) => item.shipments));
  const color = (value: number) => {
    const t = Math.min(1, value / maximum);
    return `hsl(${204 - t * 20} ${54 + t * 28}% ${34 + t * 22}%)`;
  };
  const hoverSummary = destinations.find((item) => stateKey(item.destination) === stateKey(hovered));
  const zoomedViewBox = (() => {
    const width = 560 / zoom, height = 510 / zoom;
    return `${(560 - width) / 2} ${(510 - height) / 2} ${width} ${height}`;
  })();

  return <div className="customer-map-shell" aria-label="India destination shipment map">
    {loadError ? <p className="customer-map-message" role="status">The state boundary map could not load. Destination figures remain available in the charts.</p> : !mapModel ? <div className="customer-map-placeholder" role="status">Loading state boundary map…</div> : <>
      <div className="customer-map-visual">
      <svg className={`customer-india-map${shipmentRoute ? " customer-india-map-tracking" : ""}`} viewBox={zoomedViewBox} role="group" aria-label="India map with recorded shipment states and state-level routes">
        {mapModel.routes.map((route, index) => route.curve && <path key={`${route.origin}-${route.destination}-${index}`} d={route.curve.path} className={`customer-state-route${selected && (stateKey(route.origin) === stateKey(selected) || stateKey(route.destination) === stateKey(selected)) ? " is-connected" : ""}`} strokeWidth={1.4 + Math.min(3, route.shipments / 1000)}><title>{route.origin} to {route.destination}: {route.shipments.toLocaleString()} shipment records; state-level visualization</title></path>)}
        {mapModel.shipmentRoute && <path d={mapModel.shipmentRoute.path} className="customer-shipment-route"/>}
        {mapModel.features.map((feature) => <path key={feature.name} d={feature.path} fill={feature.route ? color(feature.route.shipments) : "#182a46"} className={`customer-map-state${feature.route ? " customer-map-state-active" : ""}${feature.highlighted ? " customer-map-state-highlighted" : ""}`} tabIndex={0} role="button" aria-label={`${feature.name}: ${feature.route?.shipments.toLocaleString() ?? "no matching destination shipment records"}`} onMouseEnter={() => { setSelected(feature.name); setHovered(feature.name); }} onMouseLeave={() => setHovered("")} onFocus={() => { setSelected(feature.name); setHovered(feature.name); }} onBlur={() => setHovered("")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(feature.name); setHovered(feature.name); onSelectState?.(feature.name); } }} onClick={() => { setSelected(feature.name); onSelectState?.(feature.name); }}><title>{feature.name}: {feature.route ? `${feature.route.shipments.toLocaleString()} destination shipments` : "No matching destination shipment records"}</title></path>)}
        {mapModel.shipmentPoint && <g className="customer-shipment-progress-marker" transform={`translate(${mapModel.shipmentPoint[0]},${mapModel.shipmentPoint[1]})`} aria-label={`Milestone progress: ${shipmentRoute?.milestone}; this is not a GPS position`}><circle r="11"/><circle r="4"/><title>{shipmentRoute?.milestone} — milestone progress only, not GPS</title></g>}
      </svg>
      <div className="customer-map-zoom-controls" aria-label="Map zoom controls"><button type="button" aria-label="Zoom in" disabled={zoom>=2.2} onClick={()=>setZoom(value=>Math.min(2.2,Number((value+.2).toFixed(1))))}>+</button><button type="button" aria-label="Zoom out" disabled={zoom<=1} onClick={()=>setZoom(value=>Math.max(1,Number((value-.2).toFixed(1))))}>-</button><button type="button" aria-label="Reset map zoom" disabled={zoom===1} onClick={()=>setZoom(1)}>Reset</button></div>
      {hovered && <aside className="customer-map-tooltip" role="status" aria-live="polite"><strong>{hovered}</strong>{hoverSummary ? <><span>{hoverSummary.shipments.toLocaleString()} destination shipments · {hoverSummary.delivered.toLocaleString()} delivered</span><small>Destination hubs in recorded shipments</small>{hoverSummary.hubs.length ? <><ul>{hoverSummary.hubs.slice(0, 4).map((hub) => <li key={hub.hubId}><span>{hub.city} <small>({hub.hubId})</small></span><b>{hub.shipments.toLocaleString()}</b></li>)}</ul>{hoverSummary.hubs.length > 4 && <span>and {hoverSummary.hubs.length - 4} more linked hubs</span>}</> : <span>No destination hub is linked in these shipment records.</span>}</> : <span>No destination shipment records for this state.</span>}</aside>}
      </div>
      <div className="customer-map-legend"><span>Fewer destinations</span><i/><i/><i/><i/><span>More destinations</span></div>
      <div className="customer-map-selection" aria-live="polite"><strong>{selected || "Explore destination states"}</strong><span>{selectedSummary ? `${selectedSummary.shipments.toLocaleString()} shipments · ${selectedSummary.delivered.toLocaleString()} delivered` : selected ? "No matching destination records" : "Hover, focus or select a state to see recorded activity."}</span>{selectedSummary?.hubs.length ? <span>Destination hubs in records: {selectedSummary.hubs.slice(0,4).map((hub) => `${hub.city} (${hub.hubId})`).join(" · ")}{selectedSummary.hubs.length > 4 ? ` · and ${selectedSummary.hubs.length-4} more` : ""}</span> : null}</div>
      <small className="customer-map-attribution">State boundaries: LGD snapshot 2024 · CC0 / CC BY 4.0</small>
    </>}
  </div>;
});
