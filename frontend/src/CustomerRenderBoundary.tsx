import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; scope: "route" | "visualization" };
type State = { error: Error | null };

export class CustomerRenderBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Customer ${this.props.scope} render failure]`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    if (this.props.scope === "visualization") {
      return <section className="customer-render-fallback customer-visualization-fallback" role="status">
        <span className="customer-kicker">NETWORK VISUALIZATION</span>
        <h2>The network view is temporarily unavailable.</h2>
        <p>Your customer account, shipment history, tracking and booking remain available.</p>
      </section>;
    }

    return <main className="customer-route-fallback" role="alert">
      <div>
        <a className="platform-brand" href="/customer/login">LOGIX<span className="brand-ai"> AI</span></a>
        <span className="customer-kicker">CUSTOMER PORTAL</span>
        <h1>We couldn’t open your customer page.</h1>
        <p>The page reported an error while rendering. You can retry or return to customer sign in.</p>
        <button type="button" onClick={() => window.location.reload()}>Try again</button>
        <a href="/customer/login">Go to customer sign in</a>
      </div>
    </main>;
  }
}
