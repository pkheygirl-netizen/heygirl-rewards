import type { CustomerResponse } from "./api";
export function renderRewardsTab(panel: HTMLElement, _data: CustomerResponse) {
  panel.innerHTML = "<p>Loading…</p>";
}
