import type { CustomerResponse } from "./api";
export function renderTiersTab(panel: HTMLElement, _data: CustomerResponse) {
  panel.innerHTML = "<p>Loading…</p>";
}
