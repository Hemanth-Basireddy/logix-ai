import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { Data, Layout } from "plotly.js";
import Plotly from "plotly.js-basic-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";
type Route = { origin: string; destination: string; shipments: number; delivered: number; active: number };

let sankeyTracePromise: Promise<unknown> | null = null;
function ensureSankeyRegistered() {
  sankeyTracePromise ??= import("plotly.js/lib/sankey").then(({ default: Sankey }) => {
    const extensible = Plotly as typeof Plotly & { register: (traces: unknown[]) => void };
    extensible.register([Sankey]);
  });
  return sankeyTracePromise;
}

export default memo(function CustomerRouteSankey({ routes }: { routes: Route[] }) {
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const plotRef = useRef<any>(null);
  const [Plot, setPlot] = useState<ComponentType<any> | null>(null);

  useEffect(() => {
    let alive = true;
    void ensureSankeyRegistered().then(() => {
      if (!alive) return;
      const extensible = Plotly as typeof Plotly & { register: (traces: unknown[]) => void };
      setPlot(() => createPlotlyComponent(extensible));
      setReady(true);
    }).catch((error) => {
      console.error("[Customer Sankey registration failed]", error);
      if (alive) setFailed(true);
    });
    return () => { alive = false; };
  }, []);

  const nodes = useMemo(() => [...new Set(routes.flatMap((route) => [route.origin, route.destination]))], [routes]);
  const data = useMemo<Data[]>(() => {
    const nodeIndex = new Map(nodes.map((node, index) => [node, index]));
    return [{
    type: "sankey", arrangement: "snap",
    node: { pad: 22, thickness: 17, line: { color: "#294b70", width: 1 }, label: nodes, color: "#4ccfff", hovertemplate: "%{label}<extra></extra>" },
    link: {
      source: routes.map((route) => nodeIndex.get(route.origin)!), target: routes.map((route) => nodeIndex.get(route.destination)!), value: routes.map((route) => route.shipments),
      color: "rgba(76,207,255,.30)", customdata: routes.map((route) => [route.origin, route.destination, route.shipments, route.delivered, route.active]),
      hovertemplate: "%{customdata[0]} → %{customdata[1]}<br><b>%{customdata[2]:,}</b> shipments<br>%{customdata[3]:,} delivered<extra></extra>",
    },
    } as Data];
  }, [nodes, routes]);
  const layout = useMemo<Partial<Layout>>(() => ({ autosize: true, height: Math.max(360, Math.min(620, routes.length * 45 + 180)), margin: { l: 12, r: 12, t: 18, b: 10 }, font: { family: "Inter, Manrope, system-ui, sans-serif", size: 11, color: "#c7d7eb" }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)" }), [routes.length]);
  if (failed) return <div className="customer-chart-placeholder" role="status">The route-flow visual could not load. Shipment history is still available.</div>;
  if (!ready || !Plot) return <div className="customer-chart-placeholder">Preparing route-flow visual…</div>;
  return <Plot ref={plotRef} data={data} layout={layout} config={{ responsive: true, displayModeBar: false, displaylogo: false }} onError={(error: unknown) => { console.error("[Customer route chart failed]", error); setFailed(true); }} useResizeHandler style={{ width: "100%", height: "100%" }} />;
});
