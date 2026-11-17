// app/widget/cart-line.ts
// The single rewards line shown above the checkout buttons (cart drawer and
// cart page). Pure HTML builder + an idempotent DOM placement helper.
import { bestCode, codeValue, discountUrl, esc, fmt, GIFT_ICON, minRedeem, pointsFor, type CartState, type Config, type MemberData } from "./shared";

export const DRAWER_LINE_ATTR = "data-hg-drawer-line";

/** Normalises /cart.js (or the Liquid cart snapshot) to what the line needs. */
export function cartFromJson(c: unknown): CartState {
  const o = (c ?? {}) as Record<string, unknown>;
  const codes: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v && codes.indexOf(v) < 0) codes.push(v);
  };
  if (Array.isArray(o.discount_codes)) {
    for (const d of o.discount_codes as Array<Record<string, unknown>>) if (d && d.applicable !== false) push(d.code);
  }
  if (Array.isArray(o.cart_level_discount_applications)) {
    for (const d of o.cart_level_discount_applications as Array<Record<string, unknown>>) {
      if (d && d.type === "discount_code") push(d.title);
    }
  }
  if (Array.isArray(o.items)) {
    for (const it of o.items as Array<Record<string, unknown>>) {
      const allocs = it && (it.line_level_discount_allocations as Array<Record<string, unknown>> | undefined);
      if (Array.isArray(allocs)) {
        for (const a of allocs) {
          const app = a && (a.discount_application as Record<string, unknown> | undefined);
          if (app && app.type === "discount_code") push(app.title);
        }
      }
    }
  }
  return { total: Number(o.total_price) || 0, count: Number(o.item_count) || 0, codes };
}

/**
 * Inner HTML of the rewards line; "" when nothing should be shown (empty cart,
 * program off, opted-out or blocked member).
 */
export function cartLineHtml(cfg: Config, cart: CartState, member: MemberData | null, signedIn: boolean, path: string, now: number = Date.now()): string {
  if (!cfg.enabled || cart.count <= 0) return "";
  const m = member && member.member;
  if (m && (m.optedOut || m.blocked)) return "";

  const out: string[] = [];
  const earn = pointsFor(cart.total, cfg, now);
  if (earn > 0) {
    out.push(`<p class="hg-line__main">${GIFT_ICON}<span>You'll earn <strong>${fmt(earn)} points</strong> on this order</span></p>`);
  }
  if (!signedIn) {
    out.push(`<p class="hg-line__sub">Placing an order enrols you in ${esc(cfg.programName)}.</p>`);
  } else if (member && m) {
    const applied = cart.codes.map((c) => c.toUpperCase());
    const mine = member.codes.filter((c) => applied.indexOf(c.code.toUpperCase()) >= 0);
    const best = bestCode(member.codes);
    if (mine.length) {
      out.push(`<p class="hg-line__sub hg-line__ok">Your reward ${esc(mine[0].code)} is applied.</p>`);
    } else if (best && applied.length) {
      out.push(`<p class="hg-line__sub">A discount code is already applied. Reward codes can't be combined with it.</p>`);
    } else if (best && cfg.nudges.rewardUsage) {
      out.push(`<a class="hg-line__link" href="${esc(discountUrl(best.code, path))}">Apply reward: ${esc(codeValue(best))}</a>`);
    } else if (!best && cfg.nudges.pointsSpending && minRedeem(cfg) > 0 && m.pointsBalance >= minRedeem(cfg)) {
      out.push(`<button type="button" class="hg-line__link" data-hg-open="rewards">You have ${fmt(m.pointsBalance)} points. Redeem now</button>`);
    }
  }
  return out.join("");
}

type Marked = HTMLElement & { _hg?: string };

/**
 * Places exactly one rewards line immediately BEFORE the `.cart__ctas`
 * container inside `root` (never inside it: another app injects its button
 * there). Safe to call any number of times; returns true when the DOM changed.
 */
export function ensureDrawerLine(root: Element, html: string): boolean {
  const ctas = root.querySelector(".cart__ctas");
  const existing = Array.prototype.slice.call(root.querySelectorAll(`[${DRAWER_LINE_ATTR}]`)) as Marked[];
  const parent = ctas && ctas.parentNode;
  let changed = false;

  if (!ctas || !parent || !html) {
    for (const el of existing) {
      el.remove();
      changed = true;
    }
    return changed;
  }

  const prev = ctas.previousElementSibling as Marked | null;
  let line = prev && prev.hasAttribute(DRAWER_LINE_ATTR) ? prev : null;
  for (const el of existing) {
    if (el !== line) {
      el.remove();
      changed = true;
    }
  }
  if (!line) {
    line = root.ownerDocument.createElement("div") as Marked;
    line.className = "hg-line";
    line.setAttribute(DRAWER_LINE_ATTR, "");
    parent.insertBefore(line, ctas);
    changed = true;
  }
  if (line._hg !== html) {
    line.innerHTML = html;
    line._hg = html;
    changed = true;
  }
  return changed;
}

/** Updates a Liquid-rendered cart-page block in place. */
export function fillCartBlock(el: Element, html: string): boolean {
  const m = el as Marked;
  if (m._hg === html) return false;
  m.innerHTML = html;
  m._hg = html;
  (m as HTMLElement).hidden = !html;
  return true;
}
