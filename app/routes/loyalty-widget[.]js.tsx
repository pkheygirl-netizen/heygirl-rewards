// app/routes/loyalty-widget[.]js.tsx — GET /loyalty-widget.js
// The v2 storefront script. v3 is a theme app extension, but a script tag left
// on a store by the old version still asks for this file on every page view
// (guests included). Answer once with an empty script that browsers and
// Shopify's CDN keep for a year, so the requests stop and nothing errors.
// The tag itself is removed by removeLegacyScriptTags (install / Settings).
const RETIRED_WIDGET_BODY = "/* retired */\n";

export const loader = async () =>
  new Response(RETIRED_WIDGET_BODY, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
