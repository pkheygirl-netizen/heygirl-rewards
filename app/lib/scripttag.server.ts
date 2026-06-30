// app/lib/scripttag.server.ts
// The widget asset is served with a long immutable cache and a STABLE filename,
// so a bare /loyalty-widget.js URL would let browsers + Shopify's CDN keep an old
// bundle for up to a year. Append a per-deploy version query so each deploy yields
// a fresh URL that busts those caches (and makes immutable caching correct). The
// self-heal logic below replaces the old tag with the new versioned one on the
// next admin load.
const WIDGET_FILENAME = "/loyalty-widget.js";
const WIDGET_VERSION =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 8) ??
  process.env.WIDGET_VERSION ??
  "2026-06-30";
const WIDGET_BASE = `${process.env.SHOPIFY_APP_URL ?? "https://app.heygirl.pk"}${WIDGET_FILENAME}`;
const WIDGET_URL = `${WIDGET_BASE}?v=${WIDGET_VERSION}`;
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

const DELETE_SCRIPT_TAG = `
  mutation DeleteScriptTag($id: ID!) {
    scriptTagDelete(id: $id) {
      deletedScriptTagId
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

  // Remove stale HeyGirl widget tags: a previous host (e.g. old Render URL) OR a
  // previous version query. Match on the filename path (ignoring any ?v= query) so
  // both bare and older-versioned tags are replaced by the current WIDGET_URL.
  const stale = data.scriptTags.edges.filter(
    (e) => e.node.src.includes(WIDGET_FILENAME) && e.node.src !== WIDGET_URL,
  );
  for (const s of stale) {
    await admin.graphql(DELETE_SCRIPT_TAG, { variables: { id: s.node.id } });
    console.log("[scripttag] deleted stale tag:", s.node.src);
  }

  const existing = data.scriptTags.edges.find((e) => e.node.src === WIDGET_URL);
  if (existing) return; // already registered at current URL

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
