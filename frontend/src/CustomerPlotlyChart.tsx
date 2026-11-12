import createPlotlyComponent from "react-plotly.js/factory";
import type { Data, Layout } from "plotly.js";
import Plotly from "plotly.js-basic-dist-min";

const Plot = createPlotlyComponent(Plotly);

export default function CustomerPlotlyChart({ data, layout, onError }: {
  data: Data[];
  layout: Partial<Layout>;
  onError: (error: Error) => void;
}) {
  return <Plot
    data={data}
    layout={layout}
    config={{ responsive: true, displaylogo: false, displayModeBar: "hover", scrollZoom: false, modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"] }}
    onError={onError}
    useResizeHandler
    style={{ width: "100%", height: "100%" }}
  />;
}
