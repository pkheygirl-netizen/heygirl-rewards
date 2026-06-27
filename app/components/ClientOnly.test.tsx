import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { ClientOnly } from "./ClientOnly";

describe("ClientOnly", () => {
  it("renders the fallback and NEVER invokes children during SSR", () => {
    let childrenCalled = false;
    const html = renderToString(
      <ClientOnly fallback={<span>loading</span>}>
        {() => {
          childrenCalled = true;
          // Simulates a component that touches `window` on render (polaris-viz).
          return <span>{(window as unknown as string)}</span>;
        }}
      </ClientOnly>,
    );
    expect(childrenCalled).toBe(false);
    expect(html).toContain("loading");
  });

  it("renders nothing when no fallback is given (SSR)", () => {
    const html = renderToString(<ClientOnly>{() => <span>chart</span>}</ClientOnly>);
    expect(html).not.toContain("chart");
  });
});
