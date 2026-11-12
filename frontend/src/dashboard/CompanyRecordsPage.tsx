import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { authenticatedFetch } from "../auth";

export type RecordPageKind =
  | "shipments"
  | "customers"
  | "employees"
  | "hubs"
  | "routes"
  | "exceptions";

type RecordRow = Record<string, string | number | null>;
type Column = { key: string; label: string };
type EmployeeRole = "COMPANY_ADMIN" | "OPERATIONS_MANAGER" | "HUB_MANAGER" | "LOGISTICS_EXECUTIVE";
type EmployeeForm = {
  employeeId: string;
  name: string;
  role: EmployeeRole;
  email: string;
  phone: string;
  status: "Active" | "Inactive";
  hubIds: string[];
  password: string;
};
type HubOption = { hubId: string; city: string };
type DialogMotion = { x: string; y: string; scale: number };
const employeeRoleLabels: Record<EmployeeRole, string> = {
  COMPANY_ADMIN: "Company Admin",
  OPERATIONS_MANAGER: "Operations Manager",
  HUB_MANAGER: "Hub Manager",
  LOGISTICS_EXECUTIVE: "Logistics Executive",
};

function emptyEmployeeForm(): EmployeeForm {
  return {
    employeeId: "",
    name: "",
    role: "LOGISTICS_EXECUTIVE",
    email: "",
    phone: "",
    status: "Active",
    hubIds: [],
    password: "",
  };
}

const pageConfig: Record<RecordPageKind, { title: string; description: string; columns: Column[] }> = {
  shipments: {
    title: "Shipment Management",
    description: "Company-scoped shipment records from the database snapshot.",
    columns: [
      { key: "consignmentNo", label: "Consignment ID" },
      { key: "customerId", label: "Customer ID" },
      { key: "customerName", label: "Customer" },
      { key: "origin", label: "Origin" },
      { key: "destination", label: "Destination" },
      { key: "originHubId", label: "Origin hub" },
      { key: "destinationHubId", label: "Destination hub" },
      { key: "mode", label: "Mode" },
      { key: "chargeableWeight", label: "Weight" },
      { key: "shipmentDate", label: "Booking date" },
      { key: "expectedDeliveryDate", label: "Expected delivery" },
      { key: "status", label: "Current status" },
      { key: "recordedOutcome", label: "Recorded outcome" },
      { key: "slaAssessment", label: "SLA assessment" },
    ],
  },
  customers: {
    title: "Customers",
    description: "Customer records with shipment counts and most recent booking date. Contact details are not exposed in this view.",
    columns: [
      { key: "customerId", label: "Customer ID" },
      { key: "customerName", label: "Customer" },
      { key: "city", label: "City" },
      { key: "shipmentCount", label: "Shipments" },
      { key: "recordedDelayed", label: "Recorded delayed" },
      { key: "latestShipment", label: "Latest shipment" },
    ],
  },
  employees: {
    title: "Employees",
    description: "Company employees, contact details, active hub assignments, and account status. Passwords and authentication secrets are never displayed.",
    columns: [
      { key: "employeeId", label: "Employee ID" },
      { key: "name", label: "Name" },
      { key: "phone", label: "Phone" },
      { key: "email", label: "Email" },
      { key: "role", label: "Database role" },
      { key: "assignedHubs", label: "Assigned active hubs" },
      { key: "status", label: "Account status" },
    ],
  },
  hubs: {
    title: "Hubs",
    description: "Company hubs with active assigned staff and shipment workload.",
    columns: [
      { key: "hubId", label: "Hub ID" },
      { key: "city", label: "City" },
      { key: "status", label: "Status" },
      { key: "assignedStaff", label: "Assigned staff" },
      { key: "shipment_legs", label: "Shipment legs" },
    ],
  },
  routes: {
    title: "Routes",
    description: "Configured company routes with shipment volume and recorded delay rates.",
    columns: [
      { key: "routeId", label: "Route ID" },
      { key: "origin", label: "Origin" },
      { key: "destination", label: "Destination" },
      { key: "mode", label: "Mode" },
      { key: "shipmentCount", label: "Shipments" },
      { key: "recordedDelayed", label: "Recorded delayed" },
      { key: "delay_rate", label: "Delay rate %" },
    ],
  },
  exceptions: {
    title: "Exceptions & SLA Alerts",
    description: "Rule-based alerts for non-terminal shipments past their recorded SLA due date. These are not AI predictions or persisted exception events.",
    columns: [
      { key: "consignmentNo", label: "Consignment ID" },
      { key: "source", label: "Alert source" },
      { key: "shipmentDate", label: "Booking date" },
      { key: "eventTime", label: "Event time" },
      { key: "eventType", label: "Recorded event" },
      { key: "status", label: "Recorded status" },
      { key: "dueDate", label: "SLA due date" },
      { key: "overdueDays", label: "Days overdue" },
    ],
  },
};

function display(value: RecordRow[string]): string {
  if (value === null || value === "") return "—";
  return String(value);
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function CompanyRecordsPage({
  kind,
  companyName,
  initialSearch = "",
  onInspectShipment,
}: {
  kind: RecordPageKind;
  companyName: string;
  initialSearch?: string;
  onInspectShipment: (consignmentNo: string) => void;
}) {
  const config = pageConfig[kind];
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sortBy, setSortBy] = useState(config.columns[0]?.key ?? "");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const [dialogMotion, setDialogMotion] = useState<DialogMotion>({ x: "0px", y: "0px", scale: 0.82 });
  const [dialogAccent, setDialogAccent] = useState("#c9a967");
  const [relatedShipments, setRelatedShipments] = useState<RecordRow[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  const [selectedDetails, setSelectedDetails] = useState<Record<string, string | number | null> | null>(null);
  const [selectedDetailEmployees, setSelectedDetailEmployees] = useState<Array<Record<string, string | number | null>>>([]);
  const [selectedDetailsLoading, setSelectedDetailsLoading] = useState(false);
  const [selectedDetailsError, setSelectedDetailsError] = useState<string | null>(null);
  const [shipmentEvents, setShipmentEvents] = useState<Array<Record<string, string | number | null>>>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [employeeModalOpen, setEmployeeModalOpen] = useState(false);
  const [employeeSaving, setEmployeeSaving] = useState(false);
  const [employeeError, setEmployeeError] = useState<string | null>(null);
  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);
  const [employeeForm, setEmployeeForm] = useState<EmployeeForm>(emptyEmployeeForm);
  const [hubOptions, setHubOptions] = useState<HubOption[]>([]);
  const [hubOptionsError, setHubOptionsError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogCloseRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const dialogOpen = Boolean(selected) || employeeModalOpen;

  useEffect(() => {
    if (!dialogOpen) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogCloseRef.current?.focus();

    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelected(null);
        setEmployeeModalOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleDialogKeys);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleDialogKeys);
      if (previouslyFocusedRef.current?.isConnected) previouslyFocusedRef.current.focus();
    };
  }, [dialogOpen]);

  useEffect(() => {
    if (initialSearch) {
      setSearch(initialSearch);
      setPage(1);
    }
  }, [initialSearch]);

  useEffect(() => {
    if (kind !== "shipments" || typeof selected?.consignmentNo !== "string") {
      setShipmentEvents([]);
      setEventsError(null);
      return;
    }
    const controller = new AbortController();
    setEventsLoading(true);
    setEventsError(null);
    authenticatedFetch(`/api/company-admin/shipments/${encodeURIComponent(selected.consignmentNo)}/events`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as { events?: Array<Record<string, string | number | null>>; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Shipment event history could not be loaded.");
        return payload.events ?? [];
      })
      .then(setShipmentEvents)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setEventsError(caught instanceof Error ? caught.message : "Shipment event history could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setEventsLoading(false);
      });
    return () => controller.abort();
  }, [kind, selected?.consignmentNo, reloadToken]);

  useEffect(() => {
    if (!selected || kind === "shipments") {
      setRelatedShipments([]);
      setRelatedError(null);
      return;
    }
    const filterKey =
      kind === "customers" ? ["customerId", selected.customerId] :
      kind === "hubs" ? ["hubId", selected.hubId] :
      kind === "routes" ? ["routeId", selected.routeId] : null;
    if (!filterKey || typeof filterKey[1] !== "string") {
      setRelatedShipments([]);
      return;
    }
    const controller = new AbortController();
    setRelatedLoading(true);
    setRelatedError(null);
    authenticatedFetch(`/api/company-admin/shipments?${filterKey[0]}=${encodeURIComponent(filterKey[1])}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as { shipments?: RecordRow[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Related shipments could not be loaded.");
        return payload.shipments ?? [];
      })
      .then(setRelatedShipments)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setRelatedError(caught instanceof Error ? caught.message : "Related shipments could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRelatedLoading(false);
      });
    return () => controller.abort();
  }, [kind, selected, reloadToken]);

  useEffect(() => {
    if (!selected || (kind !== "customers" && kind !== "hubs")) {
      setSelectedDetails(null);
      setSelectedDetailEmployees([]);
      setSelectedDetailsError(null);
      return;
    }
    const idKey = kind === "customers" ? selected.customerId : selected.hubId;
    if (typeof idKey !== "string") return;
    const controller = new AbortController();
    setSelectedDetailsLoading(true);
    setSelectedDetailsError(null);
    const path = kind === "customers" ? "customers" : "hubs";
    authenticatedFetch(`/api/company-admin/${path}/${encodeURIComponent(idKey)}/details`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as {
          customer?: Record<string, string | number | null>;
          hub?: Record<string, string | number | null>;
          employees?: Array<Record<string, string | number | null>>;
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Record details could not be loaded.");
        return {
          record: kind === "customers" ? payload.customer ?? null : payload.hub ?? null,
          employees: payload.employees ?? [],
        };
      })
      .then(({ record, employees }) => {
        setSelectedDetails(record);
        setSelectedDetailEmployees(employees);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setSelectedDetailsError(caught instanceof Error ? caught.message : "Record details could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setSelectedDetailsLoading(false);
      });
    return () => controller.abort();
  }, [kind, selected, reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      q: search.trim(),
      sortBy,
      direction,
      status,
      mode,
      startDate,
      endDate,
    });
    setLoading(true);
    setError(null);
    authenticatedFetch(`/api/company-admin/records/${kind}?${params}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as {
          rows?: RecordRow[];
          pagination?: { total: number; totalPages: number };
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Company records could not be loaded.");
        return payload;
      })
      .then((payload) => {
        setRows(payload.rows ?? []);
        setTotal(payload.pagination?.total ?? 0);
        setTotalPages(payload.pagination?.totalPages ?? 0);
        setSelected((current) => {
          if (kind !== "shipments" || typeof current?.consignmentNo !== "string") return current;
          return payload.rows?.find((row) => row.consignmentNo === current.consignmentNo) ?? current;
        });
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Company records could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kind, page, pageSize, search, sortBy, direction, status, mode, startDate, endDate, reloadToken]);

  useEffect(() => {
    const onCompanyDataChanged = () => setReloadToken((token) => token + 1);
    window.addEventListener("logix-company-data-changed", onCompanyDataChanged);
    return () => window.removeEventListener("logix-company-data-changed", onCompanyDataChanged);
  }, []);

  useEffect(() => {
    if (kind !== "employees") return;
    const controller = new AbortController();
    authenticatedFetch("/api/company-admin/employee-management/hubs", {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as { hubs?: HubOption[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Hub options could not be loaded.");
        return payload.hubs ?? [];
      })
      .then(setHubOptions)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setHubOptionsError(caught instanceof Error ? caught.message : "Hub options could not be loaded.");
      });
    return () => controller.abort();
  }, [kind]);

  function updateSearch(value: string) {
    setSearch(value);
    setPage(1);
  }

  function setDialogMotionFrom(trigger?: HTMLElement | null) {
    const dashboard = document.querySelector<HTMLElement>(".control-tower");
    const dashboardAccent = dashboard
      ? getComputedStyle(dashboard).getPropertyValue("--tenant-accent").trim()
      : "";
    setDialogAccent(dashboardAccent || "#c9a967");
    const rect = trigger?.getBoundingClientRect();
    if (!rect) {
      setDialogMotion({ x: "0px", y: "0px", scale: 0.82 });
      return;
    }
    const areaRatio = Math.sqrt((rect.width * rect.height) / (820 * 600));
    setDialogMotion({
      x: `${rect.left + rect.width / 2 - window.innerWidth / 2}px`,
      y: `${rect.top + rect.height / 2 - window.innerHeight / 2}px`,
      scale: Math.max(0.1, Math.min(0.24, areaRatio)),
    });
  }

  function openRecord(row: RecordRow, trigger: HTMLElement) {
    setDialogMotionFrom(trigger);
    setSelected(row);
  }

  function beginCreateEmployee(trigger?: HTMLElement | null) {
    setDialogMotionFrom(trigger);
    setEditingEmployeeId(null);
    setEmployeeForm(emptyEmployeeForm());
    setEmployeeError(null);
    setEmployeeModalOpen(true);
  }

  async function beginEditEmployee(employeeId: string, trigger?: HTMLElement | null) {
    setDialogMotionFrom(trigger);
    setEmployeeError(null);
    try {
      const response = await authenticatedFetch(`/api/company-admin/employees/${encodeURIComponent(employeeId)}`, {
        credentials: "same-origin",
      });
      const payload = await response.json() as {
        employee?: Omit<EmployeeForm, "hubIds" | "password">;
        hubIds?: string[];
        error?: string;
      };
      if (!response.ok || !payload.employee) {
        throw new Error(payload.error ?? "Employee details could not be loaded.");
      }
      setEditingEmployeeId(employeeId);
      setEmployeeForm({
        ...emptyEmployeeForm(),
        ...payload.employee,
        role: payload.employee.role,
        email: payload.employee.email ?? "",
        phone: payload.employee.phone ?? "",
        status: payload.employee.status === "Inactive" ? "Inactive" : "Active",
        hubIds: payload.hubIds ?? [],
      });
      setEmployeeModalOpen(true);
    } catch (caught) {
      setEmployeeError(caught instanceof Error ? caught.message : "Employee details could not be loaded.");
    }
  }

  async function saveEmployee(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmployeeSaving(true);
    setEmployeeError(null);
    try {
      const payload = {
        name: employeeForm.name,
        role: employeeForm.role,
        email: employeeForm.email.trim() || null,
        phone: employeeForm.phone.trim() || null,
        status: employeeForm.status,
        hubIds: employeeForm.hubIds,
        ...(!editingEmployeeId ? { employeeId: employeeForm.employeeId.trim(), password: employeeForm.password } : {}),
        ...(editingEmployeeId && employeeForm.password ? { password: employeeForm.password } : {}),
      };
      const response = await authenticatedFetch(
        editingEmployeeId
          ? `/api/company-admin/employees/${encodeURIComponent(editingEmployeeId)}`
          : "/api/company-admin/employees",
        {
          method: editingEmployeeId ? "PATCH" : "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Employee could not be saved.");
      setEmployeeModalOpen(false);
      setEmployeeForm(emptyEmployeeForm());
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setEmployeeError(caught instanceof Error ? caught.message : "Employee could not be saved.");
    } finally {
      setEmployeeSaving(false);
    }
  }

  function exportCsv() {
    const content = [
      config.columns.map((column) => csvCell(column.label)).join(","),
      ...rows.map((row) => config.columns.map((column) => csvCell(display(row[column.key]))).join(",")),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${kind}-page-${page}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="records-page" aria-labelledby="records-title">
      <div className="records-heading">
        <div>
          <span className="chart-eyebrow">{companyName.toUpperCase()} · COMPANY RECORDS</span>
          <h2 id="records-title">{config.title}</h2>
          <p>{config.description}</p>
        </div>
        <div className="records-heading-actions">
          {kind === "employees" && (
            <button className="employee-add-button" onClick={(event) => beginCreateEmployee(event.currentTarget)} type="button">Add employee</button>
          )}
          <button className="snapshot-refresh" disabled={loading} onClick={() => setReloadToken((token) => token + 1)} type="button">
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>
      {kind === "exceptions" && (
        <div className="records-notice">
          This view derives alerts only from recorded status and SLA due dates. No current/live feed, AI-generated prediction, or unrecorded event is implied.
        </div>
      )}
      <div className="records-toolbar">
        <label className="records-search">
          <span>Search this company</span>
          <input onChange={(event) => updateSearch(event.target.value)} placeholder="Search records…" value={search} />
        </label>
        {(kind === "shipments" || kind === "employees" || kind === "hubs") && (
          <label>
            <span>Status filter</span>
            <input onChange={(event) => { setStatus(event.target.value); setPage(1); }} placeholder="Any status" value={status} />
          </label>
        )}
        {(kind === "shipments" || kind === "routes") && (
          <label>
            <span>Mode filter</span>
            <input onChange={(event) => { setMode(event.target.value); setPage(1); }} placeholder="Any mode" value={mode} />
          </label>
        )}
        {(kind === "shipments" || kind === "exceptions") && (
          <>
            <label>
              <span>From booking date</span>
              <input onChange={(event) => { setStartDate(event.target.value); setPage(1); }} type="date" value={startDate} />
            </label>
            <label>
              <span>To booking date</span>
              <input onChange={(event) => { setEndDate(event.target.value); setPage(1); }} type="date" value={endDate} />
            </label>
          </>
        )}
        <label>
          <span>Rows per page</span>
          <select onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} value={pageSize}>
            <option value={10}>10</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option>
          </select>
        </label>
        <button className="table-action-button" disabled={!rows.length} onClick={exportCsv} type="button">Export page CSV</button>
      </div>
      <div className="records-result-count" aria-live="polite">
        {loading ? "Loading company records…" : `${total.toLocaleString()} matching records`}
      </div>
      {error && <div className="dashboard-error" role="alert">{error}</div>}
      {!error && !loading && rows.length === 0 && (
        <div className="records-empty"><strong>No matching records</strong><span>Try changing your search or filters.</span></div>
      )}
      {rows.length > 0 && (
        <div className="table-scroll records-table-wrap">
          <table className="dashboard-table records-table">
            <thead><tr>{config.columns.map((column) => (
              <th key={column.key}>
                <button
                  aria-label={`Sort by ${column.label}`}
                  onClick={() => {
                    setDirection(sortBy === column.key && direction === "asc" ? "desc" : "asc");
                    setSortBy(column.key);
                  }}
                  type="button"
                >
                  {column.label}{sortBy === column.key ? direction === "asc" ? " ↑" : " ↓" : ""}
                </button>
              </th>
            ))}{["shipments", "customers", "hubs", "routes", "employees"].includes(kind) && <th>{kind === "employees" ? "Actions" : "Details"}</th>}</tr></thead>
            <tbody>{rows.map((row, index) => (
              <tr key={String(row.consignmentNo ?? row.customerId ?? row.employeeId ?? row.hubId ?? row.routeId ?? index)}>
                {config.columns.map((column) => <td key={column.key}>{display(row[column.key])}</td>)}
                {kind === "employees" && (
                  <td className="record-row-actions">
                    <button className="table-link-button" onClick={(event) => openRecord(row, event.currentTarget)} type="button">Inspect</button>
                    <button className="table-link-button" onClick={(event) => {
                      const employeeId = row.employeeId;
                      if (typeof employeeId === "string") void beginEditEmployee(employeeId, event.currentTarget);
                    }} type="button">Manage</button>
                  </td>
                )}
                {["shipments", "customers", "hubs", "routes"].includes(kind) && (
                  <td><button className="table-link-button" onClick={(event) => openRecord(row, event.currentTarget)} type="button">Inspect</button></td>
                )}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="records-pagination">
        <span>Page {page} of {Math.max(totalPages, 1)}</span>
        <div>
          <button className="table-action-button" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)} type="button">Previous</button>
          <button className="table-action-button" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)} type="button">Next</button>
        </div>
      </div>
      {selected && (
        createPortal(<div className="control-tower control-modal-portal" style={{ "--tenant-accent": dialogAccent } as CSSProperties}><div className="record-detail-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
        }} role="presentation">
          <div aria-labelledby="record-dialog-title" aria-modal="true" className="record-detail-dialog" onMouseDown={(event) => event.stopPropagation()} ref={dialogRef} role="dialog" style={{ "--dialog-from-x": dialogMotion.x, "--dialog-from-y": dialogMotion.y, "--dialog-from-scale": dialogMotion.scale } as CSSProperties} tabIndex={-1}>
            <header className="record-detail-header">
              <div>
                <span className="chart-eyebrow">{kind === "shipments" ? "RECORDED SHIPMENT" : `COMPANY ${kind.toUpperCase()} RECORD`}</span>
                <h3 id="record-dialog-title">{display(selected.consignmentNo ?? selected.customerName ?? selected.city ?? selected.routeId ?? selected.employeeId)}</h3>
              </div>
              <button className="table-action-button" onClick={() => setSelected(null)} ref={dialogCloseRef} type="button">Close</button>
            </header>
            <div className="record-detail-content">
            {selectedDetailsLoading && <p className="panel-method-note" aria-live="polite">Loading additional company details…</p>}
            {selectedDetailsError && <p className="investigation-error" role="alert">{selectedDetailsError}</p>}
            {selectedDetails && kind === "customers" && (
              <section className="detail-section" aria-label="Customer contact details">
                <h4>Customer details</h4>
                {(["phone", "city", "state", "pincode"] as const).map((key) => (
                  <div className="record-detail-field" key={key}>
                    <span>{{ phone: "Phone", city: "City", state: "State", pincode: "PIN code" }[key]}</span>
                    <strong>{display(selectedDetails[key])}</strong>
                  </div>
                ))}
              </section>
            )}
            {selectedDetails && kind === "hubs" && (
              <section className="detail-section" aria-label="Hub performance details">
                <h4>Recorded performance</h4>
                {([
                  ["shipmentLegs", "Shipment legs"],
                  ["eligibleDelivered", "Eligible delivered"],
                  ["historicallyDelayed", "Historical SLA delays"],
                  ["averageTransitDays", "Average transit days"],
                ] as const).map(([key, label]) => (
                  <div className="record-detail-field" key={key}>
                    <span>{label}</span>
                    <strong>{display(selectedDetails[key])}</strong>
                  </div>
                ))}
                <h4>Assigned active employees</h4>
                {selectedDetailEmployees.length === 0 && <p className="panel-method-note">No active employee assignments are recorded for this hub.</p>}
                {selectedDetailEmployees.map((assignedEmployee) => (
                  <div className="record-detail-field" key={String(assignedEmployee.employeeId)}>
                    <span>{display(assignedEmployee.name)} · {display(assignedEmployee.role)}</span>
                    <strong>{display(assignedEmployee.employeeId)}</strong>
                  </div>
                ))}
              </section>
            )}
            {config.columns.map((column) => (
              <div className="record-detail-field" key={column.key}><span>{column.label}</span><strong>{display(selected[column.key])}</strong></div>
            ))}
            {kind === "shipments" && <h4>Recorded event timeline</h4>}
            {kind === "shipments" && eventsLoading && <p className="panel-method-note">Loading recorded shipment events…</p>}
            {kind === "shipments" && eventsError && <p className="investigation-error" role="alert">{eventsError}</p>}
            {kind === "shipments" && !eventsLoading && !eventsError && shipmentEvents.length === 0 && (
              <p className="panel-method-note">No recorded shipment events are available for this consignment.</p>
            )}
            {kind === "shipments" && shipmentEvents.length > 0 && (
              <ol className="shipment-event-timeline">
                {shipmentEvents.map((event) => (
                  <li key={String(event.eventId)}>
                    <strong>{display(event.eventStatus) !== "—" ? display(event.eventStatus) : display(event.eventType)}</strong>
                    <span>{display(event.hubCity)}{display(event.hubId) !== "—" ? ` · ${display(event.hubId)}` : ""}</span>
                    <time>{display(event.eventTime)}</time>
                  </li>
                ))}
              </ol>
            )}
            {kind !== "shipments" && (
              <>
                <h4>Related shipment history</h4>
                {relatedLoading && <p className="panel-method-note">Loading related shipment records…</p>}
                {relatedError && <p className="investigation-error" role="alert">{relatedError}</p>}
                {!relatedLoading && !relatedError && relatedShipments.length === 0 && (
                  <p className="panel-method-note">No related shipment history is available.</p>
                )}
                {relatedShipments.map((shipment) => (
                  <div className="record-detail-field" key={String(shipment.consignmentNo)}>
                    <span>{display(shipment.consignmentNo)} · {display(shipment.shipmentDate)} · {display(shipment.deliveryStatus)}</span>
                    <button className="table-link-button" onClick={() => {
                      setSelected(null);
                      const id = shipment.consignmentNo;
                      if (typeof id === "string") onInspectShipment(id);
                    }} type="button">Inspect shipment</button>
                  </div>
                ))}
                {relatedShipments.length === 50 && <p className="panel-method-note">Showing at most 50 related shipment records.</p>}
              </>
            )}
            {kind === "shipments" && <button className="table-action-button" onClick={() => {
              const consignmentNo = selected.consignmentNo;
              setSelected(null);
              if (typeof consignmentNo === "string") onInspectShipment(consignmentNo);
            }} type="button">Open dashboard investigation</button>}
            </div>
          </div>
        </div></div>, document.body)
      )}
      {employeeError && !employeeModalOpen && <p className="investigation-error" role="alert">{employeeError}</p>}
      {employeeModalOpen && (
        createPortal(<div className="control-tower control-modal-portal" style={{ "--tenant-accent": dialogAccent } as CSSProperties}><div className="record-detail-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setEmployeeModalOpen(false);
        }} role="presentation">
          <div aria-labelledby="employee-dialog-title" aria-modal="true" className="record-detail-dialog employee-dialog" onMouseDown={(event) => event.stopPropagation()} ref={dialogRef} role="dialog" style={{ "--dialog-from-x": dialogMotion.x, "--dialog-from-y": dialogMotion.y, "--dialog-from-scale": dialogMotion.scale } as CSSProperties} tabIndex={-1}>
            <header className="record-detail-header">
              <div>
                <span className="chart-eyebrow">COMPANY EMPLOYEE</span>
                <h3 id="employee-dialog-title">{editingEmployeeId ? "Manage employee" : "Add employee"}</h3>
              </div>
              <button className="table-action-button" onClick={() => setEmployeeModalOpen(false)} ref={dialogCloseRef} type="button">Close</button>
            </header>
            <form className="employee-form record-detail-content" onSubmit={saveEmployee}>
              <label>
                <span>Employee ID</span>
                <input autoComplete="off" disabled={Boolean(editingEmployeeId)} maxLength={30} onChange={(event) => setEmployeeForm((form) => ({ ...form, employeeId: event.target.value }))} required value={editingEmployeeId ?? employeeForm.employeeId} />
              </label>
              <label>
                <span>Full name</span>
                <input autoComplete="name" maxLength={150} onChange={(event) => setEmployeeForm((form) => ({ ...form, name: event.target.value }))} required value={employeeForm.name} />
              </label>
              <label>
                <span>Role</span>
                <select onChange={(event) => setEmployeeForm((form) => ({ ...form, role: event.target.value as EmployeeRole }))} value={employeeForm.role}>
                  {Object.entries(employeeRoleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
                </select>
              </label>
              <label>
                <span>Email (optional)</span>
                <input autoComplete="email" maxLength={150} onChange={(event) => setEmployeeForm((form) => ({ ...form, email: event.target.value }))} type="email" value={employeeForm.email} />
              </label>
              <label>
                <span>Phone (optional)</span>
                <input autoComplete="tel" maxLength={20} onChange={(event) => setEmployeeForm((form) => ({ ...form, phone: event.target.value }))} value={employeeForm.phone} />
              </label>
              {!editingEmployeeId ? (
                <label>
                  <span>Temporary password (minimum 12 characters)</span>
                  <input autoComplete="new-password" minLength={12} onChange={(event) => setEmployeeForm((form) => ({ ...form, password: event.target.value }))} required type="password" value={employeeForm.password} />
                </label>
              ) : (
                <label>
                  <span>Reset password (optional, minimum 12 characters)</span>
                  <input autoComplete="new-password" minLength={12} onChange={(event) => setEmployeeForm((form) => ({ ...form, password: event.target.value }))} type="password" value={employeeForm.password} />
                </label>
              )}
              <label>
                <span>Account status</span>
                <select onChange={(event) => setEmployeeForm((form) => ({ ...form, status: event.target.value as EmployeeForm["status"] }))} value={employeeForm.status}>
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </label>
              <fieldset className="employee-hub-choices">
                <legend>Active hub assignments</legend>
                {hubOptionsError && <p className="investigation-error" role="alert">{hubOptionsError}</p>}
                {hubOptions.map((hub) => (
                  <label key={hub.hubId}>
                    <input checked={employeeForm.hubIds.includes(hub.hubId)} onChange={(event) => setEmployeeForm((form) => ({
                      ...form,
                      hubIds: event.target.checked
                        ? [...form.hubIds, hub.hubId]
                        : form.hubIds.filter((id) => id !== hub.hubId),
                    }))} type="checkbox" />
                    <span>{hub.city} · {hub.hubId}</span>
                  </label>
                ))}
                {hubOptions.length === 0 && !hubOptionsError && <p className="panel-method-note">No active company hubs are available.</p>}
              </fieldset>
              {employeeError && <p className="investigation-error" role="alert">{employeeError}</p>}
              <div className="employee-form-actions">
                <button className="table-action-button" disabled={employeeSaving} onClick={() => setEmployeeModalOpen(false)} type="button">Cancel</button>
                <button className="employee-add-button" disabled={employeeSaving || Boolean(hubOptionsError)} type="submit">{employeeSaving ? "Saving…" : "Save employee"}</button>
              </div>
              <p className="panel-method-note">Company assignment is fixed to your authenticated company. Deactivation preserves employee and shipment history.</p>
            </form>
          </div>
        </div></div>, document.body)
      )}
    </section>
  );
}
