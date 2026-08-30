import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("Work and Parents views request and merge the connected work-source catalog", () => {
  const html = fs.readFileSync("ui/index.html", "utf8");
  const source = fs.readFileSync("ui/dashboard.js", "utf8");

  assert.match(html, /id="work-source-sync-status"/);
  assert.match(html, /id="work-source-refresh-btn"/);
  assert.match(html, /İş Kaynağından Yenile/);
  assert.match(html, /id="work-item-search"/);
  assert.match(html, /id="work-item-state-filter"/);
  assert.match(html, /id="work-item-page-size"/);
  assert.match(html, /id="work-page-prev"/);
  assert.match(html, /id="work-page-next"/);
  assert.match(source, /\/api\/work-source\/catalog/);
  assert.match(source, /function mergedWorkSourceGroups/);
  assert.match(source, /state\.workSourceCatalog\?\.parents/);
  assert.match(source, /refreshWorkSourceCatalog\(false\)/);
  assert.match(source, /Demo modu · Jira okunmuyor/);
  assert.match(source, /function filteredPmItems/);
  assert.match(source, /function updateWorkPagination/);
});
