// The admin's sections, in the order they appear in Shopify's app navigation.
// Kept out of app/routes/app.tsx because a route file may export only Remix's
// own route exports (loader, action, default, ErrorBoundary, headers, ...):
// any other export is kept in the browser bundle and can drag server code in.
// Home is not listed: it is the link marked rel="home", which Shopify hides.
export const NAV_ITEMS = [
  { label: "Customers", path: "/app/customers" },
  { label: "Program", path: "/app/program" },
  { label: "Referrals", path: "/app/referrals" },
  { label: "Influencers", path: "/app/influencers" },
  { label: "Campaigns", path: "/app/campaigns" },
  { label: "Analytics", path: "/app/analytics" },
  { label: "On-site", path: "/app/onsite" },
  { label: "Settings", path: "/app/settings" },
  { label: "Import", path: "/app/import" },
] as const;

export const HOME_PATH = "/app";
