import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CompanyBrand } from "./branding";
import { authenticatedFetch, useAuth } from "./auth";
import {
  ChartPanel,
  EmptyState,
  HubScatter,
  ModeDistribution,
  ModeStatus,
  MonthlyPerformance,
  RevenueChart,
  RoleBars,
  StatusDistribution,
  SplitDonut,
} from "./dashboard/Charts";
import { CompanyRecordsPage, type RecordPageKind } from "./dashboard/CompanyRecordsPage";
import type {
  CompanyAdminDashboard as DashboardData,
  CompanySearchResult,
  Employee,
  ShipmentInvestigationRow,
} from "./types";

type DateSelection = {
  preset: string;
  start: string;
  end: string;
};
type PricingRoute = { originHubId: string; originCity: string; destinationHubId: string; destinationCity: string; mode: string };
type PricingRule = { originHubId: string; destinationHubId: string; mode: string; baseCharge: string; includedWeightKg: string; perKgCharge: string; serviceCharge: string; minimumCharge: string; taxRatePercent: string; volumetricDivisor: string; active: boolean };
type PricingSettings = { senderPaysEnabled: boolean; receiverPaysEnabled: boolean; demoUpiEnabled: boolean; payAtPickupEnabled: boolean; payAtDeliveryEnabled: boolean; codEnabled: boolean };

const navigation = [
  { label: "Dashboard", icon: "grid", target: "dashboard" },
  { label: "Shipments", icon: "box", target: "shipments" },
  { label: "Exceptions & SLA Alerts", icon: "alert", target: "exceptions" },
  { label: "Customers", icon: "users", target: "customers" },
  { label: "Hubs", icon: "pin", target: "hubs" },
  { label: "Employees", icon: "person", target: "employees" },
  { label: "Routes", icon: "route", target: "routes" },
  { label: "Shipping Pricing", icon: "settings", target: "shipping-pricing" },
  { label: "Reports & Analytics", icon: "chart", target: "reports-analytics" },
];

const recordPageKinds = new Set<RecordPageKind>([
  "shipments",
  "customers",
  "employees",
  "hubs",
  "routes",
  "exceptions",
]);

function isRecordPageKind(value: string): value is RecordPageKind {
  return recordPageKinds.has(value as RecordPageKind);
}

function companyAdminPath(target: string): string {
  return target === "dashboard" ? "/company-admin" : `/company-admin/${target}`;
}

function Icon({ name }: { name: string }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.7,
  };
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    box: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9" /></>,
    alert: <><path d="M12 3 3 20h18L12 3Z" /><path d="M12 9v4m0 3h.01" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-1a6 6 0 0 1 12 0v1H3Zm13-9a3 3 0 1 0 0-6m1 9a5 5 0 0 1 4 5" /></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    person: <><circle cx="12" cy="8" r="3.5" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    route: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M8 6h5a5 5 0 0 1 5 5v5M6 8v8a2 2 0 0 0 2 2h8" /></>,
    chart: <><path d="M4 19V5m0 14h17" /><path d="m7 15 4-4 3 2 6-7" /></>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12h4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 1 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 1 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 1 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 1 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  };
  return <svg aria-hidden="true" className="ui-icon" viewBox="0 0 24 24" {...common}>{paths[name] ?? paths.grid}</svg>;
}

function asLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getPreset(preset: string): DateSelection {
  if (preset === "custom") return { preset, start: "", end: "" };
  const today = new Date();
  const end = asLocalDate(today);
  const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (preset === "30") startDate.setDate(startDate.getDate() - 29);
  else if (preset === "90") startDate.setDate(startDate.getDate() - 89);
  else if (preset === "ytd") startDate.setMonth(0, 1);
  return {
    preset,
    start: preset === "all" ? "" : asLocalDate(startDate),
    end: preset === "all" ? "" : end,
  };
}

function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-IN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <span className="sparkline-empty" aria-hidden="true" />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = 2 + (index / (values.length - 1)) * 92;
      const y = 29 - ((value - min) / range) * 23;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg aria-hidden="true" className="kpi-sparkline" viewBox="0 0 96 32">
      <polyline points={points} style={{ stroke: color }} />
    </svg>
  );
}

function compareValue(
  current: number | null,
  previous: number | null,
  kind: "count" | "rate" | "revenue",
  inverse = false,
): { label: string; direction: "up" | "down" | "flat" } | null {
  if (current === null || previous === null) return null;
  if (kind === "rate") {
    const difference = current - previous;
    return {
      label: `${difference > 0 ? "+" : ""}${difference.toFixed(1)} pts vs prior period`,
      direction:
        difference === 0 ? "flat" : (difference > 0) !== inverse ? "up" : "down",
    };
  }
  if (previous === 0) return { label: "No prior-period baseline", direction: "flat" };
  const difference = ((current - previous) / previous) * 100;
  return {
    label: `${difference > 0 ? "+" : ""}${difference.toFixed(1)}% vs prior period`,
    direction: difference > 0 ? "up" : difference < 0 ? "down" : "flat",
  };
}

function KpiCard({
  title,
  value,
  detail,
  accent,
  glyph,
  comparison,
  sparkline,
}: {
  title: string;
  value: string;
  detail: string;
  accent: string;
  glyph: string;
  comparison: ReturnType<typeof compareValue>;
  sparkline: number[];
}) {
  return (
    <article className="kpi-card" style={{ "--kpi-accent": accent } as CSSProperties}>
      <div className="kpi-card-top">
        <span className="kpi-glyph" aria-hidden="true">{glyph}</span>
        <span className="kpi-card-title">{title}</span>
        <Sparkline color={accent} values={sparkline} />
      </div>
      <strong className="kpi-value">{value}</strong>
      <div className="kpi-card-foot">
        <span className="kpi-detail">{detail}</span>
        {comparison && (
          <span className={`kpi-comparison comparison-${comparison.direction}`}>
            {comparison.label}
          </span>
        )}
      </div>
    </article>
  );
}

function DataTable({
  headers,
  rows,
  empty,
  onRowAction,
}: {
  headers: string[];
  rows: Array<Array<ReactNode>>;
  empty: string;
  onRowAction?: (rowIndex: number) => void;
}) {
  if (!rows.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="table-scroll">
      <table className="dashboard-table">
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr className={onRowAction ? "dashboard-table-row-action" : undefined} key={`${String(row[0])}-${index}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cellIndex}-${typeof cell === "string" || typeof cell === "number" ? String(cell) : "content"}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sidebar({
  employee,
  exceptionCount,
  mobileOpen,
  onNavigate,
  currentPage,
}: {
  employee: Employee;
  exceptionCount: number;
  mobileOpen: boolean;
  onNavigate: () => void;
  currentPage: string;
}) {
  return (
    <aside className={`control-sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
      <div className="sidebar-brand-wrap">
        <CompanyBrand employee={employee} />
        <small>COMPANY CONTROL TOWER</small>
      </div>
      <span className="sidebar-section-label">WORKSPACE</span>
      <nav aria-label="Company workspace navigation" className="sidebar-nav">
        {navigation.map((item) => (
          <Link
            aria-current={currentPage === item.target ? "page" : undefined}
            className={`sidebar-link ${currentPage === item.target ? "sidebar-link-active" : ""}`}
            to={companyAdminPath(item.target)}
            key={item.target}
            onClick={onNavigate}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {item.target === "exceptions" && exceptionCount > 0 && (
              <b className="nav-count">{exceptionCount}</b>
            )}
          </Link>
        ))}
      </nav>
      <span className="sidebar-section-label sidebar-section-secondary">INSIGHTS</span>
      <nav aria-label="Insights navigation" className="sidebar-nav">
        <Link aria-current={currentPage === "powerbi" ? "page" : undefined} className={`sidebar-link sidebar-sub-link ${currentPage === "powerbi" ? "sidebar-link-active" : ""}`} to={companyAdminPath("powerbi")} onClick={onNavigate}>
          <span className="powerbi-mark" aria-hidden="true">▥</span>
          <span>Power BI Reports</span>
        </Link>
        <Link aria-current={currentPage === "advanced-analytics" ? "page" : undefined} className={`sidebar-link sidebar-sub-link ${currentPage === "advanced-analytics" ? "sidebar-link-active" : ""}`} to={companyAdminPath("advanced-analytics")} onClick={onNavigate}>
          <Icon name="chart" />
          <span>Advanced Analytics</span>
        </Link>
        <Link aria-current={currentPage === "notifications" ? "page" : undefined} className={`sidebar-link ${currentPage === "notifications" ? "sidebar-link-active" : ""}`} to={companyAdminPath("notifications")} onClick={onNavigate}>
          <Icon name="bell" />
          <span>Notifications</span>
          {exceptionCount > 0 && <b className="nav-count">{exceptionCount}</b>}
        </Link>
        <Link aria-current={currentPage === "settings" ? "page" : undefined} className={`sidebar-link ${currentPage === "settings" ? "sidebar-link-active" : ""}`} to={companyAdminPath("settings")} onClick={onNavigate}>
          <Icon name="settings" />
          <span>Settings</span>
        </Link>
      </nav>
      <div className="sidebar-foot">
        <span className="sidebar-foot-mark">▥</span>
        <strong>DEEPER INSIGHTS</strong>
        <p>Connect Power BI securely to enable interactive reports.</p>
        <Link to={companyAdminPath("powerbi")}>View setup details <span aria-hidden="true">→</span></Link>
      </div>
    </aside>
  );
}

function DashboardHeader({
  employee,
  selection,
  setSelection,
  onSignOut,
  exceptionCount,
  onSearchSelect,
}: {
  employee: Employee;
  selection: DateSelection;
  setSelection: (selection: DateSelection) => void;
  onSignOut: () => Promise<void>;
  exceptionCount: number;
  onSearchSelect: (result: CompanySearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CompanySearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      authenticatedFetch(`/api/company-admin/search?q=${encodeURIComponent(term)}`, {
        credentials: "same-origin",
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json()) as {
            results?: CompanySearchResult[];
            error?: string;
          };
          if (!response.ok) throw new Error(payload.error ?? "Search could not be completed.");
          return payload.results ?? [];
        })
        .then((items) => {
          setResults(items);
          setSearchError(null);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setSearchError(error instanceof Error ? error.message : "Search could not be completed.");
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function handleSignOut() {
    try {
      setSignOutError(null);
      await onSignOut();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Unable to sign out.");
    }
  }

  return (
    <header className="control-header">
      <div className="header-title">
        <span className="header-overline">COMPANY WORKSPACE</span>
        <h1>{employee.company.name} Company Admin Dashboard</h1>
        <p>Business overview &amp; operational performance</p>
      </div>
      <div className="header-tools">
        <label className="range-select-wrap">
          <span className="sr-only">Dashboard date range</span>
          <select
            onChange={(event) => setSelection(getPreset(event.target.value))}
            value={selection.preset}
          >
            <option value="all">All available history</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="ytd">Year to date</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {selection.preset === "custom" && (
          <div className="custom-date-fields">
            <label><span className="sr-only">Start date</span><input type="date" value={selection.start} onChange={(event) => setSelection({ ...selection, start: event.target.value })} /></label>
            <span>—</span>
            <label><span className="sr-only">End date</span><input type="date" value={selection.end} onChange={(event) => setSelection({ ...selection, end: event.target.value })} /></label>
          </div>
        )}
        <div className="global-search">
          <Icon name="search" />
          <input
            aria-label="Search shipments, customers, or routes"
            onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search shipments, customers, routes…"
            value={query}
          />
          {searchOpen && query.trim().length >= 2 && (
            <div className="search-popover">
              {searchError ? <p className="search-empty">{searchError}</p> : results.length ? (
                results.map((result) => (
                  <button
                    className="search-result"
                    key={`${result.result_type}-${result.result_id}`}
                    onClick={() => {
                      onSearchSelect(result);
                      setQuery("");
                      setSearchOpen(false);
                    }}
                    type="button"
                  >
                    <span className={`search-result-type search-${result.result_type}`}>{result.result_type.slice(0, 1).toUpperCase()}</span>
                    <span><strong>{result.label}</strong><small>{result.result_type} · {result.detail}</small></span>
                  </button>
                ))
              ) : <p className="search-empty">No matching company records.</p>}
            </div>
          )}
        </div>
        <div className="header-popover-wrap">
          <button
            aria-expanded={notificationsOpen}
            aria-label={`Notifications, ${exceptionCount} exception events`}
            className="header-icon-button"
            onClick={() => {
              setNotificationsOpen((open) => !open);
              setProfileOpen(false);
            }}
            type="button"
          >
            <Icon name="bell" />
            {exceptionCount > 0 && <i className="header-badge">{exceptionCount}</i>}
          </button>
          {notificationsOpen && (
            <div className="header-popover notification-popover">
              <strong>Company notifications</strong>
              {exceptionCount ? (
                <p>{exceptionCount} exception-related event records in the selected period.</p>
              ) : (
                <p>No exception-related event records were found for this company and date range.</p>
              )}
              <a href="#exceptions" onClick={() => setNotificationsOpen(false)}>Review exception data</a>
            </div>
          )}
        </div>
        <span className="header-divider" />
        <div className="header-popover-wrap">
          <button
            aria-expanded={profileOpen}
            className="profile-menu-button"
            onClick={() => {
              setProfileOpen((open) => !open);
              setNotificationsOpen(false);
            }}
            type="button"
          >
            <span className="profile-avatar">{employee.name.slice(0, 1).toUpperCase()}</span>
            <span className="profile-copy"><strong>{employee.name}</strong><small>Company Admin</small></span>
            <span className="profile-chevron">⌄</span>
          </button>
          {profileOpen && (
            <div className="header-popover profile-popover">
              <strong>{employee.name}</strong>
              <span>{employee.employeeId}</span>
              <span>{employee.company.name} · Company Admin</span>
              {signOutError && <p className="popover-error" role="alert">{signOutError}</p>}
              <button onClick={handleSignOut} type="button">Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function KpiCards({ data }: { data: DashboardData }) {
  const current = data.kpis;
  const previous = data.comparison;
  const timeline = data.charts.timeline;
  const metrics = [
    {
      title: "Total Shipments",
      value: formatNumber(current.totalShipments),
      detail: "Distinct company shipments",
      accent: "#3b8cff",
      glyph: "⬡",
      comparison: compareValue(current.totalShipments, previous?.totalShipments ?? null, "count"),
      sparkline: timeline.map((row) => row.shipments),
    },
    {
      title: "Active Shipments",
      value: formatNumber(current.activeShipments),
      detail: "Non-terminal status records",
      accent: "#24c9e8",
      glyph: "↗",
      comparison: null,
      sparkline: timeline.map((row) => row.active),
    },
    {
      title: "Delivered Shipments",
      value: formatNumber(current.deliveredShipments),
      detail: "Terminal-status records",
      accent: "#29c78f",
      glyph: "✓",
      comparison: null,
      sparkline: timeline.map((row) => row.delivered),
    },
    {
      title: "Delayed Shipments",
      value: formatNumber(current.delayedShipments),
      detail: `Actual transit exceeded recorded SLA`,
      accent: "#f05262",
      glyph: "◷",
      comparison: compareValue(current.delayedShipments, previous?.delayedShipments ?? null, "count", true),
      sparkline: timeline.map((row) => row.delayed),
    },
    {
      title: "Total Customers",
      value: formatNumber(current.totalCustomers),
      detail: "All company customer records",
      accent: "#39b9d8",
      glyph: "◎",
      comparison: null,
      sparkline: [],
    },
    {
      title: "On-Time Delivery",
      value: current.onTimeDeliveryPercent === null ? "—" : `${current.onTimeDeliveryPercent.toFixed(1)}%`,
      detail: `${formatNumber(current.onTimeDelivered)} / ${formatNumber(current.eligibleDelivered)} eligible delivered`,
      accent: "#20c6a1",
      glyph: "✓",
      comparison: compareValue(current.onTimeDeliveryPercent, previous?.onTimeDeliveryPercent ?? null, "rate"),
      sparkline: timeline.flatMap((row) =>
        row.onTimeDeliveryPercent === null ? [] : [row.onTimeDeliveryPercent],
      ),
    },
    {
      title: "At-Risk Shipments",
      value: formatNumber(current.atRiskShipments),
      detail: "Non-terminal and past recorded due date",
      accent: "#ffad42",
      glyph: "△",
      comparison: null,
      sparkline: [],
    },
    {
      title: "Revenue (Estimated)",
      value: formatNumber(current.estimatedRevenue, 0),
      detail: "Source amount units · collection not verified",
      accent: "#a879ff",
      glyph: "∑",
      comparison: compareValue(current.estimatedRevenue, previous?.estimatedRevenue ?? null, "revenue"),
      sparkline: timeline.map((row) => row.estimatedRevenue),
    },
  ];

  return (
    <section aria-label="Company key performance indicators" className="dashboard-kpis">
      {metrics.map((metric) => (
        <KpiCard {...metric} key={metric.title} />
      ))}
    </section>
  );
}

function comparisonText(data: DashboardData): string {
  if (!data.comparison) return "No previous-period comparison for all-history view.";
  return `Compared with ${formatDate(data.comparison.previousPeriod.startDate)} – ${formatDate(data.comparison.previousPeriod.endDate)}`;
}

function ShipmentInvestigation({
  rows,
  loading,
  error,
  filter,
  onClose,
}: {
  rows: ShipmentInvestigationRow[];
  loading: boolean;
  error: string | null;
  filter: { status?: string; routeId?: string; hubId?: string; consignmentNo?: string };
  onClose: () => void;
}) {
  const label = filter.status
    ? `Status: ${filter.status}`
    : filter.routeId
      ? `Route: ${filter.routeId}`
      : filter.hubId
        ? `Hub: ${filter.hubId}`
        : filter.consignmentNo
          ? `Tracking ID: ${filter.consignmentNo}`
          : "Selected date range";
  return (
    <ChartPanel className="shipment-investigation-panel" id="shipment-investigation" title="Shipment Investigation">
      <div className="investigation-heading">
        <span>Company-scoped recorded shipment data · {label}</span>
        <button className="table-action-button" onClick={onClose} type="button">Close</button>
      </div>
      {loading && <p className="investigation-message" aria-live="polite">Loading shipment records…</p>}
      {error && <p className="investigation-error" role="alert">{error}</p>}
      {!loading && !error && (
        <>
          <DataTable
            headers={["Tracking ID", "Customer", "Route", "Mode / weight", "Booking date", "Expected delivery", "Recorded status", "SLA assessment", "Last event / location"]}
            rows={rows.map((row) => [
              row.consignmentNo,
              row.customerName,
              `${row.originCity} → ${row.destinationCity}`,
              `${row.mode} · ${row.chargeableWeight === null ? "weight n/a" : `${formatNumber(row.chargeableWeight, 2)} kg`}`,
              formatDate(row.shipmentDate),
              row.expectedDeliveryDate ? formatDate(row.expectedDeliveryDate) : "Not available",
              row.deliveryStatus,
              row.slaStatus === "historically-delayed"
                ? `Historical SLA exceeded${row.actualTransitDays !== null ? ` · ${row.actualTransitDays} transit days` : ""}`
                : row.slaStatus === "on-time"
                  ? "Within recorded SLA"
                  : row.slaStatus === "active"
                    ? row.overdueDays > 0 ? `${row.overdueDays} days past due` : "Non-terminal record"
                    : "Not computable",
              [row.lastEvent ?? "No recorded event", row.lastLocation, row.lastEventAt ? formatDate(row.lastEventAt) : null]
                .filter(Boolean)
                .join(" · "),
            ])}
            empty="No shipment records match this filter."
          />
          {rows.length === 50 && (
            <p className="investigation-message">Showing the latest 50 matching records.</p>
          )}
          <p className="panel-method-note">
            Historical delivery performance is not a live tracking feed. Personal phone numbers and addresses are intentionally excluded.
          </p>
        </>
      )}
    </ChartPanel>
  );
}

export function CompanyAdminDashboard() {
  const { employee, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const currentPage = location.pathname.split("/").filter(Boolean).at(-1) ?? "company-admin";
  const navigationTarget = currentPage === "company-admin" ? "dashboard" : currentPage;
  const [selection, setSelection] = useState<DateSelection>(() => getPreset("all"));
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<CompanySearchResult | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [shipmentFilter, setShipmentFilter] = useState<{ status?: string; routeId?: string; hubId?: string; consignmentNo?: string }>({});
  const [shipmentInvestigationOpen, setShipmentInvestigationOpen] = useState(false);
  const [shipments, setShipments] = useState<ShipmentInvestigationRow[]>([]);
  const [shipmentsLoading, setShipmentsLoading] = useState(false);
  const [shipmentsError, setShipmentsError] = useState<string | null>(null);
  const [eventConnection, setEventConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [pricingRoutes, setPricingRoutes] = useState<PricingRoute[]>([]);
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [pricingSettings, setPricingSettings] = useState<PricingSettings>({ senderPaysEnabled: true, receiverPaysEnabled: true, demoUpiEnabled: false, payAtPickupEnabled: false, payAtDeliveryEnabled: false, codEnabled: false });
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingSaving, setPricingSaving] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingSuccess, setPricingSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (currentPage !== "shipping-pricing") return;
    const controller = new AbortController();
    setPricingLoading(true); setPricingError(null); setPricingSuccess(null);
    authenticatedFetch("/api/company-admin/shipping-pricing", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => { const payload = await response.json() as { routes?: PricingRoute[]; rateRules?: Array<Record<string, unknown>>; settings?: Record<string, unknown>; error?: string }; if (!response.ok) throw new Error(payload.error ?? "Pricing settings could not be loaded."); return payload; })
      .then((payload) => {
        setPricingRoutes(payload.routes ?? []);
        setPricingRules((payload.rateRules ?? []).map((rule) => ({ originHubId:String(rule.originHubId),destinationHubId:String(rule.destinationHubId),mode:String(rule.mode),baseCharge:String(rule.baseCharge??""),includedWeightKg:String(rule.includedWeightKg??"1"),perKgCharge:String(rule.perKgCharge??"0"),serviceCharge:String(rule.serviceCharge??"0"),minimumCharge:String(rule.minimumCharge??"0"),taxRatePercent:String(rule.taxRatePercent??"0"),volumetricDivisor:rule.volumetricDivisor==null?"":String(rule.volumetricDivisor),active:Boolean(Number(rule.active)) })));
        const setting = payload.settings ?? {};
        setPricingSettings({ senderPaysEnabled:Boolean(Number(setting.senderPaysEnabled??1)),receiverPaysEnabled:Boolean(Number(setting.receiverPaysEnabled??1)),demoUpiEnabled:Boolean(Number(setting.demoUpiEnabled??0)),payAtPickupEnabled:Boolean(Number(setting.payAtPickupEnabled??0)),payAtDeliveryEnabled:Boolean(Number(setting.payAtDeliveryEnabled??0)),codEnabled:Boolean(Number(setting.codEnabled??0)) });
      })
      .catch((caught: unknown) => { if (!(caught instanceof DOMException && caught.name === "AbortError")) setPricingError(caught instanceof Error ? caught.message : "Pricing settings could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setPricingLoading(false); });
    return () => controller.abort();
  }, [currentPage]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (selection.start) query.set("startDate", selection.start);
    if (selection.end) query.set("endDate", selection.end);
    setLoading(true);
    setError(null);
    authenticatedFetch(`/api/company-admin/dashboard${query.size ? `?${query}` : ""}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as DashboardData & {
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Dashboard data could not be loaded.");
        return payload;
      })
      .then((payload) => {
        setData(payload);
        setFetchedAt(new Date().toISOString());
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Dashboard data could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selection.start, selection.end, retryCount]);

  useEffect(() => {
    const source = new EventSource("/api/company-admin/events");
    source.onopen = () => {
      setEventConnection("connected");
    };
    source.onerror = () => setEventConnection("reconnecting");
    source.addEventListener("company-data-changed", () => {
      setRetryCount((count) => count + 1);
      window.dispatchEvent(new Event("logix-company-data-changed"));
    });
    source.addEventListener("recovery-required", () => {
      setRetryCount((count) => count + 1);
      window.dispatchEvent(new Event("logix-company-data-changed"));
    });
    return () => source.close();
  }, []);

  useEffect(() => {
    if (!shipmentInvestigationOpen) return;
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (selection.start) query.set("startDate", selection.start);
    if (selection.end) query.set("endDate", selection.end);
    if (shipmentFilter.status) query.set("status", shipmentFilter.status);
    if (shipmentFilter.routeId) query.set("routeId", shipmentFilter.routeId);
    if (shipmentFilter.hubId) query.set("hubId", shipmentFilter.hubId);
    if (shipmentFilter.consignmentNo) query.set("consignmentNo", shipmentFilter.consignmentNo);
    setShipmentsLoading(true);
    setShipmentsError(null);
    authenticatedFetch(`/api/company-admin/shipments?${query}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as {
          shipments?: ShipmentInvestigationRow[];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Shipment records could not be loaded.");
        return payload.shipments ?? [];
      })
      .then(setShipments)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setShipmentsError(caught instanceof Error ? caught.message : "Shipment records could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setShipmentsLoading(false);
      });
    return () => controller.abort();
  }, [selection.start, selection.end, shipmentFilter, shipmentInvestigationOpen, retryCount]);

  const exceptionCount = useMemo(
    () => data?.charts.exceptions.reduce((sum, row) => sum + row.events, 0) ?? 0,
    [data],
  );
  if (!employee) return null;

  function handleSearchSelect(result: CompanySearchResult) {
    setSelectedRecord(result);
    if (result.result_type === "shipment") {
      setShipmentFilter({ consignmentNo: result.result_id });
      setShipmentInvestigationOpen(true);
      navigate("/company-admin");
      window.setTimeout(() => document.getElementById("shipment-investigation")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    } else {
      navigate(`/company-admin/${result.result_type === "customer" ? "customers" : "routes"}`);
    }
  }

  function inspectShipments(filter: { status?: string; routeId?: string; hubId?: string; consignmentNo?: string }) {
    setShipmentFilter(filter);
    setShipmentInvestigationOpen(true);
    window.setTimeout(() => document.getElementById("shipment-investigation")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function updatePricingRule(index: number, patch: Partial<PricingRule>) {
    setPricingRules((rules) => rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule));
    setPricingSuccess(null);
  }

  async function saveShippingPricing() {
    setPricingSaving(true); setPricingError(null); setPricingSuccess(null);
    try {
      if (pricingRules.some((rule) => [rule.baseCharge, rule.includedWeightKg, rule.perKgCharge, rule.serviceCharge, rule.minimumCharge, rule.taxRatePercent, rule.volumetricDivisor].some((value) => value !== "" && !Number.isFinite(Number(value))) || [rule.baseCharge, rule.perKgCharge, rule.serviceCharge, rule.minimumCharge].every((value) => Number(value || 0) === 0))) {
        throw new Error("Enter valid non-negative amounts and at least one positive charge for each active rate rule.");
      }
      const response = await authenticatedFetch("/api/company-admin/shipping-pricing", { method:"PUT", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ settings:pricingSettings, rateRules:pricingRules.map((rule) => ({ ...rule, baseCharge:Number(rule.baseCharge||0), includedWeightKg:Number(rule.includedWeightKg), perKgCharge:Number(rule.perKgCharge||0), serviceCharge:Number(rule.serviceCharge||0), minimumCharge:Number(rule.minimumCharge||0), taxRatePercent:Number(rule.taxRatePercent||0), volumetricDivisor:rule.volumetricDivisor===""?null:Number(rule.volumetricDivisor) })) }) });
      const payload = await response.json() as { error?:string; rateRuleCount?:number };
      if (!response.ok) throw new Error(payload.error ?? "Pricing settings could not be saved.");
      setPricingSuccess(`${payload.rateRuleCount ?? 0} route rate(s) saved for ${employee!.company.name}.`);
    } catch (caught) { setPricingError(caught instanceof Error ? caught.message : "Pricing settings could not be saved."); }
    finally { setPricingSaving(false); }
  }

  function addPricingRule() {
    const route = pricingRoutes.find((item) => !pricingRules.some((rule) => rule.originHubId === item.originHubId && rule.destinationHubId === item.destinationHubId && rule.mode.toLowerCase() === item.mode.toLowerCase()));
    if (!route) { setPricingError(pricingRoutes.length ? "Every active route/service already has a pricing row." : "Configure an active route before adding a rate."); return; }
    setPricingRules((rules) => [...rules, { originHubId:route.originHubId,destinationHubId:route.destinationHubId,mode:route.mode,baseCharge:"",includedWeightKg:"1",perKgCharge:"",serviceCharge:"",minimumCharge:"",taxRatePercent:"",volumetricDivisor:"",active:true }]);
  }

  return (
    <div
      className="control-tower"
      style={{
        "--tenant-accent": employee.company.branding.accentColor ?? "#c9a967",
      } as CSSProperties}
    >
      {data && (
        <div aria-hidden="true" className="dashboard-watermark">
          {employee.company.branding.logoPath ? (
            <img alt="" src={employee.company.branding.logoPath} />
          ) : (
            employee.company.name
          )}
        </div>
      )}
      <Sidebar
        currentPage={navigationTarget}
        employee={employee}
        exceptionCount={exceptionCount}
        mobileOpen={mobileNavOpen}
        onNavigate={() => setMobileNavOpen(false)}
      />
      {mobileNavOpen && <button aria-label="Close navigation" className="sidebar-scrim" onClick={() => setMobileNavOpen(false)} type="button" />}
      <main className="control-main">
        <button aria-label="Open navigation" className="mobile-nav-toggle" onClick={() => setMobileNavOpen((open) => !open)} type="button">☰</button>
        <DashboardHeader
          employee={employee}
          exceptionCount={exceptionCount}
          onSearchSelect={handleSearchSelect}
          onSignOut={async () => {
            await signOut();
            navigate("/login", { replace: true });
          }}
          selection={selection}
          setSelection={setSelection}
        />
        <div className="control-content" id="dashboard">
          <div className="snapshot-banner">
            <span className={`event-connection event-${eventConnection}`} role="status">
              <i />{eventConnection === "connected" ? "Event channel connected" : eventConnection === "connecting" ? "Connecting to event channel" : "Reconnecting to event channel"}
            </span>
            {fetchedAt && !loading && !error && <small>Data as of {new Date(fetchedAt).toLocaleString()}</small>}
          </div>
          {loading && <div aria-live="polite" className="dashboard-loading"><span className="loading-orbit" />Loading company aggregates…</div>}
          {error && (
            <div className="dashboard-error" role="alert">
              <span>{error}</span>
              <button onClick={() => setRetryCount((count) => count + 1)} type="button">
                Retry
              </button>
            </div>
          )}
          {selectedRecord && (
            <div className="search-selection" role="status">
              Search result selected: <strong>{selectedRecord.label}</strong> · {selectedRecord.result_type} · {selectedRecord.detail}
              <button aria-label="Dismiss search selection" onClick={() => setSelectedRecord(null)} type="button">×</button>
            </div>
          )}
          {currentPage === "company-admin" && data && !loading && !error && (
            <KpiCards data={data} />
          )}
          {currentPage === "company-admin" && data && !loading && !error && (
            <>
              <div className="rule-action-banner">
                <span className="rule-action-icon" aria-hidden="true">!</span>
                <div>
                  <strong>{data.kpis.atRiskShipments > 0 ? `Review ${formatNumber(data.kpis.atRiskShipments)} overdue non-terminal shipments` : "No overdue non-terminal shipment records found"}</strong>
                  <p>Based on recorded due dates and shipment statuses; inspect shipment records for details.</p>
                </div>
                {data.kpis.atRiskShipments > 0 && (
                  <button onClick={() => inspectShipments({})} type="button">Review records</button>
                )}
              </div>
              <p className="comparison-caption">{comparisonText(data)}</p>

              <div className="analytics-row analytics-row-primary" id="shipments">
                <ChartPanel className="panel-volume" id="monthly-performance" title="Shipment Volume & On-Time Performance">
                  <p className="panel-method-note">{data.range.trendGranularity === "day" ? "Daily" : "Weekly"} records · volume and delivery rate use separate axes.</p>
                  <MonthlyPerformance rows={data.charts.timeline} />
                </ChartPanel>
                <ChartPanel className="panel-mode" id="mode-distribution" title="Shipment Distribution by Mode">
                  <ModeDistribution rows={data.charts.modes} />
                </ChartPanel>
                <ChartPanel className="panel-status" id="status-distribution" title="Recorded Status Distribution">
                  <StatusDistribution rows={data.charts.statuses} onSelect={(status) => inspectShipments({ status })} />
                </ChartPanel>
              </div>
              <div className="analytics-row analytics-row-status">
                <ChartPanel className="panel-status" id="mode-status" title="Historical Outcome by Mode">
                  <ModeStatus rows={data.charts.modes} />
                </ChartPanel>
                <div className="period-context">
                  <span className="chart-eyebrow">PERIOD CONTEXT</span>
                  <strong>{formatDate(data.range.availableStartDate)} – {formatDate(data.range.availableEndDate)}</strong>
                  <p>{data.freshness.note}</p>
                  <p>{data.kpis.baselineSlaNote} {data.kpis.baselineSlaDays}-day baseline is used only when a shipment has no recorded SLA.</p>
                  <p>On-time rate: {formatNumber(data.kpis.onTimeDelivered)} on-time terminal records / {formatNumber(data.kpis.eligibleDelivered)} eligible terminal records.</p>
                </div>
              </div>

              <div className="analytics-row analytics-row-routes" id="routes">
                <ChartPanel title="Top 10 Busiest Routes" id="busiest-routes">
                  <DataTable
                    headers={["#", "Route", "Mode", "Shipments", "Delay rate"]}
                    rows={data.charts.routesByVolume.map((route, index) => [
                      index + 1,
                      <button className="table-link-button" key={route.id} onClick={() => inspectShipments({ routeId: route.id })} type="button">{route.name}</button>,
                      route.mode,
                      formatNumber(route.shipments),
                      route.delayRatePercent === null ? "n/a" : `${route.delayRatePercent.toFixed(1)}%`,
                    ])}
                    empty="No route shipment records in this date range."
                  />
                </ChartPanel>
                <ChartPanel title="Routes with Highest Delay Rate" id="route-delay">
                  <p className="panel-method-note">Only routes with at least 20 eligible deliveries are ranked.</p>
                  <DataTable
                    headers={["Route", "Mode", "Eligible", "Delay rate"]}
                    rows={data.charts.routesByDelay.map((route) => [
                      <button className="table-link-button" key={route.id} onClick={() => inspectShipments({ routeId: route.id })} type="button">{route.name}</button>,
                      route.mode,
                      formatNumber(route.eligibleDelivered),
                      route.delayRatePercent === null ? "n/a" : `${route.delayRatePercent.toFixed(1)}%`,
                    ])}
                    empty="No routes meet the 20-delivery minimum sample threshold."
                  />
                </ChartPanel>
              </div>

              <div className="analytics-row analytics-row-hubs" id="hubs">
                <ChartPanel className="panel-hubs-table" title="Hub Performance" id="hub-performance">
                  <p className="panel-method-note">Shipment legs count distinct consignments touching a hub as origin or destination.</p>
                  <DataTable
                    headers={["Hub", "Shipment legs", "Delay rate", "Avg. transit"]}
                    rows={data.charts.hubs.slice(0, 12).map((hub) => [
                      <button className="table-link-button" key={hub.id} onClick={() => inspectShipments({ hubId: hub.id })} type="button">{hub.city}</button>,
                      formatNumber(hub.shipments),
                      hub.delayRatePercent === null ? "n/a" : `${hub.delayRatePercent.toFixed(1)}%`,
                      hub.averageTransitDays === null ? "n/a" : `${hub.averageTransitDays.toFixed(1)} days`,
                    ])}
                    empty="No hub shipment data in this range."
                  />
                </ChartPanel>
                <ChartPanel className="panel-scatter" title="Hub Load vs Delay Rate" id="hub-load">
                  <HubScatter rows={data.charts.hubs} onSelect={(hubId) => inspectShipments({ hubId })} />
                  <p className="panel-method-note">Each point is a hub; delay rate uses eligible delivered shipments.</p>
                </ChartPanel>
              </div>

              <div className="analytics-row analytics-row-insights">
                <ChartPanel className="panel-customer" id="customers" title="Customer Insights">
                  <SplitDonut
                    first={data.charts.customerInsights.repeatCustomers}
                    firstLabel="Repeat"
                    second={data.charts.customerInsights.oneTimeCustomers}
                    secondLabel="One-time"
                  />
                  <DataTable
                    headers={["Top customers by shipments", "Shipment count"]}
                    rows={data.charts.customerInsights.topCustomers.map((customer) => [customer.name, formatNumber(customer.shipments)])}
                    empty="No customer shipment activity in this range."
                  />
                </ChartPanel>
                <ChartPanel className="panel-revenue" title="Revenue & Tariff Analysis" id="revenue-analysis">
                  <div className="revenue-summary">
                    <span>Estimated shipment charges</span>
                    <strong>{formatNumber(data.kpis.estimatedRevenue, 2)}</strong>
                    <small>Source: {data.kpis.estimatedRevenueSource}. Currency is not configured for this tenant.</small>
                  </div>
                  <RevenueChart rows={data.charts.timeline} />
                </ChartPanel>
                <ChartPanel className="panel-exceptions" id="exceptions" title="Exception Analysis">
                  {data.charts.exceptions.length ? (
                    <DataTable
                      headers={["Exception category", "Event records"]}
                      rows={data.charts.exceptions.map((row) => [row.category, formatNumber(row.events)])}
                      empty="No exception records available."
                    />
                  ) : (
                    <EmptyState>No exception records available for this company and date range.</EmptyState>
                  )}
                </ChartPanel>
                <ChartPanel className="panel-employee" id="employees" title="Employee & Hub Coverage">
                  <div className="coverage-stats">
                    <div><strong>{formatNumber(data.charts.employees.total)}</strong><span>Employee records</span></div>
                    <div><strong>{formatNumber(data.charts.employees.assignedToHub)}</strong><span>Employees with active hub assignment</span></div>
                    <div><strong>{formatNumber(data.charts.employees.hubsWithActiveAssignments)} / {formatNumber(data.charts.employees.activeHubs)}</strong><span>Active hubs with assigned staff</span></div>
                  </div>
                  <RoleBars rows={data.charts.employees.roles} />
                </ChartPanel>
              </div>

              {shipmentInvestigationOpen && (
                <ShipmentInvestigation
                  error={shipmentsError}
                  filter={shipmentFilter}
                  loading={shipmentsLoading}
                  onClose={() => setShipmentInvestigationOpen(false)}
                  rows={shipments}
                />
              )}

              <div className="analytics-row analytics-row-footer">
                <ChartPanel className="panel-powerbi" id="powerbi" title="Power BI Reports">
                  <div className="integration-state">
                    <span className="integration-icon">▥</span>
                    <div>
                      <strong>Secure report connection not configured</strong>
                      <p>{data.integrations.powerBiMessage}</p>
                      <small>Required: tenant/workspace ID, report ID, server-side embed-token flow, and approved report permissions.</small>
                    </div>
                  </div>
                </ChartPanel>
                <ChartPanel className="panel-settings" id="settings" title="Company Settings">
                  <div className="tenant-settings">
                    <div><span>Company</span><strong>{employee.company.name}</strong></div>
                    <div><span>Company ID</span><strong>{employee.company.id}</strong></div>
                    <div><span>Role</span><strong>Company Admin</strong></div>
                    <p>Branding is loaded from company-scoped configuration. Logo: {employee.company.branding.logoPath ? "configured" : "not configured"}; accent: {employee.company.branding.accentColor ?? "platform default"}.</p>
                  </div>
                </ChartPanel>
              </div>

              <footer className="dashboard-footer">
                <span>{employee.company.name} · Company Admin Workspace</span>
                <span>{data.freshness.note}</span>
              </footer>
              <p className="sla-disclaimer">{data.kpis.baselineSlaNote} Recorded `sla_days` is used when available; {data.kpis.baselineSlaDays}-day baseline is fallback only.</p>
            </>
          )}
          {isRecordPageKind(currentPage) && (
            <CompanyRecordsPage
              companyName={employee.company.name}
              kind={currentPage}
              initialSearch={selectedRecord?.result_type === currentPage.slice(0, -1) ? selectedRecord.result_id : ""}
              onInspectShipment={(consignmentNo) => {
                setShipmentFilter({ consignmentNo });
                setShipmentInvestigationOpen(true);
                navigate("/company-admin");
              }}
            />
          )}
          {data && currentPage === "reports-analytics" && (
            <section className="records-page">
              <div className="records-heading">
                <div>
                  <span className="chart-eyebrow">{employee.company.name.toUpperCase()} · HISTORICAL ANALYTICS</span>
                  <h2>Reports &amp; Analytics</h2>
                  <p>Interactive charts from company-scoped recorded shipment history. Filters in the header apply to this snapshot.</p>
                </div>
              </div>
              <div className="analytics-row analytics-row-primary">
                <ChartPanel className="panel-volume" id="report-volume" title="Shipment Volume & On-Time Performance"><MonthlyPerformance rows={data.charts.timeline} /></ChartPanel>
                <ChartPanel className="panel-mode" id="report-modes" title="Shipment Distribution by Mode"><ModeDistribution rows={data.charts.modes} /></ChartPanel>
                <ChartPanel className="panel-status" id="report-status" title="Recorded Status Distribution"><StatusDistribution rows={data.charts.statuses} /></ChartPanel>
              </div>
              <div className="analytics-row analytics-row-status">
                <ChartPanel className="panel-revenue" id="report-revenue" title="Estimated Charges"><RevenueChart rows={data.charts.timeline} /></ChartPanel>
                <ChartPanel className="panel-status" id="report-delivery" title="Historical Outcome by Mode"><ModeStatus rows={data.charts.modes} /></ChartPanel>
              </div>
              <div className="records-notice">Power BI is not configured for this tenant; no external report is connected.</div>
            </section>
          )}
          {data && currentPage === "advanced-analytics" && (
            <section className="records-page">
              <div className="records-heading"><div><span className="chart-eyebrow">HISTORICAL ANALYSIS</span><h2>Advanced Analytics</h2><p>Analysis is based on stored historical records; no trained or validated predictive model is configured.</p></div></div>
              <div className="analytics-row analytics-row-routes">
                <ChartPanel className="panel-scatter" id="advanced-hubs" title="Hub workload vs recorded delay rate"><HubScatter rows={data.charts.hubs} onSelect={(hubId) => {
                  setShipmentFilter({ hubId });
                  setShipmentInvestigationOpen(true);
                  navigate("/company-admin");
                }} /></ChartPanel>
                <ChartPanel className="panel-revenue" id="advanced-revenue" title="Recorded charge trend"><RevenueChart rows={data.charts.timeline} /></ChartPanel>
              </div>
              <div className="records-notice">Predictive analytics are unavailable: the project has no trained and validated forecasting model. No predictions or accuracy values are fabricated.</div>
            </section>
          )}
          {data && currentPage === "powerbi" && (
            <section className="records-page">
              <div className="records-heading"><div><span className="chart-eyebrow">SECURE REPORTING</span><h2>Power BI Reports</h2><p>Company-scoped report integration status.</p></div></div>
              <ChartPanel className="panel-powerbi" id="powerbi-setup" title="Power BI connection">
                <div className="integration-state"><span className="integration-icon">▥</span><div><strong>{data.integrations.powerBiConfigured ? "Power BI configured" : "Secure report connection not configured"}</strong><p>{data.integrations.powerBiMessage}</p><small>Reports require tenant-specific workspace/report IDs, server-side embed-token handling and approved permissions.</small></div></div>
              </ChartPanel>
            </section>
          )}
          {currentPage === "notifications" && (
            <section className="records-page">
              <div className="records-heading"><div><span className="chart-eyebrow">RECORDED COMPANY EVENTS</span><h2>Notifications</h2><p>Stored exception-related event aggregates and rule-based overdue alerts.</p></div></div>
              {data && <DataTable headers={["Recorded event category", "Event count"]} rows={data.charts.exceptions.map((item) => [item.category, formatNumber(item.events)])} empty="No exception-related event records exist in this snapshot." />}
              <div className="records-notice">No persistent user notification system or event publisher is configured. This page does not claim live notification delivery.</div>
            </section>
          )}
          {currentPage === "shipping-pricing" && (
            <section className="records-page">
              <div className="records-heading"><div><span className="chart-eyebrow">COMPANY CONFIGURATION</span><h2>Shipping Pricing</h2><p>Configure rate rules for active company routes. Customer quote amounts come only from saved rules; no sample tariff is prefilled.</p></div></div>
              {pricingError && <p className="company-pricing-alert" role="alert">{pricingError}</p>}{pricingSuccess && <p className="company-pricing-success" role="status">{pricingSuccess}</p>}
              {pricingLoading ? <p aria-busy="true">Loading company pricing…</p> : <>
                <ChartPanel className="panel-settings" id="company-payment-options" title="Who pays and supported collection methods">
                  <div className="company-pricing-toggles">{([ ["senderPaysEnabled","Sender can pay shipping"],["receiverPaysEnabled","Receiver can pay shipping"],["demoUpiEnabled","Online · Demo UPI (non-payable simulation)"],["payAtPickupEnabled","Pay at pickup · demo collection"],["payAtDeliveryEnabled","Pay at delivery · demo collection"],["codEnabled","Enable separate COD goods collection"] ] as const).map(([key,label]) => <label key={key}><input type="checkbox" checked={pricingSettings[key]} onChange={(event) => setPricingSettings((settings) => ({ ...settings, [key]:event.target.checked }))}/><span>{label}</span></label>)}</div>
                  <p className="panel-method-note">No real gateway or money transfer is connected. Online and offline collection records are labeled DEMO. Route records contain no distance field, so distance pricing is unavailable.</p>
                </ChartPanel>
                <ChartPanel className="panel-settings" id="company-rate-rules" title="Route rate rules">
                  <div className="company-rate-toolbar"><span>{pricingRoutes.length} active route/service options</span><button className="op-button-primary" type="button" onClick={addPricingRule}>Add route rate</button></div>
                  {pricingRoutes.length===0&&<p>No active routes are configured for this company.</p>}
                  <div className="company-rate-list">{pricingRules.map((rule,index) => <article className="company-rate-card" key={`${rule.originHubId}-${rule.destinationHubId}-${rule.mode}`}>
                    <header><strong>{rule.originHubId} → {rule.destinationHubId} · {rule.mode}</strong><label><input type="checkbox" checked={rule.active} onChange={(event)=>updatePricingRule(index,{active:event.target.checked})}/>Active</label><button className="customer-switch-button" type="button" onClick={()=>setPricingRules((items)=>items.filter((_,itemIndex)=>itemIndex!==index))}>Remove</button></header>
                    <div className="company-rate-fields"><label>Origin / destination / service<select value={`${rule.originHubId}|${rule.destinationHubId}|${rule.mode}`} onChange={(event)=>{const [originHubId,destinationHubId,mode]=event.target.value.split("|");updatePricingRule(index,{originHubId:originHubId!,destinationHubId:destinationHubId!,mode:mode!});}}>{pricingRoutes.map((route)=><option key={`${route.originHubId}|${route.destinationHubId}|${route.mode}`} value={`${route.originHubId}|${route.destinationHubId}|${route.mode}`}>{route.originCity} ({route.originHubId}) → {route.destinationCity} ({route.destinationHubId}) · {route.mode}</option>)}</select></label>
                    {([["baseCharge","Base charge"],["includedWeightKg","Included weight (kg)"],["perKgCharge","Charge per additional kg"],["serviceCharge","Additional service charge"],["minimumCharge","Minimum total before tax"],["taxRatePercent","Tax rate (%)"],["volumetricDivisor","Volumetric divisor (L×W×H / divisor)"]] as const).map(([key,label])=><label key={key}>{label}<input type="number" min="0" step="0.01" value={rule[key]} placeholder="Enter company rate" onChange={(event)=>updatePricingRule(index,{[key]:event.target.value})}/></label>)}</div>
                  </article>)}{pricingRules.length===0&&pricingRoutes.length>0&&<p>No rates saved. Add a rate and enter company-approved amounts before booking quotes become available.</p>}</div>
                  <button className="op-button-primary" disabled={pricingSaving} onClick={()=>void saveShippingPricing()} type="button">{pricingSaving?"Saving…":"Save shipping pricing"}</button>
                </ChartPanel>
              </>}
            </section>
          )}
          {currentPage === "settings" && (
            <section className="records-page">
              <div className="records-heading"><div><span className="chart-eyebrow">TENANT CONFIGURATION</span><h2>Company Settings</h2><p>Read-only settings currently exposed for your authenticated company.</p></div></div>
              <ChartPanel className="panel-settings" id="settings-readonly" title="Company profile">
                <div className="tenant-settings">
                  <div><span>Company</span><strong>{employee.company.name}</strong></div>
                  <div><span>Company ID</span><strong>{employee.company.id}</strong></div>
                  <div><span>Role</span><strong>Company Admin</strong></div>
                  <div><span>Logo</span><strong>{employee.company.branding.logoPath ?? "Not configured"}</strong></div>
                  <div><span>Brand accent</span><strong>{employee.company.branding.accentColor ?? "Platform default"}</strong></div>
                  <p>Operational preferences and SLA rules have no persistence API in the current project and are not editable here.</p>
                </div>
              </ChartPanel>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
