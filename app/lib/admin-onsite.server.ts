// app/lib/admin-onsite.server.ts
// Theme editor deep links for the On-site checklist.
//
// Format per shopify.dev "Configure theme app extensions → Deep linking":
//   app embed:  https://<myshopifyDomain>/admin/themes/current/editor
//                 ?context=apps&template=<template>&activateAppId=<api_key>/<handle>
//   app block:  https://<myshopifyDomain>/admin/themes/current/editor
//                 ?template=<template>&addAppBlockId=<api_key>/<handle>&target=newAppsSection
// <handle> is the block's Liquid filename without ".liquid"; <api_key> is the
// app's client id. Block handles are read from the extension folder at run time
// so this page never names a block that does not exist.
import fs from "node:fs/promises";
import path from "node:path";

export type ThemeBlock = {
  handle: string;
  name: string;
  /** embed = app embed block (switched on in Theme settings → App embeds) */
  kind: "embed" | "block";
  /** first template the block declares itself for, if any */
  template: string | null;
};

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function editorBase(shop: string): string | null {
  return SHOP_RE.test(shop) ? `https://${shop}/admin/themes/current/editor` : null;
}

export function themeEditorUrl(shop: string): string | null {
  return editorBase(shop);
}

export function embedDeepLink(shop: string, apiKey: string, handle: string): string | null {
  const base = editorBase(shop);
  if (!base || !apiKey || !handle) return null;
  // The id is "<api_key>/<handle>"; the slash is part of the documented format.
  return `${base}?context=apps&activateAppId=${encodeURIComponent(apiKey)}/${encodeURIComponent(handle)}`;
}

export function blockDeepLink(shop: string, apiKey: string, handle: string, template?: string | null): string | null {
  const base = editorBase(shop);
  if (!base || !apiKey || !handle) return null;
  const t = template ? `template=${encodeURIComponent(template)}&` : "";
  return `${base}?${t}addAppBlockId=${encodeURIComponent(apiKey)}/${encodeURIComponent(handle)}&target=newAppsSection`;
}

/** Pure: one block's Liquid source → what the checklist needs to know about it. */
export function parseBlockSchema(handle: string, liquid: string): ThemeBlock {
  const fallback: ThemeBlock = { handle, name: handle, kind: "block", template: null };
  const m = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(liquid);
  if (!m) return fallback;
  try {
    const schema = JSON.parse(m[1]) as {
      name?: unknown; target?: unknown; enabled_on?: { templates?: unknown };
    };
    const target = typeof schema.target === "string" ? schema.target : "section";
    const templates = Array.isArray(schema.enabled_on?.templates) ? schema.enabled_on?.templates : [];
    const first = (templates as unknown[]).find((t) => typeof t === "string" && t !== "*");
    return {
      handle,
      name: typeof schema.name === "string" && !schema.name.startsWith("t:") ? schema.name : handle,
      kind: target === "section" ? "block" : "embed",
      template: typeof first === "string" ? first : null,
    };
  } catch {
    return fallback;
  }
}

/** Blocks shipped in extensions/<name>/blocks/*.liquid. Empty when none are deployed with the app. */
export async function discoverThemeBlocks(root: string = process.cwd()): Promise<ThemeBlock[]> {
  const out: ThemeBlock[] = [];
  let extensions: string[];
  try {
    extensions = await fs.readdir(path.join(root, "extensions"));
  } catch {
    return out;
  }
  for (const ext of extensions) {
    const dir = path.join(root, "extensions", ext, "blocks");
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith(".liquid")).sort()) {
      try {
        const src = await fs.readFile(path.join(dir, file), "utf8");
        out.push(parseBlockSchema(file.replace(/\.liquid$/, ""), src));
      } catch {
        // unreadable file: leave it out of the checklist
      }
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.handle.localeCompare(b.handle) : a.kind === "embed" ? -1 : 1));
}
