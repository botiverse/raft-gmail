import { createHash } from "node:crypto";
import { google } from "googleapis";
import type { Config } from "./config.js";
import type { DraftInput, GmailGateway, GmailMessageResult, GmailSearchResult } from "./types.js";

export function createGmailGateway(config: Config): GmailGateway {
  function client(refreshToken: string) {
    const auth = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: refreshToken });
    return google.gmail({ version: "v1", auth });
  }

  return {
    async search(refreshToken, query, maxResults) {
      const response = await client(refreshToken).users.messages.list({ userId: "me", q: query, maxResults });
      return (response.data.messages ?? []).flatMap((message): GmailSearchResult[] =>
        message.id && message.threadId ? [{ id: message.id, threadId: message.threadId }] : []
      );
    },
    async read(refreshToken, messageId) {
      const response = await client(refreshToken).users.messages.get({ userId: "me", id: messageId, format: "full" });
      if (!response.data.id || !response.data.threadId) throw new Error("GMAIL_MESSAGE_MISSING_ID");
      const result: GmailMessageResult = {
        id: response.data.id,
        threadId: response.data.threadId,
        labelIds: response.data.labelIds ?? [],
        payload: response.data.payload ?? null
      };
      return result;
    },
    async createDraft(refreshToken, input) {
      const response = await client(refreshToken).users.drafts.create({
        userId: "me",
        requestBody: { message: { raw: encodeMessage(input), ...(input.threadId ? { threadId: input.threadId } : {}) } }
      });
      if (!response.data.id) throw new Error("GMAIL_DRAFT_MISSING_ID");
      return { id: response.data.id, ...(response.data.message?.id ? { messageId: response.data.message.id } : {}) };
    },
    async updateDraft(refreshToken, draftId, input) {
      const response = await client(refreshToken).users.drafts.update({
        userId: "me",
        id: draftId,
        requestBody: { message: { raw: encodeMessage(input), ...(input.threadId ? { threadId: input.threadId } : {}) } }
      });
      if (!response.data.id) throw new Error("GMAIL_DRAFT_MISSING_ID");
      return { id: response.data.id, ...(response.data.message?.id ? { messageId: response.data.message.id } : {}) };
    },
    async sendDraft(refreshToken, draftId) {
      const response = await client(refreshToken).users.drafts.send({
        userId: "me",
        requestBody: { id: draftId }
      });
      if (!response.data.id || !response.data.threadId) throw new Error("GMAIL_SENT_MESSAGE_MISSING_ID");
      return { id: response.data.id, threadId: response.data.threadId };
    }
  };
}

export function encodeMessage(input: DraftInput): string {
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0"
  ];

  if (input.bodyHtml === undefined) {
    headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit");
    return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${input.bodyText}`, "utf8").toString("base64url");
  }

  const boundaryDigest = createHash("sha256")
    .update(input.bodyText, "utf8")
    .update("\0", "utf8")
    .update(input.bodyHtml, "utf8")
    .digest("hex")
    .slice(0, 32);
  const boundary = `raft-gmail-${boundaryDigest}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const parts = [
    mimePart(boundary, "text/plain", input.bodyText),
    mimePart(boundary, "text/html", input.bodyHtml),
    `--${boundary}--`
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`, "utf8").toString("base64url");
}

function mimePart(boundary: string, contentType: "text/plain" | "text/html", body: string): string {
  return [
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(body, "utf8").toString("base64"))
  ].join("\r\n");
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}
