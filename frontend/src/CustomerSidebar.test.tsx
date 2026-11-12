import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerSidebar } from "./CustomerSidebar";

test("customer navigation contains customer-only destinations and no staff routes", () => {
  const markup = renderToStaticMarkup(createElement(CustomerSidebar, { open: true, onNavigate: () => undefined }));
  for (const target of ["customer-home", "customer-booking", "customer-shipments", "customer-track", "customer-payments", "customer-profile", "customer-support"]) {
    assert.match(markup, new RegExp(`href=\\"#${target}\\"`));
  }
  assert.match(markup, /customer-sidebar-open/);
  assert.doesNotMatch(markup, /company-admin|operations|hub-manager|logistics-executive/);
});
