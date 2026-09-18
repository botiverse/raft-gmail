import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  Clipboard,
  CircleUserRound,
  FilePenLine,
  Inbox,
  LogIn,
  Mail,
  Plus,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
  Unplug
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AppShellMainSlot,
  AppShellRoot,
  AppShellSidebarSlot,
  Avatar,
  AvatarFallback,
  Badge,
  Banner,
  BannerDescription,
  BannerTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardLeading,
  CardTitle,
  CardTrailing,
  Checkbox,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelTitle,
  Separator,
  SidebarBody,
  SidebarContent,
  SidebarHeader,
  SidebarHeaderTitle,
  SidebarItem,
  SidebarItemAside,
  SidebarItemContent,
  SidebarItemIcon,
  SidebarItemSubtitle,
  SidebarItemTitle,
  SidebarList,
  SidebarRoot,
  SidebarSection,
  Spinner,
  Switch,
  SwitchThumb,
  Text
} from "raft-ui";
import {
  DashboardApiError,
  dashboardApi,
  type AccessRequestInstructions,
  type DashboardApi,
  type GrantInput,
  type GrantScope,
  type OwnerSession,
  type PublicAccessRequest,
  type PublicAgentGrant,
  type PublicGmailAccount
} from "./api.js";

interface DashboardModel {
  session: OwnerSession;
  accounts: PublicGmailAccount[];
  grantsByAccount: Record<string, PublicAgentGrant[]>;
  accessRequests: PublicAccessRequest[];
}

type DashboardView = "accounts" | "requests";

interface GrantDraft {
  agentId: string;
  scopes: GrantScope[];
  enabled: boolean;
}

const emptyGrant: GrantDraft = {
  agentId: "",
  scopes: ["gmail.read"],
  enabled: true
};

export function DashboardApp({ api = dashboardApi }: { api?: DashboardApi }) {
  const [model, setModel] = useState<DashboardModel | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionRequired, setSessionRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grantDialogOpen, setGrantDialogOpen] = useState(false);
  const [grantDraft, setGrantDraft] = useState<GrantDraft>(emptyGrant);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [savingGrant, setSavingGrant] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [view, setView] = useState<DashboardView>("accounts");
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [instructions, setInstructions] = useState<AccessRequestInstructions | null>(null);
  const [loadingInstructions, setLoadingInstructions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reviewingRequest, setReviewingRequest] = useState<PublicAccessRequest | null>(null);

  useEffect(() => {
    let active = true;
    void loadDashboard(api)
      .then((next) => {
        if (!active) return;
        setModel(next);
        setSelectedAccountId(next.accounts[0]?.id ?? null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof DashboardApiError && cause.status === 401) {
          setSessionRequired(true);
        } else {
          setError(messageFor(cause));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const selectedAccount = useMemo(
    () => model?.accounts.find((account) => account.id === selectedAccountId) ?? null,
    [model, selectedAccountId]
  );
  const selectedGrants = selectedAccount ? model?.grantsByAccount[selectedAccount.id] ?? [] : [];
  const pendingRequests = model?.accessRequests.filter((request) => request.status === "pending") ?? [];

  async function openAddAgent() {
    setAddAgentOpen(true);
    if (instructions) return;
    setLoadingInstructions(true);
    try {
      setInstructions(await api.getAccessRequestInstructions());
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setLoadingInstructions(false);
    }
  }

  function openEditGrant(grant: PublicAgentGrant) {
    setEditingAgentId(grant.agentId);
    setGrantDraft({ agentId: grant.agentId, scopes: grant.scopes, enabled: grant.enabled });
    setGrantDialogOpen(true);
  }

  async function copyPrompt() {
    if (!instructions) return;
    await navigator.clipboard.writeText(instructions.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function approveRequest(request: PublicAccessRequest, accountIds: string[], scopes: GrantScope[]) {
    if (!model) return;
    const result = await api.approveAccessRequest(request.id, accountIds, scopes, model.session.csrfToken);
    setModel((current) => {
      if (!current) return current;
      const grantsByAccount = { ...current.grantsByAccount };
      for (const grant of result.grants) {
        const existing = grantsByAccount[grant.accountId] ?? [];
        grantsByAccount[grant.accountId] = [...existing.filter((item) => item.agentId !== grant.agentId), grant];
      }
      return {
        ...current,
        grantsByAccount,
        accessRequests: current.accessRequests.map((item) => item.id === request.id ? result.request : item)
      };
    });
    setReviewingRequest(null);
  }

  async function denyRequest(request: PublicAccessRequest) {
    if (!model) return;
    const denied = await api.denyAccessRequest(request.id, model.session.csrfToken);
    setModel((current) => current && ({
      ...current,
      accessRequests: current.accessRequests.map((item) => item.id === request.id ? denied : item)
    }));
    setReviewingRequest(null);
  }

  async function saveGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!model || !selectedAccount || grantDraft.scopes.length === 0 || !grantDraft.agentId.trim()) return;
    setSavingGrant(true);
    setError(null);
    try {
      const saved = await api.putGrant(
        selectedAccount.id,
        { ...grantDraft, agentId: grantDraft.agentId.trim() },
        model.session.csrfToken
      );
      replaceGrant(selectedAccount.id, saved);
      setGrantDialogOpen(false);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSavingGrant(false);
    }
  }

  async function toggleGrant(grant: PublicAgentGrant, enabled: boolean) {
    if (!model || !selectedAccount) return;
    setError(null);
    try {
      const saved = await api.putGrant(
        selectedAccount.id,
        { agentId: grant.agentId, scopes: grant.scopes, enabled },
        model.session.csrfToken
      );
      replaceGrant(selectedAccount.id, saved);
    } catch (cause) {
      setError(messageFor(cause));
    }
  }

  async function revokeGrant(grant: PublicAgentGrant) {
    if (!model || !selectedAccount) return;
    setError(null);
    try {
      await api.deleteGrant(selectedAccount.id, grant.agentId, model.session.csrfToken);
      setModel((current) => current && ({
        ...current,
        grantsByAccount: {
          ...current.grantsByAccount,
          [selectedAccount.id]: current.grantsByAccount[selectedAccount.id]?.filter(
            (item) => item.agentId !== grant.agentId
          ) ?? []
        }
      }));
    } catch (cause) {
      setError(messageFor(cause));
    }
  }

  async function disconnectAccount() {
    if (!model || !selectedAccount) return;
    setDisconnecting(true);
    setError(null);
    try {
      await api.deleteAccount(selectedAccount.id, model.session.csrfToken);
      setModel((current) => {
        if (!current) return current;
        const accounts = current.accounts.filter((account) => account.id !== selectedAccount.id);
        const grantsByAccount = { ...current.grantsByAccount };
        delete grantsByAccount[selectedAccount.id];
        setSelectedAccountId(accounts[0]?.id ?? null);
        return { ...current, accounts, grantsByAccount };
      });
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setDisconnecting(false);
    }
  }

  function replaceGrant(accountId: string, saved: PublicAgentGrant) {
    setModel((current) => {
      if (!current) return current;
      const existing = current.grantsByAccount[accountId] ?? [];
      const next = existing.some((grant) => grant.agentId === saved.agentId)
        ? existing.map((grant) => grant.agentId === saved.agentId ? saved : grant)
        : [...existing, saved];
      return {
        ...current,
        grantsByAccount: { ...current.grantsByAccount, [accountId]: next }
      };
    });
  }

  if (loading) return <LoadingScreen />;
  if (sessionRequired) return <SignedOutScreen />;
  if (!model) return <ErrorScreen message={error ?? "The dashboard could not be loaded."} />;

  return (
    <AppShellRoot className="min-h-dvh bg-layer-canvas-muted">
      <AppShellSidebarSlot className="hidden border-r border-line-muted bg-layer-panel md:block">
        <AccountSidebar
          accounts={model.accounts}
          grantsByAccount={model.grantsByAccount}
          selectedAccountId={selectedAccountId}
          onSelect={(id) => { setSelectedAccountId(id); setView("accounts"); }}
          ownerName={model.session.principal.name}
          view={view}
          pendingCount={pendingRequests.length}
          onRequests={() => setView("requests")}
        />
      </AppShellSidebarSlot>
      <AppShellMainSlot className="min-w-0">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
          <header className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium tracking-wide text-foreground-muted uppercase">Raft Gmail</p>
                <h1 className="truncate text-2xl font-semibold text-foreground-strong sm:text-3xl">
                  Gmail access for your Agents
                </h1>
              </div>
            </div>
            <Button render={<a href="/auth/google/start" />} variant="accent" size="sm">
              <Plus data-icon="inline-start" />
              Connect Gmail
            </Button>
          </header>

          <div className="flex gap-2 md:hidden">
            <Button type="button" variant={view === "accounts" ? "accent" : "outline"} size="sm" onClick={() => setView("accounts")}>Accounts</Button>
            <Button type="button" variant={view === "requests" ? "accent" : "outline"} size="sm" onClick={() => setView("requests")}>
              Access requests {pendingRequests.length ? <Badge variant="accent">{pendingRequests.length}</Badge> : null}
            </Button>
          </div>

          <MobileAccountPicker
            accounts={model.accounts}
            grantsByAccount={model.grantsByAccount}
            selectedAccountId={selectedAccountId}
            onSelect={setSelectedAccountId}
          />

          {error ? (
            <Banner status="destructive" size="sm">
              <BannerTitle>Something went wrong</BannerTitle>
              <BannerDescription>{error}</BannerDescription>
            </Banner>
          ) : null}

          {view === "requests" ? (
            <AccessRequestsView
              requests={model.accessRequests}
              onReview={setReviewingRequest}
              onAddAgent={() => void openAddAgent()}
            />
          ) : selectedAccount ? (
            <>
              <AccountHeader
                account={selectedAccount}
                onDisconnect={disconnectAccount}
                disconnecting={disconnecting}
              />

              <Banner status="info" size="md">
                <BannerTitle>Read and draft only</BannerTitle>
                <BannerDescription>
                  Authorized Agents can search and read mail, and maintain Gmail drafts. Sending mail is not available.
                </BannerDescription>
              </Banner>

              <section className="grid gap-3" aria-labelledby="agent-access-title">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 id="agent-access-title" className="text-lg font-semibold text-foreground-strong">
                      Agent access
                    </h2>
                    <p className="text-sm text-foreground-muted">
                      Permissions apply only to {selectedAccount.email}.
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void openAddAgent()}>
                    <Plus data-icon="inline-start" />
                    Add Agent
                  </Button>
                </div>

                {selectedGrants.length ? (
                  <div className="grid gap-3">
                    {selectedGrants.map((grant) => (
                      <GrantCard
                        key={grant.agentId}
                        grant={grant}
                        onEdit={() => openEditGrant(grant)}
                        onToggle={(enabled) => void toggleGrant(grant, enabled)}
                        onRevoke={() => void revokeGrant(grant)}
                      />
                    ))}
                  </div>
                ) : (
                  <Card>
                    <EmptyState className="min-h-72">
                      <EmptyStateContent>
                        <EmptyStateIcon><Bot /></EmptyStateIcon>
                        <EmptyStateTitle>No Agents have access</EmptyStateTitle>
                        <EmptyStateDescription>
                          Invite an Agent to request access, then approve exactly what it can do.
                        </EmptyStateDescription>
                        <EmptyStateActions>
                          <Button type="button" variant="accent" onClick={() => void openAddAgent()}>
                            <Plus data-icon="inline-start" />
                            Add Agent
                          </Button>
                        </EmptyStateActions>
                      </EmptyStateContent>
                    </EmptyState>
                  </Card>
                )}
              </section>
            </>
          ) : (
            <NoAccounts />
          )}
        </div>
      </AppShellMainSlot>

      <GrantDialog
        open={grantDialogOpen}
        draft={grantDraft}
        editing={Boolean(editingAgentId)}
        saving={savingGrant}
        onOpenChange={setGrantDialogOpen}
        onChange={setGrantDraft}
        onSubmit={saveGrant}
      />
      <AddAgentDialog
        open={addAgentOpen}
        instructions={instructions}
        loading={loadingInstructions}
        copied={copied}
        onOpenChange={setAddAgentOpen}
        onCopy={() => void copyPrompt()}
        onReview={() => { setAddAgentOpen(false); setView("requests"); }}
      />
      <ReviewRequestDialog
        request={reviewingRequest}
        accounts={model.accounts}
        onOpenChange={(open) => { if (!open) setReviewingRequest(null); }}
        onApprove={approveRequest}
        onDeny={denyRequest}
      />
    </AppShellRoot>
  );
}

async function loadDashboard(api: DashboardApi): Promise<DashboardModel> {
  const [session, accounts, accessRequests] = await Promise.all([
    api.getSession(), api.listAccounts(), api.listAccessRequests()
  ]);
  const grants = await Promise.all(accounts.map(async (account) => [account.id, await api.listGrants(account.id)] as const));
  return { session, accounts, grantsByAccount: Object.fromEntries(grants), accessRequests };
}

function AccountSidebar({
  accounts,
  grantsByAccount,
  selectedAccountId,
  onSelect,
  ownerName,
  view,
  pendingCount,
  onRequests
}: {
  accounts: PublicGmailAccount[];
  grantsByAccount: Record<string, PublicAgentGrant[]>;
  selectedAccountId: string | null;
  onSelect: (accountId: string) => void;
  ownerName: string;
  view: DashboardView;
  pendingCount: number;
  onRequests: () => void;
}) {
  return (
    <SidebarRoot className="h-dvh w-[280px]">
      <SidebarHeader>
        <div className="flex items-center gap-3 px-1">
          <div className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent-strong">
            <Mail className="size-5" />
          </div>
          <div className="min-w-0">
            <SidebarHeaderTitle>Raft Gmail</SidebarHeaderTitle>
            <p className="truncate text-xs text-foreground-muted">{ownerName}</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarBody>
        <SidebarContent>
          <div className="px-2 pb-2 text-xs font-medium tracking-wide text-foreground-muted uppercase">Accounts</div>
          <SidebarSection>
            <SidebarList>
              {accounts.map((account) => (
                <SidebarItem
                  key={account.id}
                  active={selectedAccountId === account.id}
                  onClick={() => onSelect(account.id)}
                >
                  <SidebarItemIcon><Mail /></SidebarItemIcon>
                  <SidebarItemContent stacked>
                    <SidebarItemTitle>{account.email}</SidebarItemTitle>
                    <SidebarItemSubtitle>Connected Gmail</SidebarItemSubtitle>
                  </SidebarItemContent>
                  <SidebarItemAside>{grantsByAccount[account.id]?.length ?? 0}</SidebarItemAside>
                </SidebarItem>
              ))}
            </SidebarList>
          </SidebarSection>
          <div className="px-2 pb-2 pt-5 text-xs font-medium tracking-wide text-foreground-muted uppercase">Management</div>
          <SidebarSection>
            <SidebarList>
              <SidebarItem active={view === "requests"} onClick={onRequests}>
                <SidebarItemIcon><UserRoundCheck /></SidebarItemIcon>
                <SidebarItemContent><SidebarItemTitle>Access requests</SidebarItemTitle></SidebarItemContent>
                {pendingCount ? <SidebarItemAside>{pendingCount}</SidebarItemAside> : null}
              </SidebarItem>
            </SidebarList>
          </SidebarSection>
        </SidebarContent>
      </SidebarBody>
      <div className="border-t border-line-muted p-3">
        <Button render={<a href="/auth/google/start" />} variant="outline" size="sm" className="w-full">
          <Plus data-icon="inline-start" />
          Connect Gmail
        </Button>
      </div>
    </SidebarRoot>
  );
}

function MobileAccountPicker({
  accounts,
  grantsByAccount,
  selectedAccountId,
  onSelect
}: {
  accounts: PublicGmailAccount[];
  grantsByAccount: Record<string, PublicAgentGrant[]>;
  selectedAccountId: string | null;
  onSelect: (id: string) => void;
}) {
  if (accounts.length < 2) return null;
  return (
    <div className="grid gap-2 md:hidden">
      <p className="text-xs font-medium tracking-wide text-foreground-muted uppercase">Connected accounts</p>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {accounts.map((account) => (
          <Button
            key={account.id}
            type="button"
            size="sm"
            variant={account.id === selectedAccountId ? "accent" : "outline"}
            onClick={() => onSelect(account.id)}
          >
            <Mail data-icon="inline-start" />
            {account.email}
            <Badge variant="muted">{grantsByAccount[account.id]?.length ?? 0}</Badge>
          </Button>
        ))}
      </div>
    </div>
  );
}

function AccountHeader({
  account,
  onDisconnect,
  disconnecting
}: {
  account: PublicGmailAccount;
  onDisconnect: () => Promise<void>;
  disconnecting: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardLeading>
          <Avatar type="human" size="lg"><AvatarFallback>{initials(account.email)}</AvatarFallback></Avatar>
        </CardLeading>
        <CardTitle render={<h2 />}>{account.email}</CardTitle>
        <CardDescription>Connected Gmail account</CardDescription>
        <CardTrailing>
          <Badge variant="success"><Check className="size-3" /> Connected</Badge>
        </CardTrailing>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-muted pt-4">
          <p className="text-sm text-foreground-muted">Account ID: <span className="font-mono text-xs">{account.id}</span></p>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="danger-outline" size="sm" />}>
              <Unplug data-icon="inline-start" />
              Disconnect
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect {account.email}?</AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogBody>
                <AlertDialogDescription>
                  This removes the stored Google connection and every Agent grant for this account. It does not revoke Google consent.
                </AlertDialogDescription>
              </AlertDialogBody>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="danger"
                  loading={disconnecting}
                  onClick={(event) => {
                    event.preventDefault();
                    void onDisconnect();
                  }}
                >
                  Disconnect account
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

function GrantCard({
  grant,
  onEdit,
  onToggle,
  onRevoke
}: {
  grant: PublicAgentGrant;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onRevoke: () => void;
}) {
  return (
    <Card className={!grant.enabled ? "opacity-70" : undefined}>
      <CardHeader>
        <CardLeading>
          <Avatar type="agent" size="lg"><AvatarFallback><Bot className="size-5" /></AvatarFallback></Avatar>
        </CardLeading>
        <CardTitle render={<h3 />}>{grant.agentName}</CardTitle>
        <CardDescription className="font-mono text-xs">{shortAgentId(grant.agentId)} · {grant.agentId}</CardDescription>
        <CardTrailing>
          <div className="flex items-center gap-2">
            <span className="text-xs text-foreground-muted">{grant.enabled ? "Enabled" : "Paused"}</span>
            <Switch
              aria-label={`Access for ${grant.agentId}`}
              checked={grant.enabled}
              onCheckedChange={onToggle}
            >
              <SwitchThumb />
            </Switch>
          </div>
        </CardTrailing>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          {grant.scopes.includes("gmail.read") ? <Badge variant="information"><Inbox className="size-3" /> Read mail</Badge> : null}
          {grant.scopes.includes("gmail.draft") ? <Badge variant="accent"><FilePenLine className="size-3" /> Maintain drafts</Badge> : null}
        </div>
        <Separator />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>Edit permissions</Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="danger-secondary" size="sm" />}>
              <Trash2 data-icon="inline-start" />
              Revoke
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke this Agent?</AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogBody>
                <AlertDialogDescription>
                  The Agent immediately loses access to this Gmail account. Other account grants are unchanged.
                </AlertDialogDescription>
              </AlertDialogBody>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="danger" onClick={onRevoke}>Revoke access</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

function GrantDialog({
  open,
  draft,
  editing,
  saving,
  onOpenChange,
  onChange,
  onSubmit
}: {
  open: boolean;
  draft: GrantDraft;
  editing: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (draft: GrantDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  function toggleScope(scope: GrantScope, checked: boolean) {
    const scopes = checked
      ? [...new Set([...draft.scopes, scope])]
      : draft.scopes.filter((item) => item !== scope);
    onChange({ ...draft, scopes });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Agent access" : "Add Agent access"}</DialogTitle>
            <DialogClose />
          </DialogHeader>
          <DialogBody className="grid gap-5">
            <DialogDescription>Choose what this Agent can do with only the selected Gmail account.</DialogDescription>
            <Field>
              <FieldLabel htmlFor="agent-id" required>Raft Agent ID</FieldLabel>
              <Input
                id="agent-id"
                value={draft.agentId}
                onChange={(event) => onChange({ ...draft, agentId: event.target.value })}
                placeholder="Agent UUID"
                readOnly={editing}
                required
              />
              <FieldDescription>Use the Agent principal ID shown in Raft.</FieldDescription>
            </Field>

            <fieldset className="grid gap-2 border-0 p-0">
              <legend className="mb-1 text-sm font-medium text-foreground">Permissions <span aria-hidden="true">*</span></legend>
              <div className="grid gap-2">
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line-muted bg-layer-panel p-3">
                  <Checkbox
                    checked={draft.scopes.includes("gmail.read")}
                    onCheckedChange={(checked) => toggleScope("gmail.read", checked === true)}
                    aria-label="Read mail"
                  />
                  <span className="grid gap-0.5">
                    <span className="text-sm font-medium text-foreground">Read mail</span>
                    <span className="text-xs text-foreground-muted">Search and open Gmail messages.</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line-muted bg-layer-panel p-3">
                  <Checkbox
                    checked={draft.scopes.includes("gmail.draft")}
                    onCheckedChange={(checked) => toggleScope("gmail.draft", checked === true)}
                    aria-label="Maintain drafts"
                  />
                  <span className="grid gap-0.5">
                    <span className="text-sm font-medium text-foreground">Maintain drafts</span>
                    <span className="text-xs text-foreground-muted">Create and update drafts. Sending remains unavailable.</span>
                  </span>
                </label>
              </div>
              {draft.scopes.length === 0 ? <p className="text-xs text-danger-foreground">Choose at least one permission.</p> : null}
            </fieldset>

            <Banner status="info" size="sm">
              <BannerTitle>No send capability</BannerTitle>
              <BannerDescription>Neither permission lets the Agent send mail.</BannerDescription>
            </Banner>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              type="submit"
              variant="accent"
              loading={saving}
              disabled={!draft.agentId.trim() || draft.scopes.length === 0}
            >
              {editing ? "Save permissions" : "Add Agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddAgentDialog({
  open,
  instructions,
  loading,
  copied,
  onOpenChange,
  onCopy,
  onReview
}: {
  open: boolean;
  instructions: AccessRequestInstructions | null;
  loading: boolean;
  copied: boolean;
  onOpenChange: (open: boolean) => void;
  onCopy: () => void;
  onReview: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Let an Agent request access</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <DialogDescription>
            Copy this prompt into your conversation with the Agent. Its authenticated Raft identity—not a typed name—will appear for your review.
          </DialogDescription>
          <div className="rounded-lg border border-line-muted bg-layer-canvas-muted p-4">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-foreground-muted"><Spinner /> Preparing a secure request prompt…</div>
            ) : (
              <p className="whitespace-pre-wrap text-sm text-foreground">{instructions?.prompt ?? "The request prompt is unavailable."}</p>
            )}
          </div>
          <Banner status="info" size="sm">
            <BannerTitle>You approve before access begins</BannerTitle>
            <BannerDescription>The Agent requests read and/or draft access. You choose the Gmail accounts and may narrow the permissions. Sending is never available.</BannerDescription>
          </Banner>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onReview}>Review requests</Button>
          <Button type="button" variant="accent" disabled={!instructions || loading} onClick={onCopy}>
            {copied ? <Check data-icon="inline-start" /> : <Clipboard data-icon="inline-start" />}
            {copied ? "Copied" : "Copy prompt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccessRequestsView({
  requests,
  onReview,
  onAddAgent
}: {
  requests: PublicAccessRequest[];
  onReview: (request: PublicAccessRequest) => void;
  onAddAgent: () => void;
}) {
  const pending = requests.filter((request) => request.status === "pending");
  return (
    <Panel>
      <PanelHeader>
        <PanelHeaderContent className="grid gap-1">
          <PanelHeading><PanelTitle>Access requests</PanelTitle></PanelHeading>
          <p className="text-sm text-foreground-muted">Review Agent identity, requested permissions, and purpose before granting account access.</p>
        </PanelHeaderContent>
        <Button type="button" variant="outline" size="sm" onClick={onAddAgent}><Plus data-icon="inline-start" /> Add Agent</Button>
      </PanelHeader>
      <PanelBody>
        {pending.length ? (
          <div className="grid gap-3">
            {pending.map((request) => (
              <Card key={request.id}>
                <CardHeader>
                  <CardLeading><Avatar type="agent" size="lg"><AvatarFallback><Bot className="size-5" /></AvatarFallback></Avatar></CardLeading>
                  <CardTitle render={<h2 />}>{request.agentName}</CardTitle>
                  <CardDescription><span className="font-mono text-xs">{shortAgentId(request.agentId)}</span> · {request.reason}</CardDescription>
                  <CardTrailing><Badge variant="warning">Pending</Badge></CardTrailing>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    {request.requestedScopes.includes("gmail.read") ? <Badge variant="information"><Inbox className="size-3" /> Read mail</Badge> : null}
                    {request.requestedScopes.includes("gmail.draft") ? <Badge variant="accent"><FilePenLine className="size-3" /> Maintain drafts</Badge> : null}
                  </div>
                  <Button type="button" variant="accent" size="sm" onClick={() => onReview(request)}>Review request</Button>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState className="min-h-72">
            <EmptyStateContent>
              <EmptyStateIcon><ShieldCheck /></EmptyStateIcon>
              <EmptyStateTitle>No pending requests</EmptyStateTitle>
              <EmptyStateDescription>When an Agent requests Gmail access, it will appear here for your approval.</EmptyStateDescription>
              <EmptyStateActions><Button type="button" variant="accent" onClick={onAddAgent}>Add Agent</Button></EmptyStateActions>
            </EmptyStateContent>
          </EmptyState>
        )}
      </PanelBody>
    </Panel>
  );
}

function ReviewRequestDialog({
  request,
  accounts,
  onOpenChange,
  onApprove,
  onDeny
}: {
  request: PublicAccessRequest | null;
  accounts: PublicGmailAccount[];
  onOpenChange: (open: boolean) => void;
  onApprove: (request: PublicAccessRequest, accountIds: string[], scopes: GrantScope[]) => Promise<void>;
  onDeny: (request: PublicAccessRequest) => Promise<void>;
}) {
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [scopes, setScopes] = useState<GrantScope[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!request) return;
    setAccountIds(accounts[0]?.id ? [accounts[0].id] : []);
    setScopes(request.requestedScopes);
  }, [request, accounts]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || !accountIds.length || !scopes.length) return;
    setSaving(true);
    try {
      await onApprove(request, accountIds, scopes);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent>
        {request ? (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Review {request.agentName}</DialogTitle>
              <DialogClose />
            </DialogHeader>
            <DialogBody className="grid gap-5">
              <DialogDescription>Choose which connected Gmail accounts this authenticated Agent may use.</DialogDescription>
              <div className="rounded-lg border border-line-muted bg-layer-canvas-muted p-3">
                <p className="text-sm font-medium text-foreground">Why this Agent is asking</p>
                <p className="mt-1 text-sm text-foreground-muted">{request.reason}</p>
                <p className="mt-2 font-mono text-xs text-foreground-muted">{request.agentId}</p>
              </div>
              <fieldset className="grid gap-2 border-0 p-0">
                <legend className="mb-1 text-sm font-medium text-foreground">Gmail accounts</legend>
                {accounts.map((account) => (
                  <label key={account.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-line-muted p-3">
                    <Checkbox
                      checked={accountIds.includes(account.id)}
                      onCheckedChange={(checked) => setAccountIds(checked === true
                        ? [...new Set([...accountIds, account.id])]
                        : accountIds.filter((id) => id !== account.id))}
                      aria-label={account.email}
                    />
                    <span className="text-sm text-foreground">{account.email}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="grid gap-2 border-0 p-0">
                <legend className="mb-1 text-sm font-medium text-foreground">Permissions</legend>
                {request.requestedScopes.map((scope) => (
                  <label key={scope} className="flex cursor-pointer items-center gap-3 rounded-lg border border-line-muted p-3">
                    <Checkbox
                      checked={scopes.includes(scope)}
                      onCheckedChange={(checked) => setScopes(checked === true
                        ? [...new Set([...scopes, scope])]
                        : scopes.filter((item) => item !== scope))}
                      aria-label={scope === "gmail.read" ? "Read mail" : "Maintain drafts"}
                    />
                    <span className="text-sm text-foreground">{scope === "gmail.read" ? "Read mail" : "Maintain drafts"}</span>
                  </label>
                ))}
              </fieldset>
            </DialogBody>
            <DialogFooter>
              <AlertDialog>
                <AlertDialogTrigger render={<Button type="button" variant="danger-secondary" />}>Deny</AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader><AlertDialogTitle>Deny this request?</AlertDialogTitle></AlertDialogHeader>
                  <AlertDialogBody><AlertDialogDescription>The Agent will receive no Gmail access. It may submit a new request later.</AlertDialogDescription></AlertDialogBody>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="danger" onClick={() => void onDeny(request)}>Deny request</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button type="submit" variant="accent" loading={saving} disabled={!accountIds.length || !scopes.length}>Approve access</Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NoAccounts() {
  return (
    <Panel className="min-h-[480px]">
      <PanelHeader>
        <PanelHeaderContent>
          <PanelHeading><PanelTitle>Connected accounts</PanelTitle></PanelHeading>
        </PanelHeaderContent>
      </PanelHeader>
      <PanelBody className="grid place-items-center">
        <EmptyState>
          <EmptyStateContent>
            <EmptyStateIcon><Mail /></EmptyStateIcon>
            <EmptyStateTitle>Connect your first Gmail account</EmptyStateTitle>
            <EmptyStateDescription>
              You stay in control of which Agents may read mail or maintain drafts for each account.
            </EmptyStateDescription>
            <EmptyStateActions>
              <Button render={<a href="/auth/google/start" />} variant="accent">
                <Plus data-icon="inline-start" />
                Connect Gmail
              </Button>
            </EmptyStateActions>
          </EmptyStateContent>
        </EmptyState>
      </PanelBody>
    </Panel>
  );
}

function LoadingScreen() {
  return (
    <main className="grid min-h-dvh place-items-center bg-layer-canvas-muted">
      <div className="flex items-center gap-3 text-sm text-foreground-muted"><Spinner /> Loading Raft Gmail…</div>
    </main>
  );
}

function SignedOutScreen() {
  return (
    <main className="grid min-h-dvh place-items-center bg-layer-canvas-muted p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardLeading><Avatar type="human" size="lg"><AvatarFallback><CircleUserRound /></AvatarFallback></Avatar></CardLeading>
          <CardTitle render={<h1 />}>Manage Gmail access</CardTitle>
          <CardDescription>Sign in as a Raft human to connect accounts and authorize Agents.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button render={<a href="/auth/raft/login" />} variant="accent" className="w-full">
            <LogIn data-icon="inline-start" />
            Login with Raft
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-layer-canvas-muted p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardLeading><AlertCircle className="size-6 text-danger-foreground" /></CardLeading>
          <CardTitle render={<h1 />}>Dashboard unavailable</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" variant="outline" onClick={() => window.location.reload()}>Try again</Button>
        </CardContent>
      </Card>
    </main>
  );
}

function initials(email: string) {
  return email.slice(0, 2).toUpperCase();
}

function shortAgentId(agentId: string) {
  return agentId.length > 18 ? `Agent ${agentId.slice(0, 8)}` : agentId;
}

function messageFor(cause: unknown) {
  return cause instanceof Error ? cause.message : "The request could not be completed.";
}
