import { useState } from "react";
import { Link } from "react-router-dom";

export function CustomerEntryPage() {
  const [message, setMessage] = useState("");

  return (
    <main className="customer-entry-page">
      <header className="customer-entry-header">
        <Link className="platform-brand" to="/" aria-label="Logix AI home">
          <span className="platform-mark" aria-hidden="true"><span /></span>
          <span>LOGIX<span className="brand-ai"> AI</span></span>
        </Link>
        <span className="customer-entry-caption">COURIER NETWORK</span>
      </header>

      <section className="customer-entry-content" aria-labelledby="customer-entry-title">
        <span className="eyebrow">YOUR SHIPMENT, IN MOTION</span>
        <h1 id="customer-entry-title">Choose your courier</h1>
        <p className="customer-entry-intro">Book and follow your delivery from one clear view.</p>

        <div className="courier-card-grid">
          <Link className="courier-card courier-card-available" to="/customer/login" aria-label="DTDC — Available now">
            <span className="courier-card-mark dtdc-mark" aria-hidden="true">D</span>
            <span className="courier-card-copy">
              <strong>DTDC</strong>
              <span>Book a shipment and follow its progress.</span>
            </span>
            <span className="courier-availability"><i />Available now</span>
            <span className="courier-card-arrow" aria-hidden="true">→</span>
          </Link>

          <button className="courier-card courier-card-coming" onClick={() => setMessage("Coming Soon! Delhivery will be available soon on Logix AI. Stay tuned!")} type="button">
            <span className="courier-card-mark delhivery-mark" aria-hidden="true">D</span>
            <span className="courier-card-copy">
              <strong>Delhivery</strong>
              <span>Another delivery network is on its way.</span>
            </span>
            <span className="courier-availability coming-soon">Coming soon</span>
            <span className="courier-card-arrow" aria-hidden="true">↗</span>
          </button>
        </div>

        {message && <p className="courier-coming-message" role="status">{message}</p>}
      </section>

      <Link className="employee-entry-link" to="/login">Employee Login <span aria-hidden="true">↗</span></Link>
      <footer className="customer-entry-footer">LOGISTICS, CONNECTED <span /> SECURE SHIPMENT TRACKING</footer>
    </main>
  );
}
