import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTokenVault } from "../src/crypto.js";
import { processDueScheduledEmails } from "../src/scheduler.js";
import type { ScheduledEmail } from "../src/types.js";
import { FakeGmail, MemoryRepository } from "./helpers.js";

const key = Buffer.alloc(32, 9).toString("base64");
const vault = createTokenVault(key);

async function fixture(status: ScheduledEmail["status"] = "scheduled") {
  let timestamp = Date.parse("2026-10-22T03:00:00.000Z");
  const now = () => new Date(timestamp);
  const repository = new MemoryRepository(now);
  const gmail = new FakeGmail();
  const account = await repository.upsertGmailAccount({
    ownerId: "owner-1",
    serverId: "server-1",
    email: "owner@example.com",
    encryptedRefreshToken: vault.encrypt("refresh-secret")
  });
  await repository.putGrant({
    accountId: account.id,
    agentId: "agent-1",
    agentName: "Agent 1",
    serverId: "server-1",
    scopes: ["gmail.schedule"],
    enabled: true
  }, "owner-1");
  const email: ScheduledEmail = {
    id: "2166747a-1523-4b19-93e5-8576a773b893",
    accountId: account.id,
    agentId: "agent-1",
    serverId: "server-1",
    operationId: "schedule-operation-1",
    requestHash: "hash",
    providerDraftId: "draft-1",
    scheduledFor: "2026-10-22T03:01:00.000Z",
    status,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString()
  };
  repository.scheduledEmails.set(email.id, email);
  return {
    repository,
    gmail,
    now,
    setTime(value: string) { timestamp = Date.parse(value); },
    email
  };
}

describe("scheduled email worker", () => {
  it("does not claim a job before its scheduled time", async () => {
    const state = await fixture();
    const result = await processDueScheduledEmails({
      repository: state.repository,
      gmail: state.gmail,
      tokenVault: vault,
      now: state.now
    });
    assert.deepEqual(result, { claimed: 0, sent: 0, canceled: 0, outcomeUnknown: 0 });
    assert.equal(state.gmail.sendCalls, 0);
  });

  it("claims once and sends once even when two cron invocations overlap", async () => {
    const state = await fixture();
    state.setTime("2026-10-22T03:01:00.000Z");
    const [first, second] = await Promise.all([
      processDueScheduledEmails({ repository: state.repository, gmail: state.gmail, tokenVault: vault, now: state.now }),
      processDueScheduledEmails({ repository: state.repository, gmail: state.gmail, tokenVault: vault, now: state.now })
    ]);
    assert.equal(first.claimed + second.claimed, 1);
    assert.equal(first.sent + second.sent, 1);
    assert.equal(state.gmail.sendCalls, 1);
    assert.equal(state.repository.scheduledEmails.get(state.email.id)?.status, "sent");
  });

  it("revalidates the live grant and cancels without calling Gmail after revocation", async () => {
    const state = await fixture();
    state.setTime("2026-10-22T03:01:00.000Z");
    await state.repository.deleteGrant(state.email.accountId, "agent-1", "owner-1", "server-1");
    const result = await processDueScheduledEmails({
      repository: state.repository,
      gmail: state.gmail,
      tokenVault: vault,
      now: state.now
    });
    assert.deepEqual(result, { claimed: 1, sent: 0, canceled: 1, outcomeUnknown: 0 });
    assert.equal(state.gmail.sendCalls, 0);
    assert.equal(state.repository.scheduledEmails.get(state.email.id)?.failureCode, "CAPABILITY_REVOKED");
  });

  it("marks an ambiguous Gmail send outcome and never retries it", async () => {
    const state = await fixture();
    state.setTime("2026-10-22T03:01:00.000Z");
    state.gmail.failNextSend = true;
    const first = await processDueScheduledEmails({
      repository: state.repository,
      gmail: state.gmail,
      tokenVault: vault,
      now: state.now
    });
    const second = await processDueScheduledEmails({
      repository: state.repository,
      gmail: state.gmail,
      tokenVault: vault,
      now: state.now
    });
    assert.deepEqual(first, { claimed: 1, sent: 0, canceled: 0, outcomeUnknown: 1 });
    assert.deepEqual(second, { claimed: 0, sent: 0, canceled: 0, outcomeUnknown: 0 });
    assert.equal(state.gmail.sendCalls, 1);
    assert.equal(state.repository.scheduledEmails.get(state.email.id)?.status, "outcome_unknown");
  });
});
