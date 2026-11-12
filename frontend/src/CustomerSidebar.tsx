export function CustomerSidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  return <aside className={`customer-sidebar${open ? " customer-sidebar-open" : ""}`}>
    <span className="customer-sidebar-label">YOUR SPACE</span>
    <nav aria-label="Customer navigation">
      <a href="#customer-home" onClick={onNavigate} className="customer-nav-link customer-nav-current"><span aria-hidden="true">⌂</span>Home</a>
      <a href="#customer-booking" onClick={onNavigate} className="customer-nav-link"><span aria-hidden="true">＋</span>Book shipment</a>
      <a href="#customer-shipments" onClick={onNavigate} className="customer-nav-link"><span aria-hidden="true">▤</span>Your shipments</a>
      <a href="#customer-track" onClick={onNavigate} className="customer-nav-link"><span aria-hidden="true">⌕</span>Track shipment</a>
      <a href="#customer-payments" onClick={onNavigate} className="customer-nav-link"><span aria-hidden="true">◇</span>Payments</a>
      <a href="#customer-profile" onClick={onNavigate} className="customer-nav-link"><span aria-hidden="true">◉</span>Profile</a>
      <a href="#customer-support" onClick={onNavigate} className="customer-nav-link"><span aria-hidden="true">?</span>Help &amp; support</a>
    </nav>
    <div className="customer-sidebar-help"><span>Need a hand?</span><p>Your booking and tracking updates are recorded here as the team processes your shipment.</p><a href="#customer-support" onClick={onNavigate}>Visit help <span aria-hidden="true">→</span></a></div>
  </aside>;
}
