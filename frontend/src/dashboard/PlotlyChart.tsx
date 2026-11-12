import createPlotlyComponent from "react-plotly.js/factory";
import type { Data, Layout, PlotMouseEvent } from "plotly.js";
import Plotly from "plotly.js-basic-dist-min";

const Plot = createPlotlyComponent(Plotly);

const plotConfig = {
  responsive: true,
  displaylogo: false,
  displayModeBar: "hover" as const,
  scrollZoom: true,
  modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
};

export default function PlotlyChart({
  data,
  layout,
  onClick,
}: {
  data: Data[];
  layout: Partial<Layout>;
  onClick?: (event: PlotMouseEvent) => void;
}) {
  return (
    <Plot
      config={plotConfig}
      data={data}
      layout={layout}
      onClick={onClick}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}
