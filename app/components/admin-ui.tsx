// app/components/admin-ui.tsx
// Small pieces every admin page uses: toast on success, error and warning
// banners, confirmation for destructive actions, loading skeleton, empty
// states, paging and the period picker.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "@remix-run/react";
import {
  Badge, Banner, BlockStack, Box, Button, Card, EmptyState, InlineStack, Layout, Link, Modal,
  Pagination, Select, SkeletonBodyText, SkeletonDisplayText, SkeletonPage, Text,
} from "@shopify/polaris";
import { PERIOD_OPTIONS, tierLabel, type PeriodKey } from "./karachi";

type ShopifyGlobal = { toast?: { show: (message: string, opts?: { isError?: boolean; duration?: number }) => void } };

export function showToast(message: string, isError = false): void {
  if (typeof window === "undefined") return;
  (window as unknown as { shopify?: ShopifyGlobal }).shopify?.toast?.show(message, { isError });
}

export type ActionData =
  | { ok: true; message?: string; warning?: string }
  | { ok: false; error?: string; errors?: Record<string, string> }
  | null
  | undefined;

/**
 * Shows a toast once for each successful action result. `data` is whatever the
 * action returned (useActionData or fetcher.data); a new object is a new result.
 */
export function useActionToast(data: unknown): void {
  const seen = useRef<unknown>(null);
  useEffect(() => {
    if (!data || data === seen.current) return;
    seen.current = data;
    const d = data as { ok?: boolean; message?: string };
    if (d.ok === true && d.message) showToast(d.message);
  }, [data]);
}

/** Inline banner for a failed action, and for a save that worked with a warning. */
export function ResultBanner({ data }: { data: unknown }): ReactNode {
  const d = data as { ok?: boolean; error?: string; warning?: string } | null | undefined;
  if (!d) return null;
  if (d.ok === false) {
    return (
      <Banner tone="critical" title="That did not work">
        <p>{d.error || "Something went wrong. Please try again."}</p>
      </Banner>
    );
  }
  if (d.ok === true && d.warning) {
    return (
      <Banner tone="warning" title="Saved with a warning">
        <p>{d.warning}</p>
      </Banner>
    );
  }
  return null;
}

export function fieldError(data: unknown, name: string): string | undefined {
  const d = data as { ok?: boolean; errors?: Record<string, string> } | null | undefined;
  return d && d.ok === false ? d.errors?.[name] : undefined;
}

export function ConfirmModal(props: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      primaryAction={{
        content: props.confirmLabel,
        destructive: props.destructive ?? true,
        loading: props.loading,
        onAction: props.onConfirm,
      }}
      secondaryActions={[{ content: "Cancel", onAction: props.onClose }]}
    >
      <Modal.Section>{props.children}</Modal.Section>
    </Modal>
  );
}

export function PageSkeleton(): ReactNode {
  return (
    <SkeletonPage primaryAction>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={3} />
              </BlockStack>
            </Card>
            <Card>
              <SkeletonBodyText lines={8} />
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </SkeletonPage>
  );
}

const EMPTY_IMAGE = "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png";

/** An empty state always says what to do next. */
export function EmptyBlock(props: {
  heading: string;
  children: ReactNode;
  action?: { content: string; url?: string; onAction?: () => void };
}): ReactNode {
  return (
    <EmptyState heading={props.heading} image={EMPTY_IMAGE} action={props.action}>
      {props.children}
    </EmptyState>
  );
}

/** Period picker bound to ?period= in the URL, so a period can be bookmarked. */
export function PeriodSelect({ value, extra = [] }: {
  value: PeriodKey; extra?: Array<{ value: PeriodKey; label: string }>;
}): ReactNode {
  const [sp, setSp] = useSearchParams();
  return (
    <Box minWidth="180px">
      <Select
        label="Period"
        labelInline
        options={[...PERIOD_OPTIONS, ...extra]}
        value={value}
        onChange={(v) => {
          const next = new URLSearchParams(sp);
          next.set("period", v);
          next.delete("page");
          setSp(next, { preventScrollReset: true });
        }}
      />
    </Box>
  );
}

/** Previous / next bound to a page parameter in the URL (zero-based). */
export function Pager({ page, pageSize, total, param = "page", hasMore }: {
  page: number; pageSize: number; total?: number; param?: string; hasMore?: boolean;
}): ReactNode {
  const [sp, setSp] = useSearchParams();
  const go = (p: number) => {
    const next = new URLSearchParams(sp);
    if (p <= 0) next.delete(param);
    else next.set(param, String(p));
    setSp(next, { preventScrollReset: true });
  };
  const more = hasMore ?? (total !== undefined && (page + 1) * pageSize < total);
  if (page === 0 && !more) return null;
  const label = total !== undefined && total > 0
    ? `${page * pageSize + 1}-${Math.min((page + 1) * pageSize, total)} of ${total}`
    : `Page ${page + 1}`;
  return (
    <InlineStack align="center">
      <Pagination
        hasPrevious={page > 0}
        onPrevious={() => go(page - 1)}
        hasNext={more}
        onNext={() => go(page + 1)}
        label={label}
      />
    </InlineStack>
  );
}

export function TierBadge({ tier }: { tier: string }): ReactNode {
  const tone = tier === "diamond" ? "info" : tier === "gold" ? "attention" : undefined;
  return <Badge tone={tone}>{tierLabel(tier)}</Badge>;
}

/**
 * A key number. The whole card is one link, so the number always goes somewhere.
 */
export function StatCard(props: {
  title: string; value: string; sub?: string; change?: { text: string; tone: "up" | "down" | "flat" };
  url: string; linkLabel: string;
}): ReactNode {
  return (
    <Card>
      <BlockStack gap="150">
        <Text as="h3" variant="headingSm" tone="subdued">{props.title}</Text>
        <Text as="p" variant="headingXl">{props.value}</Text>
        {props.sub ? <Text as="p" variant="bodySm" tone="subdued">{props.sub}</Text> : null}
        {props.change ? (
          <Text
            as="p" variant="bodySm"
            tone={props.change.tone === "up" ? "success" : props.change.tone === "down" ? "critical" : "subdued"}
          >
            {props.change.text}
          </Text>
        ) : null}
        <Link url={props.url} removeUnderline>{props.linkLabel}</Link>
      </BlockStack>
    </Card>
  );
}

/** Copy text to the clipboard and confirm with a toast. */
export function CopyButton({ text, label = "Copy link" }: { text: string; label?: string }): ReactNode {
  return (
    <Button
      size="slim"
      disabled={!text}
      onClick={() => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          navigator.clipboard.writeText(text).then(
            () => showToast("Copied"),
            () => showToast("Could not copy. Select the text and copy it by hand.", true),
          );
        } else {
          showToast("Could not copy. Select the text and copy it by hand.", true);
        }
      }}
    >
      {label}
    </Button>
  );
}

/** A link that leaves the app for another page of the Shopify admin. */
export function AdminExternalLink({ url, children }: { url: string | null; children: ReactNode }): ReactNode {
  if (!url) return null;
  return (
    <a href={url} target="_top" rel="noreferrer" style={{ color: "var(--p-color-text-link)" }}>
      {children}
    </a>
  );
}

/** Search box state that pushes to the URL when the staff member stops typing. */
export function useDebouncedParam(param: string, delayMs = 350): [string, (v: string) => void] {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const [value, setValue] = useState(sp.get(param) ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const update = (v: string) => {
    setValue(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = new URLSearchParams(window.location.search);
      if (v.trim()) next.set(param, v.trim());
      else next.delete(param);
      next.delete("page");
      navigate(`?${next.toString()}`, { replace: true, preventScrollReset: true });
    }, delayMs);
  };
  return [value, update];
}

/** A random key for a form submission, so a double submit is applied once. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Reads a whole-number or decimal setting for a text field. Settings arrive as
 * numbers or numeric strings ("50000.00"); the field shows "50000".
 */
export function fieldValue(v: unknown, fallback = ""): string {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}
