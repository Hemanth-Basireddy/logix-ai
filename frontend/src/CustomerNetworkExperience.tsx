import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Data, Layout } from "plotly.js";
import type { CustomerHomeSummary, CustomerHub } from "./CustomerHomeInsights";
import { CustomerIndiaMap } from "./CustomerIndiaMap";

const PlotlyChart = lazy(() => import("./CustomerPlotlyChart"));
const CustomerRouteSankey = lazy(() => import("./CustomerRouteSankey"));
type Network = CustomerHomeSummary["companyNetwork"];
const number = (value: number) => value.toLocaleString("en-IN");
const normalizeState = (value: string) => {
  const key = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string> = { orissa: "odisha", pondicherry: "puducherry", uttaranchal: "uttarakhand", andamannicobar: "andamanandnicobarislands", dadraandnagarhaveli: "dadranagarhavelianddamananddiu", dadraandnagarhavelianddamananddiu: "dadranagarhavelianddamananddiu", nctofdelhi: "delhi", nationalcapitalterritoryofdelhi: "delhi" };
  return aliases[key] ?? key;
};

function StorySection({ children, className = "", label }: { children: (visible: boolean) => ReactNode; className?: string; label: string }) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "180px 0px", threshold: 0.04 });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <section ref={ref} aria-label={label} className={`customer-story-section${visible ? " customer-story-visible" : ""} ${className}`}>{children(visible)}</section>;
}

function ChartFrame({ label, visible, data, layout, className = "" }: { label: string; visible: boolean; data: Data[]; layout: Partial<Layout>; className?: string }) {
  const [failed, setFailed] = useState(false);
  return <div className={`customer-plot-frame ${className}`} role="region" aria-label={label}>
    {failed ? <div className="customer-chart-placeholder" role="status">This visual could not load. The underlying shipment data is still available.</div> : visible ? <Suspense fallback={<div className="customer-chart-placeholder">Loading network visual…</div>}><PlotlyChart data={data} layout={layout} onError={(error) => { console.error(`[Customer chart failed: ${label}]`, error); setFailed(true); }} /></Suspense> : <div className="customer-chart-placeholder">Scroll to activate this visual.</div>}
  </div>;
}

const baseLayout: Partial<Layout> = {
  autosize: true,
  height: 340,
  margin: { l: 44, r: 18, t: 18, b: 46 },
  font: { family: "Inter, Manrope, system-ui, sans-serif", size: 11, color: "#9fb4d0" },
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  xaxis: { gridcolor: "rgba(118,154,198,.12)", zeroline: false, automargin: true, tickfont: { color: "#8fa7c6" } },
  yaxis: { gridcolor: "rgba(118,154,198,.12)", zeroline: false, automargin: true, tickfont: { color: "#8fa7c6" } },
  showlegend: false,
  hoverlabel: { bgcolor: "#10213b", bordercolor: "#31557d", font: { color: "#f1f7ff" } },
};

export function CustomerNetworkExperience({ network, hubs, section = "all" }: { network: Network; hubs: CustomerHub[]; section?: "all" | "network" | "analytics" | "journey" }) {
  const experienceRef = useRef<HTMLDivElement>(null);
  const [selectedState, setSelectedState] = useState("");
  const [selectedHubId, setSelectedHubId] = useState("");
  useEffect(() => {
    if (section !== "network") return;
    const element = experienceRef.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const bounds = element.getBoundingClientRect();
        const progress = Math.max(0, Math.min(1, (window.innerHeight - bounds.top) / (bounds.height + window.innerHeight)));
        element.style.setProperty("--story-scroll", progress.toFixed(3));
        element.style.setProperty("--story-map-scale", reduceMotion ? "1" : (1 + progress * 0.075).toFixed(3));
        element.style.setProperty("--route-opacity", reduceMotion ? ".55" : (0.22 + progress * 0.72).toFixed(3));
        document.querySelector<HTMLElement>(".customer-cinematic-hero")?.style.setProperty("--hero-map-scale", reduceMotion ? "1" : (1 + progress * 0.13).toFixed(3));
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [section]);
  const hasNetwork = network.totalShipments > 0;
  const showNetwork = section === "all" || section === "network";
  const showAnalytics = section === "all" || section === "analytics";
  const showJourney = section === "all" || section === "journey";
  const otherStateCount = Math.max(0, network.totalShipments - network.deliveredShipments - network.activeShipments);
  const destinations = useMemo(() => [...network.destinationSummary].filter((item) => item.shipments > 0).sort((a, b) => b.shipments - a.shipments).slice(0, 10), [network.destinationSummary]);
  const monthlyData = useMemo<Data[]>(() => [{
    type: "scatter", mode: "lines+markers", x: network.monthlyShipmentActivity.map((item) => item.month), y: network.monthlyShipmentActivity.map((item) => item.shipments),
    name: "Shipment records", line: { color: "#41d8ff", width: 3, shape: "spline" }, marker: { color: "#a3f1ff", size: 7 },
    fill: "tozeroy", fillcolor: "rgba(65,216,255,.10)", hovertemplate: "%{x|%b %Y}<br><b>%{y:,}</b> shipment records<extra></extra>",
  }], [network.monthlyShipmentActivity]);
  const destinationData = useMemo<Data[]>(() => [{
    type: "bar", orientation: "h", name: "Delivered", y: destinations.map((item) => item.destination), x: destinations.map((item) => item.delivered), marker: { color: "#4de2c2" }, hovertemplate: "%{y}<br>%{x:,} delivered<extra></extra>",
  }, {
    type: "bar", orientation: "h", name: "Active", y: destinations.map((item) => item.destination), x: destinations.map((item) => item.active), marker: { color: "#4c9dff" }, hovertemplate: "%{y}<br>%{x:,} active<extra></extra>",
  }, {
    type: "bar", orientation: "h", name: "Other / no milestone", y: destinations.map((item) => item.destination), x: destinations.map((item) => Math.max(0, item.shipments - item.delivered - item.active)), marker: { color: "#536783" }, hovertemplate: "%{y}<br>%{x:,} other / no current milestone<extra></extra>",
  }], [destinations]);
  const deliveryData = useMemo<Data[]>(() => [{
    type: "pie", hole: 0.68, sort: false,
    labels: ["Delivered", "Active", "Other / no current milestone"],
    values: [network.deliveredShipments, network.activeShipments, otherStateCount],
    marker: { colors: ["#4de2c2", "#4c9dff", "#536783"], line: { color: "#08162a", width: 3 } },
    textinfo: "none", hovertemplate: "%{label}<br><b>%{value:,}</b> shipments (%{percent})<extra></extra>",
  }], [network.deliveredShipments, network.activeShipments, otherStateCount, network.totalShipments]);
  const destinationsLayout = useMemo<Partial<Layout>>(() => ({ ...baseLayout, height: Math.max(330, Math.min(560, destinations.length * 39 + 90)), margin: { l: 118, r: 18, t: 16, b: 40 }, barmode: "stack", showlegend: true, legend: { orientation: "h", y: 1.12, x: 0, font: { size: 10, color: "#a7bad3" } }, yaxis: { ...baseLayout.yaxis, autorange: "reversed" } }), [destinations.length]);

  const hubShipmentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const destination of network.destinationSummary) for (const hub of destination.hubs) counts.set(hub.hubId, (counts.get(hub.hubId) ?? 0) + hub.shipments);
    return counts;
  }, [network.destinationSummary]);
  const selectedHub = hubs.find((hub) => hub.hubId === selectedHubId);
  const selectedHubDestinations = useMemo(() => network.destinationSummary.filter((destination) => destination.hubs.some((hub) => hub.hubId === selectedHubId)), [network.destinationSummary, selectedHubId]);
  const visibleHubs = useMemo(() => hubs.filter((hub) => !selectedState || network.destinationSummary.find((destination) => normalizeState(destination.destination) === normalizeState(selectedState))?.hubs.some((linked) => linked.hubId === hub.hubId)), [hubs, network.destinationSummary, selectedState]);

  return <div ref={experienceRef} id="customer-network-story" className="customer-network-experience">
    {showNetwork && <StorySection label="Company network scale" className="customer-scale-section">{(visible) => <div className="customer-story-inner customer-scale-story">
      <div className="customer-section-number">01</div>
      <div className="customer-section-heading"><span className="customer-kicker">THE NETWORK BEHIND THE SCREEN</span><h2>Not just your parcel. <em>The whole network.</em></h2><p>Company-level figures below come from the recorded shipment dataset for this tenant. They are separate from your personal account totals.</p></div>
      {hasNetwork ? <div className="customer-scale-metric-row">
        <div className="customer-scale-feature"><span>Total shipment records</span><strong>{number(network.totalShipments)}</strong><small>company-wide</small></div>
        <div><span>Customers represented</span><strong>{number(network.customersServed)}</strong><small>unique customer records</small></div>
        <div><span>States covered</span><strong>{number(network.statesCovered)}</strong><small>recorded address states</small></div>
        <div><span>Hub locations</span><strong>{number(network.hubsCovered)}</strong><small>recorded route hubs</small></div>
      </div> : <p className="customer-network-empty-state">Network figures will appear as company shipment history grows.</p>}
      <div className={`customer-scroll-line ${visible ? "is-visible" : ""}`} aria-hidden="true"><i /></div>
    </div>}</StorySection>}

    {showNetwork && <StorySection label="India destination network map" className="customer-map-story">{(visible) => <div className="customer-story-inner customer-map-story-layout">
      <div className="customer-section-number">02</div>
      <div className="customer-map-copy"><span className="customer-kicker">INDIA, BY RECORDED DESTINATION</span><h2>See where the network <em>actually reaches.</em></h2><p>Hover, focus or select a state. The map uses recorded receiver-state activity and linked destination hubs.</p><div className="customer-map-callout"><strong>{number(network.destinationSummary.filter((item) => item.shipments > 0).length)}</strong><span>destination states with shipment activity</span></div></div>
      <div className="customer-map-visual-wrap"><CustomerIndiaMap active={visible} destinations={network.destinationSummary} routes={network.routeSummary} onSelectState={setSelectedState}/></div>
      <aside className="customer-hub-explorer" aria-label="Company hub directory">
        <div><span className="customer-kicker">ACTIVE HUB DIRECTORY</span><h3>{selectedState ? `Hubs linked to ${selectedState}` : `${number(hubs.length)} active hub records`}</h3><p>Hub records provide IDs and cities. Coordinates, contacts and hub-level delivery metrics are not available in the customer API.</p>{selectedState&&<button type="button" className="customer-hub-clear" onClick={()=>setSelectedState("")}>Show all hubs</button>}</div>
        <div className="customer-hub-list">{visibleHubs.length ? visibleHubs.map((hub) => <button type="button" key={hub.hubId} className={selectedHubId === hub.hubId ? "customer-hub-row is-selected" : "customer-hub-row"} onClick={() => setSelectedHubId(hub.hubId)}><i aria-hidden="true"/><span><strong>{hub.city}</strong><small>{hub.hubId} · destination</small></span><b>{number(hubShipmentCounts.get(hub.hubId) ?? 0)}</b></button>) : <p className="customer-hub-empty">No destination hub records are linked to the selected state.</p>}</div>
        {selectedHub && <div className="customer-hub-detail" aria-live="polite"><strong>{selectedHub.city} · {selectedHub.hubId}</strong><span>{number(hubShipmentCounts.get(selectedHub.hubId) ?? 0)} recorded destination shipments linked to this hub</span>{selectedHubDestinations.length > 0 && <small>Recorded destination states: {selectedHubDestinations.map((destination) => destination.destination).join(", ")}</small>}</div>}
      </aside>
      <div className="customer-destination-chart"><span className="customer-kicker">DESTINATION ACTIVITY</span><h3>Where the shipment records concentrate</h3>{destinations.length ? <ChartFrame label="Shipment volume by destination state" visible={visible} data={destinationData} layout={destinationsLayout}/> : <p className="customer-network-empty-state">Destination insights will appear when receiver-state data is recorded.</p>}</div>
    </div>}</StorySection>}

    {showAnalytics && <StorySection label="Shipment movement over time" className="customer-movement-story">{(visible) => <div className="customer-story-inner">
      <div className="customer-section-number">03</div>
      <div className="customer-section-heading"><span className="customer-kicker">TIME, NOT JUST TOTALS</span><h2>Watch the network <em>move.</em></h2><p>Monthly activity uses recorded shipment dates. It shows volume over time rather than pretending historical records are live operational events.</p></div>
      <div className="customer-movement-grid">
        <article className="customer-chart-article customer-chart-large"><div className="customer-chart-heading"><span>MONTHLY SHIPMENT ACTIVITY</span><strong>{number(network.totalShipments)}</strong></div>{network.monthlyShipmentActivity.length ? <ChartFrame label="Company monthly shipment activity" visible={visible} data={monthlyData} layout={{ ...baseLayout, height: 390, xaxis: { ...baseLayout.xaxis, title: { text: "Month", font: { size: 10 } }, type: "date", tickformat: "%b %y" }, yaxis: { ...baseLayout.yaxis, title: { text: "Shipment records", font: { size: 10 } }, rangemode: "tozero" } }}/> : <p className="customer-network-empty-state">Monthly activity will appear when shipment dates are available.</p>}</article>
        <article className="customer-chart-article customer-chart-status"><div className="customer-chart-heading"><span>LATEST PERSISTED EVENTS</span><strong>STATUS</strong></div>{hasNetwork ? <><ChartFrame label="Company shipment status distribution" visible={visible} data={deliveryData} layout={{ ...baseLayout, height: 310, margin: { l: 10, r: 10, t: 10, b: 10 }, showlegend: false, annotations: [{ text: number(network.totalShipments), x: .5, y: .5, showarrow: false, font: { size: 22, color: "#edf4ff" } }] }}/><p className="customer-chart-note">Delivered and active counts require persisted shipment events. The remaining group includes records without a current movement milestone.</p></> : <p className="customer-network-empty-state">Recorded delivery status will appear as shipments progress.</p>}</article>
      </div>
    </div>}</StorySection>}

    {showNetwork && <StorySection label="Origin and destination route relationships" className="customer-routes-story">{(visible) => <div className="customer-story-inner customer-route-story-inner">
      <div className="customer-section-number">04</div>
      <div className="customer-route-story-copy"><span className="customer-kicker">ROUTES FROM REAL RECORDS</span><h2>Relationships, <em>not decoration.</em></h2><p>Flow width represents recorded shipment volume grouped by sender and receiver states. It is not a simulated traffic map.</p></div>
      {network.routeSummary.length ? <div className="customer-route-sankey"><Suspense fallback={<div className="customer-chart-placeholder">Loading route-flow visual…</div>}>{visible && <CustomerRouteSankey routes={network.routeSummary}/>}</Suspense></div> : <p className="customer-network-empty-state">Route relationships will appear as sender and receiver state data becomes available.</p>}
    </div>}</StorySection>}

    {showJourney && <StorySection label="Shipment journey" className="customer-journey-story">{() => <div className="customer-story-inner">
      <div className="customer-section-number">05</div>
      <div className="customer-section-heading"><span className="customer-kicker">FROM PICKUP TO DOORSTEP</span><h2>Every handoff has a <em>record.</em></h2><p>The sequence below describes the operational milestones the customer portal can show. Your shipment timeline contains only events actually persisted for that shipment.</p></div>
      <div className="customer-example-route"><span>ILLUSTRATIVE ROUTE EXAMPLE · NO SHIPMENT DATA</span><strong>Hyderabad, Telangana <i aria-hidden="true">→</i> Visakhapatnam, Andhra Pradesh</strong><small>This demonstrates a route only; it does not represent a consignment, event, timestamp, ETA, or hub location.</small></div>
      <ol className="customer-journey-list">{[["Booked", "BOOKED"], ["Picked up", "PICKED_UP"], ["Origin hub receipt", "RECEIVED_AT_ORIGIN_HUB"], ["Hub dispatch", "DISPATCHED"], ["Destination arrival", "ARRIVED_AT_DESTINATION_HUB"], ["Destination receipt", "RECEIVED_AT_DESTINATION_HUB"], ["Out for delivery", "OUT_FOR_DELIVERY"], ["Delivered", "DELIVERED"]].map(([label, event], index) => <li key={event}><span>{String(index + 1).padStart(2, "0")}</span><strong>{label}</strong><small>{event}</small></li>)}</ol>
      <p className="customer-journey-note">A booking remains Pending Approval until Operations reviews it. Vehicle arrival and physical package receipt are separate milestones.</p>
    </div>}</StorySection>}

    {showNetwork && <StorySection label="Network evidence" className="customer-trust-story">{() => <div className="customer-story-inner customer-trust-story-inner">
      <div className="customer-section-number">06</div><div><span className="customer-kicker">WHAT THE NUMBERS MEAN</span><h2>Trust the record, <em>not the assumption.</em></h2><p>Coverage comes from recorded shipment address states. Hub reach comes from recorded origin and destination hub IDs. Delivery counts require a persisted Delivered event. Historical outcomes are not relabeled as current live status.</p></div>
      <div className="customer-trust-signals"><span><i />Company-scoped totals</span><span><i />Persisted logistics events</span><span><i />Recorded state relationships</span></div>
    </div>}</StorySection>}
  </div>;
}
