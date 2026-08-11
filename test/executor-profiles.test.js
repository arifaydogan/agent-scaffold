import test from "node:test";
import assert from "node:assert/strict";
import { selectExecutionProfile, selectReviewProfile } from "../lib/executor.js";

const settings = {
  data: {
    executor: {
      defaultProvider: "antigravity",
      providers: {
        codex: {
          command: ["codex"], defaultModel: "gpt-5.6-terra", defaultEffort: "medium",
          modelProfiles: { luna: "gpt-5.6-luna", terra: "gpt-5.6-terra", sol: "gpt-5.6-sol", medium: "gpt-5.6-terra", high: "gpt-5.6-sol" }
        },
        antigravity: {
          command: ["agy"], defaultModel: "gemini-3.6-flash-low", defaultEffort: "medium",
          modelProfiles: { "gemini-flash": "gemini-3.6-flash-low", "gemini-pro": "gemini-3.1-pro-high", "claude-review": "claude-sonnet-4-6", medium: "gemini-3.6-flash-low", high: "gemini-3.1-pro-high" }
        }
      }
    }
  }
};

test("model profile selects its configured provider and optional Claude review is opt-in", () => {
  const plan = { persona: "backend-engineer", risk: "normal" };
  const sol = selectExecutionProfile(settings, { labels: ["model-profile-sol"] }, plan);
  assert.equal(sol.provider, "codex");
  assert.equal(sol.model, "gpt-5.6-sol");

  const gemini = selectExecutionProfile(settings, { labels: ["model-profile-gemini-pro"] }, plan);
  assert.equal(gemini.provider, "antigravity");
  assert.equal(gemini.model, "gemini-3.1-pro-high");

  assert.equal(selectReviewProfile(settings, { labels: [] }), null);
  const review = selectReviewProfile(settings, { labels: ["review-claude"] });
  assert.equal(review.provider, "antigravity");
  assert.equal(review.model, "claude-sonnet-4-6");
  assert.equal(review.reviewOnly, true);
});
