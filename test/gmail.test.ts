import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeMessage } from "../src/gmail.js";

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

function decodeMimePart(message: string, boundary: string, contentType: "text/plain" | "text/html"): string {
  const marker = [
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    ""
  ].join("\r\n");
  const start = message.indexOf(marker);
  assert.notEqual(start, -1, `${contentType} part is missing`);
  const encodedStart = start + marker.length;
  const encodedEnd = message.indexOf(`\r\n--${boundary}`, encodedStart);
  assert.notEqual(encodedEnd, -1, `${contentType} part is not terminated`);
  return Buffer.from(message.slice(encodedStart, encodedEnd).replaceAll("\r\n", ""), "base64").toString("utf8");
}

describe("Gmail draft message encoding", () => {
  it("preserves the existing text/plain message shape when bodyHtml is absent", () => {
    const message = decodeRaw(encodeMessage({
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      subject: "Plain draft",
      bodyText: "Line one\nLine two"
    }));

    assert.equal(message, [
      "To: recipient@example.com",
      "Cc: copy@example.com",
      "Subject: Plain draft",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "Line one\nLine two"
    ].join("\r\n"));
    assert.doesNotMatch(message, /multipart\/alternative/);
  });

  it("encodes HTML drafts as multipart/alternative with an exact text fallback", () => {
    const bodyText = "Hello Cindy,\n\nLong line stays intact: " + "x".repeat(90) + "\n\nThanks!";
    const bodyHtml = "<p>Hello Cindy,</p><p><strong>Long line stays intact</strong>: " + "你好".repeat(30) + "</p><p>Thanks!</p>";
    const message = decodeRaw(encodeMessage({
      to: ["recipient@example.com"],
      subject: "Rich draft",
      bodyText,
      bodyHtml
    }));
    const boundary = message.match(/Content-Type: multipart\/alternative; boundary="([^"]+)"/)?.[1];
    assert.ok(boundary);

    assert.equal(decodeMimePart(message, boundary, "text/plain"), bodyText);
    assert.equal(decodeMimePart(message, boundary, "text/html"), bodyHtml);
    assert.ok(message.indexOf("Content-Type: text/plain") < message.indexOf("Content-Type: text/html"));
    assert.ok(message.endsWith(`--${boundary}--`));
  });
});
