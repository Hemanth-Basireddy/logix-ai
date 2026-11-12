import { lazy, Suspense, type ReactNode } from "react";
import type { Data, Layout, PlotMouseEvent } from "plotly.js";
import type { CompanyAdminDashboard } from "../types";

const PlotlyChart = lazy(() => import("./PlotlyChart"));
const palette = ["#79c88a", "#dfbf7a", "#54b8a0", "#a4bd91", "#e07868", "#c9a967"];
const chartFont = { family: "DM Sans, Segoe UI, sans-serif", color: "#c0ccdc", size: 10 };
const chartLayout: Partial<Layout> = {
  autosize: true,
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: chartFont,
  transition: { duration: 280, easing: "cubic-in-out" },
  margin: { l: 42, r: 36, t: 12, b: 42 },
  hoverlabel: { bgcolor: "#111b29", bordercolor: "#c5a66a", font: { color: "#f6f2e9", size: 11 } },
  xaxis: {
    gridcolor: "rgba(164,185,212,0.11)",
    linecolor: "rgba(164,185,212,0.2)",
    tickfont: { size: 9, color: "#aebdd0" },
    zerolinecolor: "rgba(152,174,199,0.12)",
  },
  yaxis: {
    gridcolor: "rgba(164,185,212,0.11)",
    linecolor: "rgba(164,185,212,0.16)",
    tickfont: { size: 9, color: "#aebdd0" },
    zerolinecolor: "rgba(152,174,199,0.12)",
  },
  legend: {
    orientation: "h",
    x: 0,
    y: 1.14,
    font: { size: 9, color: "#b9c6d6" },
    bgcolor: "rgba(0,0,0,0)",
  },
};

function DashboardPlot({
  data,
  layout,
  ariaLabel,
  onClick,
}: {
  data: Data[];
  layout: Partial<Layout>;
  ariaLabel: string;
  onClick?: (event: PlotMouseEvent) => void;
}) {
  return (
    <div aria-label={ariaLabel} className="plotly-chart" role="img">
      <Suspense fallback={<div className="plotly-loading" aria-label="Loading interactive chart" />}>
        <PlotlyChart
          data={data}
          layout={{ ...chartLayout, ...layout }}
          onClick={onClick}
        />
      </Suspense>
    </div>
  );
}

export function ChartPanel({
  id,
  title,
  eyebrow = "COMPANY ANALYTICS",
  className = "",
  children,
}: {
  id: string;
  title: string;
  eyebrow?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`chart-panel ${className}`} id={id}>
      <header className="chart-panel-header">
        <div>
          <span className="chart-eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        <span className="chart-panel-accent" />
      </header>
      {children}
    </section>
  );
}

export function MonthlyPerformance({
  rows,
}: {
  rows: CompanyAdminDashboard["charts"]["timeline"];
}) {
  if (rows.length === 0) return <EmptyState>No shipment records in this date range.</EmptyState>;
  const data: Data[] = [
    {
      type: "bar",
      name: "Shipments",
      x: rows.map((row) => row.periodStart),
      y: rows.map((row) => row.shipments),
      marker: {
        color: rows.map((row) => row.active > 0 ? "#79c88a" : "#47724f"),
        line: { color: "#a4d69a", width: 1 },
      },
      customdata: rows.map((row) => [row.delivered, row.delayed, row.active]),
      hovertemplate:
        "%{x|%d %b %Y}<br>Total: %{y:,}<br>Delivered: %{customdata[0]:,}<br>Historical SLA delays: %{customdata[1]:,}<br>Active: %{customdata[2]:,}<extra></extra>",
    },
    {
      type: "scatter",
      mode: "lines+markers",
      name: "On-time delivery",
      x: rows.map((row) => row.periodStart),
      y: rows.map((row) => row.onTimeDeliveryPercent),
      yaxis: "y2",
      connectgaps: false,
      line: { color: "#79c88a", width: 2.5, shape: "spline" },
      marker: { size: 6, color: "#79c88a", line: { color: "#11241f", width: 1 } },
      hovertemplate: "%{x|%d %b %Y}<br>On-time: %{y:.1f}%<extra></extra>",
    },
  ];
  return (
    <DashboardPlot
      ariaLabel="Shipment volume and on-time rate over time"
      data={data}
      layout={{
        barmode: "overlay",
        bargap: 0.28,
        xaxis: { ...chartLayout.xaxis, type: "date", tickformat: "%d %b" },
        yaxis: { ...chartLayout.yaxis, title: { text: "Shipment count", font: { size: 8 } } },
        yaxis2: {
          title: { text: "On-time %", font: { size: 8 } },
          overlaying: "y",
          side: "right",
          range: [0, 100],
          ticksuffix: "%",
          showgrid: false,
          tickfont: { size: 8, color: "#16c79a" },
        },
      }}
    />
  );
}

export function StatusDistribution({
  rows,
  onSelect,
}: {
  rows: CompanyAdminDashboard["charts"]["statuses"];
  onSelect?: (status: string) => void;
}) {
  if (rows.length === 0) return <EmptyState>No shipment status data available.</EmptyState>;
  return (
    <DashboardPlot
      data={[{
        type: "pie",
        labels: rows.map((row) => row.status),
        values: rows.map((row) => row.shipments),
        hole: 0.62,
        sort: false,
        marker: { colors: rows.map((row) => {
          const status = row.status.toLowerCase();
          return status === "delayed" ? "#e07868" : row.operationalStage === "active" ? "#dfbf7a" : "#79c88a";
        }), line: { color: "#111a28", width: 2 } },
        textinfo: "percent",
        textposition: "inside",
        insidetextfont: { color: "#fff", size: 9 },
        customdata: rows.map((row) => [row.status, row.operationalStage]),
        hovertemplate: "%{label}<br>%{value:,} shipments (%{percent})<br>Class: %{customdata[1]}<extra></extra>",
      }]}
      layout={{
        margin: { l: 7, r: 7, t: 14, b: 7 },
        showlegend: true,
        legend: { ...chartLayout.legend, orientation: "v", x: 1, y: 0.9, xanchor: "left" },
        annotations: [{
          text: rows.reduce((sum, row) => sum + row.shipments, 0).toLocaleString(),
          x: 0.38, y: 0.5, showarrow: false, font: { size: 15, color: "#edf3fb" },
        }],
      }}
      ariaLabel="Shipment distribution by recorded status"
      onClick={(event) => {
        const clickedData = event.points[0]?.customdata;
        const status = Array.isArray(clickedData) ? clickedData[0] : event.points[0]?.text;
        if (typeof status === "string") onSelect?.(status);
      }}
    />
  );
}

export function ModeDistribution({
  rows,
}: {
  rows: CompanyAdminDashboard["charts"]["modes"];
}) {
  if (rows.length === 0) return <EmptyState>No shipment records in this date range.</EmptyState>;
  return (
    <DashboardPlot
      ariaLabel="Shipment distribution by mode"
      data={[{
        type: "pie",
        labels: rows.map((row) => row.mode),
        values: rows.map((row) => row.shipments),
        hole: 0.65,
        marker: { colors: palette, line: { color: "#111a28", width: 2 } },
        textinfo: "percent",
        textposition: "inside",
        insidetextfont: { color: "#fff", size: 9 },
        hovertemplate: "%{label}<br>%{value:,} shipments (%{percent})<extra></extra>",
      }]}
      layout={{
        margin: { l: 8, r: 8, t: 8, b: 8 },
        showlegend: true,
        legend: { ...chartLayout.legend, orientation: "v", x: 1, y: 0.9, xanchor: "left" },
        annotations: [{
          text: rows.reduce((sum, row) => sum + row.shipments, 0).toLocaleString(),
          x: 0.38, y: 0.5, showarrow: false, font: { size: 15, color: "#edf3fb" },
        }],
      }}
    />
  );
}

export function ModeStatus({ rows }: { rows: CompanyAdminDashboard["charts"]["modes"] }) {
  if (rows.length === 0) return <EmptyState>No delivery status data available.</EmptyState>;
  const other = rows.map((row) =>
    Math.max(0, row.eligibleDelivered - row.onTimeDelivered - row.delayed),
  );
  return (
    <DashboardPlot
      ariaLabel="Historical delivery outcomes by shipment mode"
      data={[
        {
          type: "bar",
          orientation: "h",
          name: "On time",
          y: rows.map((row) => row.mode),
          x: rows.map((row) => row.onTimeDelivered),
          marker: { color: "#29c78f" },
          customdata: rows.map((row) => row.eligibleDelivered),
          hovertemplate: "%{y}<br>On time: %{x:,}<br>Eligible deliveries: %{customdata:,}<extra></extra>",
        },
        {
          type: "bar",
          orientation: "h",
          name: "Delayed by recorded SLA",
          y: rows.map((row) => row.mode),
          x: rows.map((row) => Math.min(row.delayed, row.eligibleDelivered - row.onTimeDelivered)),
          marker: { color: "#f05262" },
          hovertemplate: "%{y}<br>Historical SLA delays: %{x:,}<extra></extra>",
        },
        {
          type: "bar",
          orientation: "h",
          name: "Other terminal records",
          y: rows.map((row) => row.mode),
          x: other,
          marker: { color: "#526174" },
          hovertemplate: "%{y}<br>Other terminal records: %{x:,}<extra></extra>",
        },
      ]}
      layout={{
        barmode: "stack",
        barnorm: "percent",
        margin: { l: 66, r: 12, t: 28, b: 32 },
        xaxis: { ...chartLayout.xaxis, title: { text: "Eligible delivered shipments (%)", font: { size: 8 } }, ticksuffix: "%" },
        yaxis: { ...chartLayout.yaxis, autorange: "reversed", gridcolor: "rgba(0,0,0,0)" },
        legend: { ...chartLayout.legend, y: 1.16 },
      }}
    />
  );
}

export function RevenueChart({
  rows,
}: {
  rows: CompanyAdminDashboard["charts"]["timeline"];
}) {
  if (rows.length === 0) return <EmptyState>No revenue source data in this range.</EmptyState>;
  return (
    <DashboardPlot
      ariaLabel="Estimated shipment charges over time"
      data={[{
        type: "bar",
        name: "Estimated charges",
        x: rows.map((row) => row.periodStart),
        y: rows.map((row) => row.estimatedRevenue),
        marker: { color: "rgba(121,200,138,0.78)", line: { color: "#a4d69a", width: 1 } },
        hovertemplate: "%{x|%d %b %Y}<br>Estimated charge units: %{y:,.2f}<extra></extra>",
      }, {
        type: "scatter",
        mode: "lines+markers",
        name: "Charge trend",
        x: rows.map((row) => row.periodStart),
        y: rows.map((row) => row.estimatedRevenue),
        line: { color: "#e4c27a", width: 2.5, shape: "spline" },
        marker: { color: "#f1d89c", size: 5, line: { color: "#342b1b", width: 1 } },
        hovertemplate: "%{x|%d %b %Y}<br>Recorded charge trend: %{y:,.2f}<extra></extra>",
      }]}
      layout={{
        margin: { l: 56, r: 12, t: 12, b: 42 },
        xaxis: { ...chartLayout.xaxis, type: "date", tickformat: "%d %b" },
        yaxis: { ...chartLayout.yaxis, title: { text: "Source amount units", font: { size: 8 } } },
      }}
    />
  );
}

export function HubScatter({
  rows,
  onSelect,
}: {
  rows: CompanyAdminDashboard["charts"]["hubs"];
  onSelect?: (hubId: string) => void;
}) {
  const eligible = rows.filter((row) => row.delayRatePercent !== null);
  if (eligible.length === 0) return <EmptyState>No eligible delivery data for hub comparison.</EmptyState>;
  return (
    <DashboardPlot
      ariaLabel="Hub shipment volume against historical delay rate"
      data={[{
        type: "scatter",
        mode: "markers+text",
        x: eligible.map((row) => row.shipments),
        y: eligible.map((row) => row.delayRatePercent),
        text: eligible.map((row) => row.city),
        textposition: "top center",
        textfont: { size: 8, color: "#a6b4c5" },
        customdata: eligible.map((row) => row.id),
        marker: {
          size: eligible.map((row) => Math.max(9, Math.min(24, 8 + Math.sqrt(row.shipments) / 3))),
          color: eligible.map((row) =>
            row.delayRatePercent! >= 20 ? "#f05262" : row.delayRatePercent! >= 10 ? "#ffad42" : "#28c9b5",
          ),
          opacity: 0.84,
          line: { color: "#182332", width: 1 },
        },
        hovertemplate: "%{text}<br>Shipment legs: %{x:,}<br>Historical SLA delay: %{y:.1f}%<extra>Click to inspect hub shipments</extra>",
      }]}
      layout={{
        margin: { l: 53, r: 12, t: 18, b: 44 },
        xaxis: { ...chartLayout.xaxis, title: { text: "Shipment legs", font: { size: 8 } } },
        yaxis: { ...chartLayout.yaxis, title: { text: "Historical delay rate", font: { size: 8 } }, ticksuffix: "%" },
        showlegend: false,
      }}
      onClick={(event) => {
        const hubId = event.points[0]?.customdata;
        if (typeof hubId === "string") onSelect?.(hubId);
      }}
    />
  );
}

export function SplitDonut({
  first,
  second,
  firstLabel,
  secondLabel,
}: {
  first: number;
  second: number;
  firstLabel: string;
  secondLabel: string;
}) {
  const total = first + second;
  if (!total) return <EmptyState>No customer records in this date range.</EmptyState>;
  return (
    <DashboardPlot
      ariaLabel="Repeat and one-time customer distribution"
      data={[{
        type: "pie",
        labels: [firstLabel, secondLabel],
        values: [first, second],
        hole: 0.65,
        marker: { colors: ["#79c88a", "#dfbf7a"], line: { color: "#111a28", width: 2 } },
        textinfo: "percent",
        hovertemplate: "%{label}: %{value:,} customers (%{percent})<extra></extra>",
      }]}
      layout={{
        margin: { l: 5, r: 5, t: 5, b: 5 },
        showlegend: true,
        legend: { ...chartLayout.legend, orientation: "v", x: 1, y: 0.8, xanchor: "left" },
        annotations: [{ text: total.toLocaleString(), x: 0.4, y: 0.5, showarrow: false, font: { size: 14, color: "#edf3fb" } }],
      }}
    />
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="chart-empty">
      <span className="empty-mark" aria-hidden="true">—</span>
      <p>{children}</p>
    </div>
  );
}

export function RoleBars({ rows }: { rows: CompanyAdminDashboard["charts"]["employees"]["roles"] }) {
  const max = Math.max(...rows.map((row) => row.employees), 1);
  if (!rows.length) return <EmptyState>No employee records available.</EmptyState>;
  return (
    <div className="role-bars">
      {rows.map((row, index) => (
        <div className="role-bar-row" key={row.role}>
          <span>{row.role.replaceAll("_", " ")}</span>
          <div className="role-track">
            <i style={{ width: `${(row.employees / max) * 100}%`, backgroundColor: palette[index % palette.length] }} />
          </div>
          <strong>{row.employees}</strong>
        </div>
      ))}
    </div>
  );
}
