import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "ui", "dashboard.js"), "utf8");
const css = fs.readFileSync(path.join(root, "ui", "dashboard.css"), "utf8");

test("Work view exposes a separate operator questions tab and inbox", () => {
  assert.match(html, /data-pm-filter="questions"/);
  assert.match(html, /id="pm-badge-questions"/);
  assert.match(html, /id="pm-operator-section"/);
  assert.match(html, /id="pm-operator-list"/);
  assert.match(html, /Sorular ve Onaylar|Agent Soruları/);
});

test("work detail implements plan-preview-start and active-run stop actions", () => {
  assert.match(script, /function renderExecutionLauncher/);
  assert.match(script, /function prepareWorkItemPlan/);
  assert.match(script, /function startWorkItemExecution/);
  assert.match(script, /function recheckWorkItemCompatibility/);
  assert.match(script, /İşi uyumlu hale getir/);
  assert.match(script, /Uyumluluk önizlemesi/);
  assert.match(script, /\/api\/control-plane\/work-items\//);
  assert.match(script, /\/api\/control-plane\/runs\//);
  assert.match(css, /\.execution-launcher/);
  assert.match(css, /\.plan-preview-grid/);
  assert.match(css, /\.compatibility-card/);
});

test("operator inbox submits one answer and communicates automatic resume", () => {
  assert.match(script, /function renderOperatorInbox/);
  assert.match(script, /function submitOperatorAnswer/);
  assert.match(script, /\/api\/control-plane\/operator-requests\//);
  assert.match(script, /resuming|devam/i);
  assert.match(css, /\.operator-question-card/);
});
