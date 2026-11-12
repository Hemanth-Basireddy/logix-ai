import { lazy, Suspense, useEffect, useState } from "react";
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { CompanyBrand } from "./branding";
import { authenticatedFetch, LoginForm, useAuth } from "./auth";
import { destinationForRole } from "./role-routing";
import type { EmployeeRole } from "./types";
import { CustomerEntryPage } from "./CustomerEntryPage";
import { CustomerRenderBoundary } from "./CustomerRenderBoundary";

const CompanyAdminDashboard = lazy(() => import("./CompanyAdminDashboard").then((module) => ({ default: module.CompanyAdminDashboard })));
const OperationsDashboard = lazy(() => import("./OperationsDashboard").then((module) => ({ default: module.OperationsDashboard })));
const HubManagerDashboard = lazy(() => import("./HubManagerDashboard").then((module) => ({ default: module.HubManagerDashboard })));
const LogisticsExecutiveDashboard = lazy(() => import("./LogisticsExecutiveDashboard").then((module) => ({ default: module.LogisticsExecutiveDashboard })));
const CustomerPortal = lazy(() => import("./CustomerPortal").then((module) => ({ default: module.CustomerPortal })));

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-live="polite">
      <span className="loading-orbit" aria-hidden="true" />
      <p>Connecting to your workspace</p>
    </main>
  );
}

function RequireEmployee() {
  const { employee, ready } = useAuth();
  const location = useLocation();

  if (!ready) return <LoadingScreen />;
  if (!employee) return <Navigate replace state={{ from: location.pathname }} to="/login" />;
  return <Outlet />;
}

function LoginPage() {
  const { employee, ready } = useAuth();
  if (!ready) return <LoadingScreen />;
  if (employee) {
    return <Navigate replace to={destinationForRole(employee.role)} />;
  }

  return (
    <main className="login-page">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="login-shell">
        <section className="brand-story" aria-label="Logix AI">
          <a className="platform-brand" href="/login" aria-label="Logix AI home">
            <span className="platform-mark" aria-hidden="true">
              <span />
            </span>
            <span>LOGIX<span className="brand-ai"> AI</span></span>
          </a>
          <div className="story-copy">
            <span className="eyebrow">INTELLIGENCE IN MOTION</span>
            <h1>Every move.<br />In control.</h1>
            <p>
              One connected view of your logistics operations, teams, and the
              decisions that keep business moving.
            </p>
          </div>
          <div className="story-footer">
            <span className="status-indicator" />
            <span>CONTROL TOWER PLATFORM</span>
            <span className="story-divider" />
            <span>BUILT FOR WHAT&apos;S NEXT</span>
          </div>
        </section>
        <section className="login-panel" aria-label="Employee sign in">
          <div className="panel-topline">
            <span className="panel-dot" />
            <span>EMPLOYEE PORTAL</span>
          </div>
          <LoginForm />
          <p className="login-footnote">
            Need access? Contact your company administrator.
            <br /><a href="/customer/login">Customer? Book and track a shipment</a>
          </p>
        </section>
      </div>
      <footer className="page-footer">
        <span>© {new Date().getFullYear()} Logix AI</span>
        <span>Operations, connected.</span>
      </footer>
    </main>
  );
}

const roleNames: Record<EmployeeRole, string> = {
  COMPANY_ADMIN: "Company Admin",
  OPERATIONS_MANAGER: "Operations Manager",
  HUB_MANAGER: "Hub Manager",
  LOGISTICS_EXECUTIVE: "Logistics Executive",
};

function WorkspaceLayout() {
  const { employee, signOut } = useAuth();
  const navigate = useNavigate();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  if (!employee) return <Navigate replace to="/login" />;
  if (employee.role === "COMPANY_ADMIN") return <Outlet />;

  async function handleSignOut() {
    setSignOutError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (error) {
      setSignOutError(
        error instanceof Error ? error.message : "Unable to sign out. Please try again.",
      );
    }
  }

  return (
    <div className="workspace">
      <header className="workspace-header">
        <a className="workspace-platform" href="/" aria-label="Logix AI">
          <span className="platform-mark platform-mark-small" aria-hidden="true">
            <span />
          </span>
          <span>LOGIX<span className="brand-ai"> AI</span></span>
        </a>
        <div className="workspace-header-right">
          <CompanyBrand employee={employee} />
          <span className="header-separator" />
          <div className="employee-chip">
            <span className="avatar">{employee.name.slice(0, 1).toUpperCase()}</span>
            <span className="employee-greeting">
              <strong>{employee.name}</strong>
              <small>{roleNames[employee.role]}</small>
            </span>
          </div>
          <button className="signout-button" onClick={handleSignOut} type="button">
            Sign out
          </button>
        </div>
      </header>
      {signOutError && <p className="workspace-alert" role="alert">{signOutError}</p>}
      <main className={employee.role === "OPERATIONS_MANAGER" || employee.role === "HUB_MANAGER" || employee.role === "LOGISTICS_EXECUTIVE" ? "workspace-main operations-workspace-main" : "workspace-main"}>
        <Outlet />
      </main>
    </div>
  );
}

type HubShipment = {
  consignmentNo: string;
  shipmentDate: string;
  status: string;
  origin: string;
  destination: string;
  mode: string;
};

function AssignedHubShipmentRecords({
  role,
  hubId,
  city,
}: {
  role: Exclude<EmployeeRole, "COMPANY_ADMIN">;
  hubId: string;
  city: string;
}) {
  const [shipments, setShipments] = useState<HubShipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const rolePath = {
      OPERATIONS_MANAGER: "operations",
      HUB_MANAGER: "hub-manager",
      LOGISTICS_EXECUTIVE: "logistics-executive",
    }[role];
    authenticatedFetch(`/api/${rolePath}/hubs/${encodeURIComponent(hubId)}/shipments`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as { shipments?: HubShipment[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Hub shipment records could not be loaded.");
        return payload.shipments ?? [];
      })
      .then(setShipments)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Hub shipment records could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [role, hubId]);

  return (
    <section aria-label={`${city} shipment records`} className="assigned-hub-data">
      <div className="assigned-hub-data-heading">
        <strong>{city}</strong>
        <span>{loading ? "Loading…" : `${shipments.length}${shipments.length === 100 ? "+" : ""} shipments`}</span>
      </div>
      {error && <p className="assigned-hub-data-error" role="alert">{error}</p>}
      {!loading && !error && shipments.length === 0 && (
        <p className="assigned-hub-data-empty">No shipment records are available for this hub.</p>
      )}
      {!loading && !error && shipments.length > 0 && (
        <div className="assigned-hub-table-wrap">
          <table className="assigned-hub-table">
            <thead><tr><th>Consignment</th><th>Route</th><th>Status</th><th>Booked</th></tr></thead>
            <tbody>
              {shipments.slice(0, 10).map((shipment) => (
                <tr key={shipment.consignmentNo}>
                  <td>{shipment.consignmentNo}</td>
                  <td>{shipment.origin} → {shipment.destination}</td>
                  <td>{shipment.status}</td>
                  <td>{shipment.shipmentDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shipments.length > 10 && <p className="assigned-hub-data-empty">Showing 10 of the latest {shipments.length}{shipments.length === 100 ? "+" : ""} records.</p>}
        </div>
      )}
    </section>
  );
}

function PlaceholderDashboard({ role }: { role: Exclude<EmployeeRole, "COMPANY_ADMIN"> }) {
  const { employee } = useAuth();
  if (!employee) return null;
  return (
    <section className="placeholder-panel">
      <span className="eyebrow">{roleNames[role].toUpperCase()} WORKSPACE</span>
      <div className="placeholder-icon" aria-hidden="true">✦</div>
      <h1>{roleNames[role]} dashboard</h1>
      <p>
        This workspace is reserved for {employee.company.name}. Its operational
        tools will be added in a later implementation phase.
      </p>
      {employee.assignedHubs.length > 0 && (
        <div className="assigned-hub-list">
          <span className="eyebrow">YOUR ASSIGNED HUBS</span>
          <div className="assigned-hub-data-grid">
            {employee.assignedHubs.map((hub) => (
              <div className="assigned-hub-card" key={hub.id}>
                <div className="assigned-hub">
                  <span className="hub-pulse" />
                  <strong>{hub.city}</strong>
                  <small>{hub.id}</small>
                </div>
                <AssignedHubShipmentRecords city={hub.city} hubId={hub.id} role={role} />
              </div>
            ))}
          </div>
        </div>
      )}
      {employee.assignedHubs.length === 0 && (
        <p className="workspace-alert" role="status">
          No active hubs are assigned to your account. Operational data is unavailable until your Company Admin assigns a hub.
        </p>
      )}
    </section>
  );
}

function RoleRoute({ role }: { role: EmployeeRole }) {
  const { employee } = useAuth();
  if (!employee) return <Navigate replace to="/login" />;
  if (employee.role !== role) {
    return <Navigate replace to={destinationForRole(employee.role)} />;
  }
  return role === "COMPANY_ADMIN" ? (
    <CompanyAdminDashboard />
  ) : role === "OPERATIONS_MANAGER" ? (
    <OperationsDashboard />
  ) : role === "HUB_MANAGER" ? (
    <HubManagerDashboard />
  ) : role === "LOGISTICS_EXECUTIVE" ? (
    <LogisticsExecutiveDashboard />
  ) : (
    <PlaceholderDashboard role={role} />
  );
}

export function App() {
  const { ready } = useAuth();
  if (!ready) return <LoadingScreen />;

  return (
    <Suspense fallback={<LoadingScreen />}><Routes>
      <Route element={<CustomerEntryPage />} path="/" />
      <Route element={<CustomerRenderBoundary scope="route"><CustomerPortal /></CustomerRenderBoundary>} path="/customer" />
      <Route element={<CustomerRenderBoundary scope="route"><CustomerPortal /></CustomerRenderBoundary>} path="/customer/:section" />
      <Route element={<CustomerRenderBoundary scope="route"><CustomerPortal /></CustomerRenderBoundary>} path="/customer/login" />
      <Route element={<CustomerRenderBoundary scope="route"><CustomerPortal /></CustomerRenderBoundary>} path="/customer/register" />
      <Route element={<LoginPage />} path="/login" />
      <Route element={<RequireEmployee />}>
        <Route element={<WorkspaceLayout />}>
          <Route element={<RoleRoute role="COMPANY_ADMIN" />} path="/company-admin" />
          <Route element={<RoleRoute role="COMPANY_ADMIN" />} path="/company-admin/:section" />
          <Route element={<RoleRoute role="OPERATIONS_MANAGER" />} path="/operations" />
          <Route element={<RoleRoute role="HUB_MANAGER" />} path="/hub-manager" />
          <Route
            element={<RoleRoute role="LOGISTICS_EXECUTIVE" />}
            path="/logistics-executive"
          />
        </Route>
      </Route>
      <Route path="*" element={<Navigate replace to="/login" />} />
    </Routes></Suspense>
  );
}
