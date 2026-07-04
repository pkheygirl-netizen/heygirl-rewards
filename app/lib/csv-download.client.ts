// W10 (2026-07-03 review): CSV exports were plain iframe link navigations, which
// break under embedded token-exchange auth (no session token on a raw document
// request). Fetch + blob keeps the download inside the authenticated context —
// App Bridge patches same-origin fetch with the Authorization header.
export async function downloadCsv(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`export failed: ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    console.error("[downloadCsv]", err);
    (window as { shopify?: { toast?: { show: (m: string, o?: { isError?: boolean }) => void } } })
      .shopify?.toast?.show("Export failed — please try again", { isError: true });
  }
}
