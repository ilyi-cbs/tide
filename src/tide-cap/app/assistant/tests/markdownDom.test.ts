import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { renderMarkdown } from "../src/markdownDom";

test("renders Markdown as safe DOM nodes", () => {
  const dom = new JSDOM("", { url: "https://example.com/catalog/" });
  Object.assign(globalThis, { document: dom.window.document });
  const result = renderMarkdown(
    "# Results\n- **Strong** and `code`\n- [Open](../item/1)\n```html\n<script>alert(1)</script>\n```",
  );
  assert.equal(result.querySelector("h4")?.textContent, "Results");
  assert.equal(result.querySelector("strong")?.textContent, "Strong");
  assert.equal(
    result.querySelector("a")?.getAttribute("href"),
    "https://example.com/item/1",
  );
  assert.equal(
    result.querySelector("a")?.getAttribute("rel"),
    "noopener noreferrer",
  );
  assert.equal(
    result.querySelector("pre")?.textContent,
    "<script>alert(1)</script>",
  );
  assert.equal(result.querySelector("script"), null);
  dom.window.close();
});

test("never navigates to non-HTTP(S) destinations or interprets markup", () => {
  const dom = new JSDOM("", { url: "https://example.com/" });
  Object.assign(globalThis, { document: dom.window.document });
  const result = renderMarkdown(
    "[unsafe](javascript:alert%281%29) <img src=x onerror=alert(1)>",
  );
  assert.equal(result.querySelector("a")?.hasAttribute("href"), false);
  assert.equal(result.querySelector("img"), null);
  assert.match(result.textContent ?? "", /<img src=x onerror=alert\(1\)>/);
  dom.window.close();
});

test("keeps in-app hash routes in the same tab", () => {
  const dom = new JSDOM("", { url: "https://example.com/cockpit/index.html" });
  Object.assign(globalThis, { document: dom.window.document });
  const result = renderMarkdown(
    "See [4500000001/10](#/OpenItems(PurchaseOrder='4500000001',PurchaseOrderItem='10')).",
  );
  const link = result.querySelector("a");
  assert.equal(link?.textContent, "4500000001/10");
  assert.equal(
    link?.getAttribute("href"),
    "#/OpenItems(PurchaseOrder='4500000001',PurchaseOrderItem='10')",
  );
  assert.equal(link?.hasAttribute("target"), false);
  assert.equal(result.textContent, "See 4500000001/10.");
  dom.window.close();
});

test("renders Markdown row listings as accessible tables", () => {
  const dom = new JSDOM("", { url: "https://example.com/cockpit/index.html" });
  Object.assign(globalThis, { document: dom.window.document });
  const result = renderMarkdown(
    "| Order | Result |\n| --- | :---: |\n| [4500000001/10](#/Findings('at_risk:4500000001/10')) | Late |",
  );
  const table = result.querySelector("table.assistantMarkdownTable");
  assert.ok(table);
  assert.equal(table.querySelectorAll("thead th").length, 2);
  assert.equal(table.querySelector("th")?.getAttribute("scope"), "col");
  assert.equal(table.querySelector("tbody td a")?.getAttribute("href"), "#/Findings('at_risk:4500000001/10')");
  assert.equal(table.querySelector("tbody td a")?.textContent, "4500000001/10");
  dom.window.close();
});
