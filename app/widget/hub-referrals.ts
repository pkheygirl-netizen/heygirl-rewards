import type { CustomerResponse } from "./api";
export function renderReferralsTab(panel: HTMLElement, _data: CustomerResponse) {
  panel.innerHTML = "<p>Loading…</p>";
}
