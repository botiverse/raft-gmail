import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright";

const outputDir = resolve("artifacts");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true
});

const accounts = [
  { id: "11111111-1111-4111-8111-111111111111", email: "cindy@raft.build", createdAt: "2026-09-18T00:00:00.000Z" },
  { id: "22222222-2222-4222-8222-222222222222", email: "cindy@botiverse.dev", createdAt: "2026-09-18T00:00:00.000Z" }
];
const grants = [
  {
    accountId: accounts[0]!.id,
    agentId: "9c3b3d7f-291a-4a21-862b-37e754186cdf",
    agentName: "John",
    serverId: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    scopes: ["gmail.read", "gmail.draft"],
    enabled: true,
    updatedAt: "2026-09-18T00:00:00.000Z"
  },
  {
    accountId: accounts[0]!.id,
    agentId: "8d81ed34-07e2-4661-a8b7-a27b4531f659",
    agentName: "Inbox Helper",
    serverId: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    scopes: ["gmail.read"],
    enabled: false,
    updatedAt: "2026-09-18T00:00:00.000Z"
  }
];
const accessRequests = [{
  id: "33333333-3333-4333-8333-333333333333",
  agentId: "ed0e8f7a-0c7e-4c17-a13e-c2e419b164af",
  agentName: "Mail Triage Agent",
  requestedScopes: ["gmail.read", "gmail.draft"],
  reason: "Triage incoming mail and prepare reply drafts for review.",
  status: "pending",
  createdAt: "2026-09-18T00:00:00.000Z"
}];

async function mockDashboard(context: BrowserContext, empty = false) {
  await context.route("**/api/session", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      result: {
        principal: { type: "human", id: "human-1", name: "Cindy", serverId: "95f993fa-2a68-4797-b8ae-7beb7d984ada" },
        csrfToken: "screenshot-csrf-token"
      }
    })
  }));
  await context.route("**/api/accounts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, result: empty ? [] : accounts })
  }));
  await context.route("**/api/access-requests", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, result: empty ? [] : accessRequests })
  }));
  await context.route("**/api/access-request-instructions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, result: {
      prompt: "Request Gmail access from me in Raft Gmail. Use the gmail-access-request action with the secure owner reference in this prompt. Ask only for read and/or draft access and explain why you need it. Sending mail is unavailable.",
      ownerRef: "signed-owner-reference",
      expiresAt: "2026-09-25T00:00:00.000Z"
    } })
  }));
  await context.route("**/api/accounts/*/grants", (route) => {
    const accountId = route.request().url().split("/").at(-2);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, result: grants.filter((grant) => grant.accountId === accountId) })
    });
  });
}

async function capture(name: string, viewport: { width: number; height: number }, empty = false) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await mockDashboard(context, empty);
  const page = await context.newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Gmail access for your Agents" }).waitFor();
  await page.screenshot({ path: resolve(outputDir, name), fullPage: true });
  await context.close();
}

async function captureInteractive(
  name: string,
  viewport: { width: number; height: number },
  action: (page: import("playwright").Page) => Promise<void>
) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await mockDashboard(context);
  const page = await context.newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await action(page);
  await page.screenshot({ path: resolve(outputDir, name), fullPage: true });
  await context.close();
}

await capture("dashboard-populated.png", { width: 1440, height: 1040 });
await capture("dashboard-empty.png", { width: 1440, height: 900 }, true);
await capture("dashboard-mobile.png", { width: 390, height: 844 });
await captureInteractive("dashboard-add-agent.png", { width: 1440, height: 900 }, async (page) => {
  await page.getByRole("button", { name: "Add Agent" }).first().click();
  await page.getByRole("button", { name: "Copy prompt" }).waitFor();
});
await captureInteractive("dashboard-access-requests.png", { width: 1440, height: 950 }, async (page) => {
  await page.getByText("Access requests", { exact: true }).first().click();
  await page.getByRole("button", { name: "Review request" }).waitFor();
});
await captureInteractive("dashboard-review-request.png", { width: 1440, height: 950 }, async (page) => {
  await page.getByText("Access requests", { exact: true }).first().click();
  await page.getByRole("button", { name: "Review request" }).click();
  await page.getByRole("button", { name: "Approve access" }).waitFor();
  await page.waitForTimeout(500);
});

await browser.close();
