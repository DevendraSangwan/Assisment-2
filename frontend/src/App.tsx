import {
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileUp,
  Inbox,
  LoaderCircle,
  LogOut,
  Mail,
  Plus,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import Papa from "papaparse";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { AppConfig, ScheduledEmail, Sender, User } from "./types";

type View = "scheduled" | "sent" | "compose";
type Notice = { kind: "success" | "error"; message: string };

function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function getDefaultScheduleTime(): string {
  const time = new Date(Date.now() + 5 * 60_000);
  time.setSeconds(0, 0);
  const local = new Date(time.getTime() - time.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function LoginScreen(): JSX.Element {
  return (
    <main className="login-screen">
      <a className="brand login-brand" href="/" aria-label="ReachInbox home">
        <span className="brand-mark"><Mail size={17} strokeWidth={2.2} /></span>
        <span>reachinbox</span>
      </a>
      <section className="login-card">
        <div className="login-logo"><Mail size={22} /></div>
        <h1>Welcome back</h1>
        <p>Sign in to your email workspace</p>
        <a className="google-button" href="/auth/google">
          <span className="google-g">G</span>
          Continue with Google
          <ArrowUpRight size={15} />
        </a>
        <div className="login-safe"><ShieldCheck size={14} /> Secure sign-in powered by Google</div>
      </section>
      <p className="login-foot">A calmer way to reach the right people.</p>
    </main>
  );
}

function StatusBadge({ status }: { status: ScheduledEmail["status"] }): JSX.Element {
  const labels = {
    scheduled: "Scheduled",
    sending: "Sending",
    sent: "Sent",
    failed: "Failed",
  };
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {labels[status]}
    </span>
  );
}

function EmptyState({ sent, query }: { sent: boolean; query: string }): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-icon">{sent ? <Send size={20} /> : <Clock3 size={20} />}</div>
      <h3>{query ? "No matching emails" : sent ? "Nothing sent yet" : "Your schedule is clear"}</h3>
      <p>
        {query
          ? "Try a different search term."
          : sent
            ? "Emails you send will show up here."
            : "Compose an email and it’ll appear here before it goes out."}
      </p>
    </div>
  );
}

interface ComposerProps {
  senders: Sender[];
  config: AppConfig;
  onCancel: () => void;
  onScheduled: (message: string) => void;
  onSenderSaved: (sender: Sender) => void;
}

function Composer({ senders, config, onCancel, onScheduled, onSenderSaved }: ComposerProps): JSX.Element {
  const [senderId, setSenderId] = useState(senders[0]?.id ?? "");
  const selectedSender = senders.find((sender) => sender.id === senderId);
  const [recipientText, setRecipientText] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [scheduledAt, setScheduledAt] = useState(getDefaultScheduleTime);
  const [delaySeconds, setDelaySeconds] = useState(Math.max(0, config.minSendIntervalMs) / 1000);
  const [hourlyLimit, setHourlyLimit] = useState(selectedSender?.hourlyLimit ?? config.maxEmailsPerHourPerSender);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [senderForm, setSenderForm] = useState(false);
  const [senderEmail, setSenderEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const addRecipients = (values: string[]): void => {
    const emailPattern = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+/g;
    const found = values.flatMap((value) => value.match(emailPattern) ?? []);
    setRecipients((current) => [...new Set([...current, ...found.map((email) => email.toLowerCase())])]);
  };

  const handleFile = (file?: File): void => {
    if (!file) return;
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete: (result) => {
        addRecipients(result.data.flatMap((row) => row));
      },
      error: (parseError) => setError(`Could not read this file: ${parseError.message}`),
    });
  };

  const handleSchedule = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError("");
    const allRecipients = [...new Set([...recipients, ...recipientText.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean)])];
    if (!senderId) {
      setError("Add a sender email before scheduling.");
      return;
    }
    if (!allRecipients.length) {
      setError("Upload a leads file or enter at least one recipient email.");
      return;
    }
    if (!subject.trim() || !body.trim()) {
      setError("Add a subject and message before scheduling.");
      return;
    }
    setBusy(true);
    try {
      const currentSender = selectedSender;
      if (currentSender && currentSender.hourlyLimit !== hourlyLimit) {
        await api.saveSender({
          email: currentSender.email,
          name: currentSender.name,
          hourlyLimit,
        });
      }
      const result = await api.schedule({
        senderId,
        recipients: allRecipients,
        subject: subject.trim(),
        body,
        scheduledAt: new Date(scheduledAt).toISOString(),
        delayMs: Math.round(delaySeconds * 1000),
      }, crypto.randomUUID());
      const message = `${result.count} ${result.count === 1 ? "email" : "emails"} added to your schedule.`;
      onScheduled(result.warning ? `${message} ${result.warning}` : message);
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : "Could not schedule emails.");
    } finally {
      setBusy(false);
    }
  };

  const handleAddSender = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError("");
    try {
      const result = await api.saveSender({
        email: senderEmail,
        name: senderName,
        hourlyLimit,
      });
      onSenderSaved(result.sender);
      setSenderId(result.sender.id);
      setSenderForm(false);
    } catch (senderError) {
      setError(senderError instanceof Error ? senderError.message : "Could not add sender.");
    }
  };

  return (
    <section className="composer-page">
      <header className="composer-top">
        <button className="icon-button" onClick={onCancel} aria-label="Back to emails"><ArrowLeft size={18} /></button>
        <div className="composer-top-title">
          <span className="eyebrow">NEW CAMPAIGN</span>
          <h1>Compose email</h1>
        </div>
        <div className="composer-actions">
          <span className="draft-label"><span /> Draft saved</span>
          <button className="button button-primary" form="compose-form" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Send size={15} />}
            {busy ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      </header>

      <div className="composer-layout">
        <form id="compose-form" className="compose-card" onSubmit={(event) => void handleSchedule(event)}>
          <div className="compose-fields">
            <label className="compose-row">
              <span className="compose-label">From</span>
              <div className="sender-select-wrap">
                {senders.length ? (
                  <select
                    className="compose-input sender-select"
                    value={senderId}
                    onChange={(event) => {
                      setSenderId(event.target.value);
                      const sender = senders.find((item) => item.id === event.target.value);
                      if (sender) setHourlyLimit(sender.hourlyLimit);
                    }}
                  >
                    {senders.map((sender) => (
                      <option key={sender.id} value={sender.id}>{sender.name} &lt;{sender.email}&gt;</option>
                    ))}
                  </select>
                ) : <span className="muted-text">No sender connected yet</span>}
                <button className="text-button" type="button" onClick={() => setSenderForm(!senderForm)}>
                  <Plus size={14} /> Add sender
                </button>
              </div>
            </label>

            {senderForm && (
              <div className="sender-form">
                <input required type="text" placeholder="Sender name" value={senderName} onChange={(event) => setSenderName(event.target.value)} />
                <input required type="email" placeholder="sender@example.com" value={senderEmail} onChange={(event) => setSenderEmail(event.target.value)} />
                <button className="button button-small button-outline" type="submit" form="add-sender-form">Save sender</button>
              </div>
            )}

            <label className="compose-row recipient-row">
              <span className="compose-label">To</span>
              <div className="recipient-content">
                {recipients.length > 0 && (
                  <div className="recipient-chips">
                    <span className="recipient-chip"><Mail size={12} /> {recipients.length} leads uploaded <button type="button" onClick={() => setRecipients([])} aria-label="Remove uploaded leads"><X size={12} /></button></span>
                  </div>
                )}
                <textarea
                  className="compose-input recipient-textarea"
                  placeholder="Add email addresses separated by commas"
                  value={recipientText}
                  onChange={(event) => setRecipientText(event.target.value)}
                  rows={2}
                />
                <button className="text-button upload-link" type="button" onClick={() => fileInput.current?.click()}>
                  <FileUp size={14} /> Upload a list
                </button>
                <input
                  ref={fileInput}
                  hidden
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  onChange={(event) => handleFile(event.target.files?.[0])}
                />
              </div>
            </label>
            <label className="compose-row">
              <span className="compose-label">Subject</span>
              <input className="compose-input" placeholder="A thoughtful subject line" value={subject} onChange={(event) => setSubject(event.target.value)} required />
            </label>
          </div>

          <div className="editor-toolbar">
            <span className="toolbar-dropdown">Aa <ChevronDown size={12} /></span>
            <span className="toolbar-divider" />
            <button type="button" aria-label="Bold"><strong>B</strong></button>
            <button type="button" aria-label="Italic"><em>I</em></button>
            <button type="button" aria-label="Underline"><u>U</u></button>
            <span className="toolbar-divider" />
            <button type="button" aria-label="Insert link"><ArrowUpRight size={15} /></button>
            <button type="button" aria-label="Add personalization"><Sparkles size={15} /></button>
            <span className="toolbar-spacer" />
            <span className="text-count">{body.length} characters</span>
          </div>
          <textarea
            className="message-editor"
            placeholder={"Hi {{first_name}},\n\nI came across your work and thought this might be useful…"}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
          />
          {error && <div className="inline-error"><X size={14} /> {error}</div>}
          <div className="compose-footer"><span>Personalized email, sent one at a time.</span><span>{recipients.length} detected</span></div>
        </form>

        <aside className="schedule-card">
          <div className="schedule-card-heading"><div className="schedule-icon"><Clock3 size={17} /></div><div><h2>Delivery settings</h2><p>Choose when and how often to send</p></div></div>
          <label className="setting-field">
            <span>Start date &amp; time</span>
            <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required />
          </label>
          <label className="setting-field">
            <span>Delay between emails</span>
            <div className="input-suffix"><input type="number" min={config.minSendIntervalMs / 1000} step="0.5" value={delaySeconds} onChange={(event) => setDelaySeconds(Number(event.target.value))} /><span>seconds</span></div>
            <small>Minimum {Math.ceil(config.minSendIntervalMs / 1000)} seconds, enforced across workers.</small>
          </label>
          <label className="setting-field">
            <span>Hourly sender limit</span>
            <div className="input-suffix"><input type="number" min="1" max={config.maxEmailsPerHourPerSender} value={hourlyLimit} onChange={(event) => setHourlyLimit(Number(event.target.value))} /><span>emails / hour</span></div>
            <small>Up to {config.maxEmailsPerHourPerSender} per sender. Limit hits are queued for the next hour.</small>
          </label>
          <div className="schedule-note"><Bell size={15} /><span>If you connect Slack, we’ll alert you when a sender reaches their hourly limit.</span></div>
          <div className="schedule-summary"><span><Inbox size={14} /> Recipients detected</span><strong>{new Set([...recipients, ...(recipientText.match(/[^\s,;]+@[^\s,;]+/g) ?? []).map((email) => email.toLowerCase())]).size}</strong></div>
          <button className="button button-primary schedule-submit" form="compose-form" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
            {busy ? "Scheduling…" : "Schedule campaign"}
          </button>
          <form id="add-sender-form" onSubmit={(event) => void handleAddSender(event)} className="hidden-form" />
        </aside>
      </div>
    </section>
  );
}

function App(): JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [config, setConfig] = useState<AppConfig>({ maxEmailsPerHourPerSender: 200, minSendIntervalMs: 2000 });
  const [view, setView] = useState<View>("scheduled");
  const [emails, setEmails] = useState<ScheduledEmail[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState("");
  const [searchText, setSearchText] = useState("");
  const [slack, setSlack] = useState<{ connected: boolean; teamName: string | null; configured: boolean } | null>(null);
  const [profileMenu, setProfileMenu] = useState(false);

  const loadEmails = useCallback(async (status: "scheduled" | "sent", searchQuery: string, silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const result = await api.emails(status, searchQuery);
      setEmails(result.emails);
      setTotal(result.total);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load emails.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void api.me().then((result) => setUser(result.user)).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    void Promise.all([
      api.senders().then((result) => setSenders(result.senders)),
      api.config().then(setConfig),
      api.slackStatus().then(setSlack),
      loadEmails("scheduled", ""),
    ]).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : "Could not load dashboard.");
    });
  }, [user, loadEmails]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("login_error")) setNotice({ kind: "error", message: "Sign-in could not be completed. Please try again." });
    if (params.get("slack") === "connected") {
      setNotice({ kind: "success", message: "Slack is connected. Rate-limit alerts are on." });
      void api.slackStatus().then(setSlack);
    }
    if (params.has("login_error") || params.has("slack")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!user || (view !== "scheduled" && view !== "sent")) return;
    const timer = window.setInterval(() => {
      void loadEmails(view, query, true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [user, view, query, loadEmails]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const counts = useMemo(() => ({
    scheduled: view === "scheduled" ? total : undefined,
    sent: view === "sent" ? total : undefined,
  }), [view, total]);

  const switchView = (nextView: "scheduled" | "sent"): void => {
    setView(nextView);
    setQuery("");
    setSearchText("");
    void loadEmails(nextView, "");
  };

  const onScheduled = (message: string): void => {
    setView("scheduled");
    setQuery("");
    setSearchText("");
    setNotice({ kind: "success", message });
    void loadEmails("scheduled", "");
  };

  const handleLogout = async (): Promise<void> => {
    await api.logout().catch(() => undefined);
    setUser(null);
  };

  if (!user) return <LoginScreen />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand sidebar-brand" href="/" aria-label="ReachInbox home">
          <span className="brand-mark"><Mail size={16} strokeWidth={2.2} /></span><span>reachinbox</span>
        </a>
        <div className="workspace-switcher">
          <div className="workspace-avatar">{user.name.slice(0, 1).toUpperCase()}</div>
          <div className="workspace-copy"><strong>{user.name.split(" ")[0]}'s workspace</strong><span>Personal account</span></div>
          <ChevronDown size={14} />
        </div>

        <div className="side-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Email folders">
          <button className={`nav-item ${view === "scheduled" ? "active" : ""}`} onClick={() => switchView("scheduled")}>
            <Clock3 size={17} /><span>Scheduled</span>{counts.scheduled !== undefined && <span className="nav-count">{counts.scheduled}</span>}
          </button>
          <button className={`nav-item ${view === "sent" ? "active" : ""}`} onClick={() => switchView("sent")}>
            <Send size={17} /><span>Sent</span>{counts.sent !== undefined && <span className="nav-count">{counts.sent}</span>}
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="slack-card">
            <div className="slack-card-top"><span className="slack-mark">✳</span><span>Slack alerts</span>{slack?.connected && <span className="connected-dot" />}</div>
            <p>{slack?.connected ? `Connected${slack.teamName ? ` to ${slack.teamName}` : ""}.` : "Get notified when a sender hits their limit."}</p>
            {slack?.connected ? (
              <button className="slack-action" onClick={() => void api.disconnectSlack().then(() => setSlack({ ...slack, connected: false }))}>Disconnect</button>
            ) : slack?.configured ? (
              <a className="slack-action" href="/auth/slack/connect">Connect Slack <ArrowUpRight size={12} /></a>
            ) : (
              <span className="slack-unconfigured">OAuth setup required</span>
            )}
          </div>
          <a className="queue-link" href="/admin/queues" target="_blank" rel="noreferrer"><SlidersHorizontal size={15} /> Queue dashboard <ArrowUpRight size={12} /></a>
          <div className="profile-wrap">
            <button className="profile-button" onClick={() => setProfileMenu(!profileMenu)}>
              {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="profile-initial">{user.name.slice(0, 1).toUpperCase()}</span>}
              <span className="profile-copy"><strong>{user.name}</strong><span>{user.email}</span></span>
              <ChevronDown size={14} />
            </button>
            {profileMenu && <div className="profile-menu"><button onClick={() => void handleLogout()}><LogOut size={14} /> Sign out</button></div>}
          </div>
        </div>
      </aside>

      <main className="main-panel">
        {view === "compose" ? (
          <Composer
            senders={senders}
            config={config}
            onCancel={() => setView("scheduled")}
            onScheduled={onScheduled}
            onSenderSaved={(sender) => setSenders((current) => [...current.filter((item) => item.id !== sender.id), sender])}
          />
        ) : (
          <>
            <header className="page-header">
              <div><div className="eyebrow">YOUR WORKSPACE</div><h1>{view === "scheduled" ? "Scheduled emails" : "Sent emails"}</h1><p>{view === "scheduled" ? "A clear view of everything heading out." : "Every email that has made it out the door."}</p></div>
              <button className="button button-primary compose-cta" onClick={() => setView("compose")}><Plus size={16} /> Compose new email</button>
            </header>
            <section className="email-section">
              <div className="list-toolbar">
                <div className="list-tabs">
                  <button className={view === "scheduled" ? "selected" : ""} onClick={() => switchView("scheduled")}><Clock3 size={14} /> Scheduled</button>
                  <button className={view === "sent" ? "selected" : ""} onClick={() => switchView("sent")}><Send size={14} /> Sent</button>
                </div>
                <form className="search-box" onSubmit={(event) => { event.preventDefault(); setQuery(searchText.trim()); void loadEmails(view, searchText.trim()); }}>
                  <Search size={15} /><input placeholder="Search emails…" value={searchText} onChange={(event) => setSearchText(event.target.value)} aria-label="Search emails" />
                  {searchText && <button type="button" onClick={() => { setSearchText(""); setQuery(""); void loadEmails(view, ""); }} aria-label="Clear search"><X size={14} /></button>}
                </form>
                <button className="filter-button" title="Showing all emails"><SlidersHorizontal size={15} /><span>Filter</span><ArrowDown size={12} /></button>
              </div>

              {error && <div className="page-error"><X size={15} /> {error}<button onClick={() => void loadEmails(view, query)}>Try again</button></div>}
              <div className="table-card">
                <div className="table-head">
                  <span className="checkbox-cell"><input type="checkbox" aria-label="Select all emails" /></span>
                  <span className="recipient-head">RECIPIENT</span>
                  <span>SUBJECT</span>
                  <span>{view === "scheduled" ? "SCHEDULED FOR" : "SENT AT"}</span>
                  <span>STATUS</span>
                </div>
                {loading ? (
                  <div className="table-loading"><LoaderCircle size={19} className="spin" /><span>Loading emails…</span></div>
                ) : emails.length === 0 ? (
                  <EmptyState sent={view === "sent"} query={query} />
                ) : emails.map((email) => (
                  <article className="email-row" key={email.id}>
                    <span className="checkbox-cell"><input type="checkbox" aria-label={`Select ${email.recipient}`} /></span>
                    <span className="recipient-cell"><span className="recipient-avatar">{email.recipient.slice(0, 1).toUpperCase()}</span><span className="recipient-copy"><strong>{email.recipient}</strong><small>From {email.senderEmail}</small></span></span>
                    <span className="subject-cell"><strong>{email.subject}</strong></span>
                    <span className="date-cell">{formatTime(view === "scheduled" ? email.scheduledAt : email.sentAt)}</span>
                    <span><StatusBadge status={email.status} /></span>
                    {email.status === "failed" && email.lastError && <span className="failure-detail">{email.lastError}</span>}
                  </article>
                ))}
                {!loading && emails.length > 0 && <div className="table-foot">Showing {emails.length} of {total} emails <span>Updates automatically</span></div>}
              </div>
            </section>
            <footer className="page-footer"><span><CheckCircle2 size={14} /> All systems operational</span><span>Minimum send delay: {Math.ceil(config.minSendIntervalMs / 1000)} seconds</span></footer>
          </>
        )}
      </main>
      {notice && <div className={`toast toast-${notice.kind}`}><CheckCircle2 size={17} />{notice.message}<button onClick={() => setNotice(null)} aria-label="Dismiss notification"><X size={15} /></button></div>}
    </div>
  );
}

export default App;
