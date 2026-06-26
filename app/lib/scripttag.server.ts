// app/lib/scripttag.server.ts
const WIDGET_URL = `${process.env.SHOPIFY_APP_URL ?? "https://heygirl-rewards.onrender.com"}/loyalty-widget.js`;
const REWARDS_PAGE_HANDLE = "rewards";

const LIST_SCRIPT_TAGS = `
  query { scriptTags(first: 50) { edges { node { id src } } } }
`;

const CREATE_SCRIPT_TAG = `
  mutation CreateScriptTag($input: ScriptTagInput!) {
    scriptTagCreate(input: $input) {
      scriptTag { id src }
      userErrors { field message }
    }
  }
`;

const CREATE_PAGE = `
  mutation CreatePage($input: PageInput!) {
    pageCreate(input: $input) {
      page { id handle }
      userErrors { field message }
    }
  }
`;

const LIST_PAGES = `
  query { pages(first: 10, query: "handle:rewards") { edges { node { id handle } } } }
`;

export async function registerScriptTagAndPage(admin: { graphql: (q: string, o?: object) => Promise<Response> }) {
  try {
    await ensureScriptTag(admin);
    await ensureRewardsPage(admin);
  } catch (err) {
    console.error("[scripttag] registration failed (non-fatal):", err);
  }
}

async function ensureScriptTag(admin: { graphql: (q: string, o?: object) => Promise<Response> }) {
  const res = await admin.graphql(LIST_SCRIPT_TAGS);
  const { data } = await res.json() as { data: { scriptTags: { edges: { node: { id: string; src: string } }[] } } };
  const existing = data.scriptTags.edges.find((e) => e.node.src === WIDGET_URL);
  if (existing) return; // already registered

  await admin.graphql(CREATE_SCRIPT_TAG, {
    variables: { input: { src: WIDGET_URL, displayScope: "ALL" } },
  });
  console.log("[scripttag] registered:", WIDGET_URL);
}

async function ensureRewardsPage(admin: { graphql: (q: string, o?: object) => Promise<Response> }) {
  const res = await admin.graphql(LIST_PAGES);
  const { data } = await res.json() as { data: { pages: { edges: { node: { id: string; handle: string } }[] } } };
  if (data.pages.edges.length > 0) return; // already exists

  await admin.graphql(CREATE_PAGE, {
    variables: {
      input: {
        title: "Rewards",
        handle: REWARDS_PAGE_HANDLE,
        body: "<p>Loading your rewards...</p>",
        published: true,
      },
    },
  });
  console.log("[scripttag] created /pages/rewards Shopify page");
}
