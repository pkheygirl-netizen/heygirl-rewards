// Customers export (Settings → Data export). Honours the same filters as the
// Customers list when they are passed in the query string.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { fmtDate } from "../components/karachi";
import { parseCustomerFilters, searchCustomers, type CustomerRow } from "../lib/admin-members.server";
import { csvResponse, toCsv } from "../lib/csv.server";

const PAGE = 1000;
const MAX_ROWS = 200000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const filters = parseCustomerFilters(new URL(request.url).searchParams);
  const all: CustomerRow[] = [];
  // Stops on an empty page, never on a short one: a short page can be a server
  // row cap rather than the end of the list. The next request starts after the
  // rows that actually came back, so a capped page loses nothing.
  while (all.length < MAX_ROWS) {
    const { customers } = await searchCustomers(filters, PAGE, all.length);
    if (customers.length === 0) break;
    all.push(...customers);
  }
  const out = all.map((c) => ({
    name: c.name, email: c.email ?? "", phone: c.phone ?? "", tier: c.tier,
    points: c.pointsBalance, spend: c.lifetimeSpendPkr, joined: fmtDate(c.enrolledAt),
    blocked: c.isBlocked, optedOut: c.optedOut, influencer: c.isInfluencer,
  }));
  return csvResponse("customers.csv", toCsv(out, [
    { key: "name", header: "Customer" },
    { key: "email", header: "Email" },
    { key: "phone", header: "Phone" },
    { key: "tier", header: "Tier" },
    { key: "points", header: "Points balance" },
    { key: "spend", header: "Lifetime spend (Rs)" },
    { key: "joined", header: "Joined" },
    { key: "blocked", header: "Blocked" },
    { key: "optedOut", header: "Opted out" },
    { key: "influencer", header: "Influencer" },
  ] as const));
};
