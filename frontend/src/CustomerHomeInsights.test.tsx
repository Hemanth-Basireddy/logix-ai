import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CustomerBookingInvitation, CustomerHomeInsights, type CustomerHomeSummary } from "./CustomerHomeInsights";

const empty: CustomerHomeSummary = {
  companyNetwork: {
    totalShipments: 0, deliveredShipments: 0, activeShipments: 0, customersServed: 0,
    statesCovered: 0, hubsCovered: 0, monthlyShipmentActivity: [], destinationSummary: [], routeSummary: [],
  },
  personal: { totalShipments: 0, deliveredShipments: 0, activeShipments: 0, pendingApproval: 0 },
};

test("customer homepage stays concise and links to dedicated customer destinations", () => {
  const summary: CustomerHomeSummary = {
    ...empty,
    companyNetwork: {
      totalShipments: 49629, deliveredShipments: 32100, activeShipments: 500,
      customersServed: 42000, statesCovered: 26, hubsCovered: 35,
      monthlyShipmentActivity: [{ month: "2026-09", shipments: 1850 }],
      destinationSummary: [{ destination: "Maharashtra", shipments: 1284, delivered: 1190, active: 12, hubs: [{ hubId: "H2", city: "Mumbai", shipments: 1284 }] }],
      routeSummary: [{ origin: "Telangana", destination: "Maharashtra", shipments: 1284, delivered: 1190, active: 12 }],
    },
  };
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CustomerHomeInsights, { summary, onBook: () => undefined, onTrack: () => undefined })));
  assert.match(markup, /Every delivery/);
  assert.match(markup, /Book shipment/);
  assert.match(markup, /Track a shipment/);
  assert.match(markup, /49,629/);
  assert.match(markup, /India Network/);
  assert.match(markup, /Analytics/);
  assert.match(markup, /Shipment Journey/);
  assert.match(markup, /Your Shipments/);
  assert.match(markup, /href="\/customer\/network"/);
  assert.match(markup, /href="\/customer\/analytics"/);
  assert.match(markup, /href="\/customer\/journey"/);
  assert.match(markup, /href="\/customer\/shipments"/);
  assert.doesNotMatch(markup, /India destination shipment map|MONTHLY SHIPMENT ACTIVITY|RECEIVED_AT_ORIGIN_HUB/);
  assert.doesNotMatch(markup, /customer-network-stats|customer-network-orbit|50,000\+|99\.9%/i);
});

test("empty company data displays actual zero-valued highlights without invented claims", () => {
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CustomerHomeInsights, { summary: empty, onBook: () => undefined, onTrack: () => undefined })));
  assert.match(markup, /0/);
  assert.doesNotMatch(markup, /50,000\+|99\.9%|live vehicle locations/i);
});

test("booking invitation is a clear final conversion action", () => {
  const markup = renderToStaticMarkup(createElement(CustomerBookingInvitation, { onBook: () => undefined }));
  assert.match(markup, /Move the next one/);
  assert.match(markup, /Book shipment now/);
});
