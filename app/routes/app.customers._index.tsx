// app/routes/app.customers._index.tsx — Customers list
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Badge, BlockStack, Box, Button, Card, IndexTable, InlineStack, Layout, Link, Page, Select, Text, TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { EmptyBlock, Pager, TierBadge, useDebouncedParam } from "../components/admin-ui";
import { fmtDate, fmtInt, fmtPkr } from "../components/karachi";
import { parseCustomerFilters, searchCustomers } from "../lib/admin-members.server";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const filters = parseCustomerFilters(new URL(request.url).searchParams);
  const { customers, total } = await searchCustomers(filters, PAGE_SIZE);
  return json({ customers, total, filters });
};

const YES_NO = (any: string, yes: string, no: string) => [
  { label: any, value: "" }, { label: yes, value: "yes" }, { label: no, value: "no" },
];

export default function Customers() {
  const { customers, total, filters } = useLoaderData<typeof loader>();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useDebouncedParam("q");

  const setParam = (name: string, value: string) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete("page");
    setSp(next, { preventScrollReset: true });
  };
  const filtered =
    Boolean(filters.query) || filters.tier !== null || filters.hasPoints !== null ||
    filters.blocked !== null || filters.optedOut !== null || filters.influencer !== null;
  const tri = (v: boolean | null) => (v === null ? "" : v ? "yes" : "no");

  return (
    <Page title="Customers" subtitle={`${fmtInt(total)} ${filtered ? "matching" : "in the program"}`}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <TextField
                label="Search" labelHidden autoComplete="off" clearButton
                placeholder="Search by name, email or phone"
                value={query} onChange={setQuery} onClearButtonClick={() => setQuery("")}
              />
              <InlineStack gap="300" wrap>
                <Select label="Tier" labelInline value={filters.tier ?? ""} onChange={(v) => setParam("tier", v)}
                  options={[{ label: "All", value: "" }, { label: "Silver", value: "silver" }, { label: "Gold", value: "gold" }, { label: "Diamond", value: "diamond" }]} />
                <Select label="Points" labelInline value={tri(filters.hasPoints)} onChange={(v) => setParam("points", v)}
                  options={YES_NO("Any", "Has points", "No points")} />
                <Select label="Blocked" labelInline value={tri(filters.blocked)} onChange={(v) => setParam("blocked", v)}
                  options={YES_NO("Any", "Blocked", "Not blocked")} />
                <Select label="Opted out" labelInline value={tri(filters.optedOut)} onChange={(v) => setParam("optedout", v)}
                  options={YES_NO("Any", "Opted out", "Taking part")} />
                <Select label="Influencer" labelInline value={tri(filters.influencer)} onChange={(v) => setParam("influencer", v)}
                  options={YES_NO("Any", "Influencers", "Not influencers")} />
                <Select label="Sort" labelInline value={`${filters.sort}:${filters.desc ? "desc" : "asc"}`}
                  onChange={(v) => {
                    const [sort, dir] = v.split(":");
                    const next = new URLSearchParams(sp);
                    next.set("sort", sort);
                    next.set("dir", dir);
                    next.delete("page");
                    setSp(next, { preventScrollReset: true });
                  }}
                  options={[
                    { label: "Newest first", value: "joined:desc" },
                    { label: "Oldest first", value: "joined:asc" },
                    { label: "Most points", value: "points:desc" },
                    { label: "Fewest points", value: "points:asc" },
                    { label: "Highest spend", value: "spend:desc" },
                    { label: "Lowest spend", value: "spend:asc" },
                    { label: "Name A to Z", value: "name:asc" },
                    { label: "Name Z to A", value: "name:desc" },
                  ]} />
                {filtered ? <Button variant="plain" onClick={() => { setQuery(""); navigate("/app/customers"); }}>Clear all</Button> : null}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {customers.length === 0 ? (
              filtered ? (
                <EmptyBlock heading="No customers match" action={{ content: "Clear search and filters", onAction: () => { setQuery(""); navigate("/app/customers"); } }}>
                  <p>Check the spelling, or search by phone number or email instead of name.</p>
                </EmptyBlock>
              ) : (
                <EmptyBlock heading="No customers in the program yet" action={{ content: "Import from Smile", url: "/app/import" }}>
                  <p>Customers join automatically when they sign in on the store or place an order. You can also bring over your Smile members.</p>
                </EmptyBlock>
              )
            ) : (
              <IndexTable
                selectable={false}
                itemCount={customers.length}
                resourceName={{ singular: "customer", plural: "customers" }}
                headings={[
                  { title: "Customer" }, { title: "Contact" }, { title: "Tier" },
                  { title: "Points", alignment: "end" }, { title: "Lifetime spend", alignment: "end" },
                  { title: "Joined" }, { title: "Status" },
                ]}
              >
                {customers.map((c, i) => (
                  <IndexTable.Row id={c.id} key={c.id} position={i} onClick={() => navigate(`/app/customers/${c.id}`)}>
                    <IndexTable.Cell>
                      <Link url={`/app/customers/${c.id}`} dataPrimaryLink><Text as="span" fontWeight="semibold">{c.name}</Text></Link>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        {c.email ? <Text as="span">{c.email}</Text> : null}
                        {c.phone ? <Text as="span" tone="subdued">{c.phone}</Text> : null}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell><TierBadge tier={c.tier} /></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{fmtInt(c.pointsBalance)}</Text></IndexTable.Cell>
                    <IndexTable.Cell><Text as="span" alignment="end">{fmtPkr(c.lifetimeSpendPkr)}</Text></IndexTable.Cell>
                    <IndexTable.Cell>{fmtDate(c.enrolledAt)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100">
                        {c.isBlocked ? <Badge tone="critical">Blocked</Badge> : null}
                        {c.optedOut ? <Badge tone="warning">Opted out</Badge> : null}
                        {c.isInfluencer ? <Badge tone="info">Influencer</Badge> : null}
                        {!c.isBlocked && !c.optedOut && !c.isInfluencer ? <Text as="span" tone="subdued">Active</Text> : null}
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
            <Box padding="300"><Pager page={filters.page} pageSize={PAGE_SIZE} total={total} /></Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
