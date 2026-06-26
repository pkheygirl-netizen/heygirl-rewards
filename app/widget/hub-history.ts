import type { CustomerResponse } from "./api";
export function renderHistoryTab(panel: HTMLElement, _data: CustomerResponse) {
  panel.innerHTML = "<p>Loading…</p>";
}
