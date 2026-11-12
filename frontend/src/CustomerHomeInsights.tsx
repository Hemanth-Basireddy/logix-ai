import { Link } from "react-router-dom";
import { useState } from "react";
import type { CustomerDashboardSummary } from "./customer-summary";

export type CustomerHomeSummary = {
  companyNetwork: CustomerDashboardSummary<unknown>["companyNetwork"];
  personal: { totalShipments: number; deliveredShipments: number; activeShipments: number; pendingApproval: number };
};
export type CustomerHub = { hubId: string; city: string };

const number = (value: number) => value.toLocaleString("en-IN");

export function CustomerHomeInsights({ summary, hubs, onTrack }: {
  summary: CustomerHomeSummary;
  hubs?: CustomerHub[];
  onBook?: () => void;
  onTrack: (consignmentNo: string) => void;
}) {
  const network = summary.companyNetwork;
  const [trackingNumber, setTrackingNumber] = useState("");
  const cards = [
    { to: "/customer/network", number: "01", title: "India Network", text: "Explore the recorded network, hubs and connected routes.", icon: "⌖" },
    { to: "/customer/analytics", number: "02", title: "Analytics", text: "See shipment activity and network patterns from company data.", icon: "↗" },
    { to: "/customer/journey", number: "03", title: "Shipment Journey", text: "Understand each recorded handoff from booking to delivery.", icon: "⇢" },
    { to: "/customer/shipments", number: "04", title: "Your Shipments", text: "Review your shipment history, tracking, labels and bookings.", icon: "▤" },
  ];

  return <div className="customer-home-compact">
    <section className="customer-hero customer-editorial-hero customer-cinematic-hero" aria-labelledby="customer-home-title">
      <div className="customer-hero-copy">
        <span className="customer-kicker">LOGIX AI · INDIA IN MOTION</span>
        <h1 id="customer-home-title">Every delivery<br/><em>moves us forward.</em></h1>
        <p>Book a shipment and follow the logistics milestones recorded for your parcel.</p>
        <form className="customer-hero-track-form" onSubmit={(event) => { event.preventDefault(); if (trackingNumber.trim()) onTrack(trackingNumber.trim()); }}>
          <label htmlFor="customer-hero-track">Track a shipment</label>
          <div><input id="customer-hero-track" value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} placeholder="Enter consignment number" autoComplete="off"/><button type="submit" disabled={!trackingNumber.trim()}>Track <span aria-hidden="true">→</span></button></div>
        </form>
        <div className="customer-hero-actions"><Link className="customer-hero-cta" to="/customer/shipments#customer-booking">Book shipment <span aria-hidden="true">→</span></Link><Link className="customer-hero-explore" to="/customer/network">Explore network <span aria-hidden="true">↗</span></Link></div>
      </div>
      <aside className="customer-home-network-highlights" aria-label="Company network highlights">
        <span className="customer-kicker">THE NETWORK, IN BRIEF</span>
        <div><strong>{number(network.totalShipments)}</strong><span>shipment records</span></div>
        <div><strong>{number(network.statesCovered)}</strong><span>recorded states</span></div>
        <div><strong>{number(hubs?.length || network.hubsCovered)}</strong><span>hub records</span></div>
        <small>Tenant network data · not live vehicle locations</small>
      </aside>
    </section>
    <section className="customer-home-destinations" aria-label="Customer portal pages">
      <div className="customer-home-destinations-heading"><span className="customer-kicker">YOUR LOGIX AI</span><h2>Where would you like to go?</h2></div>
      <div className="customer-home-destination-grid">{cards.map((card) => <Link className="customer-home-destination-card" key={card.to} to={card.to}><span className="customer-home-card-number">{card.number}</span><i aria-hidden="true">{card.icon}</i><h3>{card.title}</h3><p>{card.text}</p><span className="customer-home-card-link">Open page <b aria-hidden="true">↗</b></span></Link>)}</div>
    </section>
  </div>;
}

export function CustomerBookingInvitation({ onBook }: { onBook: () => void }) {
  return <section className="customer-booking-invitation"><div><span className="customer-kicker">READY WHEN YOU ARE</span><h2>Move the next one.</h2><p>Create a booking and follow every recorded handoff from your account.</p></div><button type="button" onClick={onBook}>Book shipment now <span aria-hidden="true">→</span></button></section>;
}
