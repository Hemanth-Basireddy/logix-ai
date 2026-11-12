import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type PropsWithChildren,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { destinationForRole, requestedPathForRole } from "./role-routing";
import type { Employee } from "./types";

type AuthContextValue = {
  employee: Employee | null;
  ready: boolean;
  error: string | null;
  signIn: (employeeId: string, password: string) => Promise<Employee>;
  signOut: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

type ApiResponse<T> = T & { error?: string };

async function readResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as ApiResponse<T>;
  if (!response.ok) {
    throw new Error(payload.error ?? "The request could not be completed.");
  }
  return payload;
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    window.dispatchEvent(new Event("logix-session-expired"));
  }
  return response;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const location = useLocation();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const expireSession = () => {
      setEmployee(null);
      setError("Your session has expired. Please sign in again.");
    };
    window.addEventListener("logix-session-expired", expireSession);
    return () => window.removeEventListener("logix-session-expired", expireSession);
  }, []);

  useEffect(() => {
    if (location.pathname.startsWith("/customer")) {
      setEmployee(null);
      setReady(true);
      return;
    }
    let active = true;
    setReady(false);
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then(async (response) => {
        if (response.status === 401) return null;
        const result = await readResponse<{ employee: Employee }>(response);
        return result.employee;
      })
      .then((currentEmployee) => {
        if (active) setEmployee(currentEmployee);
      })
      .catch(() => {
        if (active) setError("Unable to connect to the sign-in service. Please try again.");
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [location.pathname]);

  const signIn = useCallback(async (employeeId: string, password: string) => {
    setError(null);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId, password }),
    });
    const result = await readResponse<{ employee: Employee }>(response);
    setEmployee(result.employee);
    return result.employee;
  }, []);

  const signOut = useCallback(async () => {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error("Unable to sign out. Please try again.");
    }
    setEmployee(null);
  }, []);

  const value = useMemo(
    () => ({
      employee,
      ready,
      error,
      signIn,
      signOut,
      clearError: () => setError(null),
    }),
    [employee, ready, error, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}

export function LoginForm() {
  const { signIn, error: serviceError, clearError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [employeeId, setEmployeeId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    clearError();
    try {
      const employee = await signIn(employeeId.trim(), password);
      const destination = destinationForRole(employee.role);
      const requested = (location.state as { from?: string } | null)?.from;
      navigate(requestedPathForRole(employee.role, requested) ?? destination, { replace: true });
    } catch (caught) {
      setFormError(
        caught instanceof Error ? caught.message : "Unable to sign in. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <div className="form-heading">
        <span className="eyebrow">EMPLOYEE ACCESS</span>
        <h2>Welcome back</h2>
        <p>Sign in with your company-issued credentials.</p>
      </div>
      <label htmlFor="employee-id">Employee ID</label>
      <input
        autoComplete="username"
        id="employee-id"
        maxLength={30}
        onChange={(event) => setEmployeeId(event.target.value)}
        placeholder="Enter your Employee ID"
        required
        value={employeeId}
      />
      <label htmlFor="employee-password">Password</label>
      <div className="password-input-wrap">
        <input
          autoComplete="current-password"
          id="employee-password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Enter your password"
          required
          type={showPassword ? "text" : "password"}
          value={password}
        />
        <button
          aria-label={showPassword ? "Hide password" : "Show password"}
          aria-pressed={showPassword}
          className="password-visibility-button"
          onClick={() => setShowPassword((visible) => !visible)}
          type="button"
        >
          {showPassword ? (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8" />
              <path d="M9.9 5.2A10.8 10.8 0 0112 5c5 0 8.5 4.5 9.5 6.5a1.1 1.1 0 010 1 13 13 0 01-3.1 3.8M6.2 6.2a13 13 0 00-3.7 5.3 1.1 1.1 0 000 1C3.5 14.5 7 19 12 19a10.6 10.6 0 004-.8" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
          )}
        </button>
      </div>
      {(formError || serviceError) && (
        <p className="form-error" role="alert">
          {formError ?? serviceError}
        </p>
      )}
      <button className="primary-button" disabled={submitting} type="submit">
        {submitting ? "Signing in…" : "Sign in"}
        {!submitting && <span aria-hidden="true">→</span>}
      </button>
      <p className="secure-note">
        <span aria-hidden="true">●</span> Secure employee access
      </p>
    </form>
  );
}
