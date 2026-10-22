import type { TokenVault } from "./crypto.js";
import type { GmailGateway, Repository, ScheduledEmail } from "./types.js";

interface SchedulerDependencies {
  repository: Repository;
  gmail: GmailGateway;
  tokenVault: TokenVault;
  now?: () => Date;
  limit?: number;
}

export interface SchedulerResult {
  claimed: number;
  sent: number;
  canceled: number;
  outcomeUnknown: number;
}

export async function processDueScheduledEmails(dependencies: SchedulerDependencies): Promise<SchedulerResult> {
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const jobs = await dependencies.repository.claimDueScheduledEmails(now, dependencies.limit ?? 25);
  const result: SchedulerResult = { claimed: jobs.length, sent: 0, canceled: 0, outcomeUnknown: 0 };

  for (const job of jobs) {
    const account = await dependencies.repository.getGmailAccount(job.accountId);
    const grant = account
      ? await dependencies.repository.getGrant(job.accountId, job.agentId, job.serverId)
      : null;
    if (!account || account.serverId !== job.serverId || !grant?.enabled || !grant.scopes.includes("gmail.schedule")) {
      await dependencies.repository.completeScheduledEmailCanceled(job.id, "CAPABILITY_REVOKED");
      await appendSchedulerAudit(dependencies.repository, job, "denied", { failureCode: "CAPABILITY_REVOKED" });
      result.canceled += 1;
      continue;
    }

    if (!job.providerDraftId) {
      await dependencies.repository.completeScheduledEmailOutcomeUnknown(job.id, "PROVIDER_DRAFT_ID_MISSING");
      await appendSchedulerAudit(dependencies.repository, job, "failed", {
        failureCode: "PROVIDER_DRAFT_ID_MISSING",
        outcomeUnknown: true
      });
      result.outcomeUnknown += 1;
      continue;
    }

    let sent: { id: string; threadId: string };
    try {
      sent = await dependencies.gmail.sendDraft(
        dependencies.tokenVault.decrypt(account.encryptedRefreshToken),
        job.providerDraftId
      );
      await dependencies.repository.completeScheduledEmailSent(job.id, sent.id);
    } catch {
      await dependencies.repository.completeScheduledEmailOutcomeUnknown(job.id, "GMAIL_SEND_OUTCOME_UNKNOWN");
      await appendSchedulerAudit(dependencies.repository, job, "failed", {
        providerDraftId: job.providerDraftId,
        failureCode: "GMAIL_SEND_OUTCOME_UNKNOWN",
        outcomeUnknown: true
      });
      result.outcomeUnknown += 1;
      continue;
    }
    await appendSchedulerAudit(dependencies.repository, job, "succeeded", {
      providerDraftId: job.providerDraftId,
      providerMessageId: sent.id
    });
    result.sent += 1;
  }

  return result;
}

function appendSchedulerAudit(
  repository: Repository,
  job: ScheduledEmail,
  outcome: "denied" | "succeeded" | "failed",
  metadata: Record<string, unknown>
) {
  return repository.appendAudit({
    actorType: "agent",
    actorId: job.agentId,
    serverId: job.serverId,
    accountId: job.accountId,
    action: "gmail.scheduled_send.execute",
    outcome,
    operationId: job.operationId,
    metadata: { scheduledEmailId: job.id, ...metadata }
  });
}
