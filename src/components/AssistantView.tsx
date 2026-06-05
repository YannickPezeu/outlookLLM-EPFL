import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  Button,
  Input,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  tokens,
  Badge,
} from "@fluentui/react-components";
import { Send24Regular, Bot24Regular, ArrowReset24Regular, Stop24Filled, DocumentText24Regular } from "@fluentui/react-icons";
import { runAgent, resolveEmailRef, type ToolProgressCallback, type StreamCallback, type EmailListCallback, type EmailListItem, type LogCallback } from "../services/agentService";
import { clearEmailRefs } from "../services/emailRefs";
import { loadConv, saveConv, removeConv } from "../services/convStorage";
import { Mail24Regular } from "@fluentui/react-icons";
import { type AgentMessage } from "../services/rcpApiService";

// ─── Markdown config ────────────────────────────────────────────────

const renderer = new marked.Renderer();
renderer.link = ({ href, text }: { href: string; text: string }) => {
  if (href && href.startsWith("email:")) {
    const emailId = href.slice("email:".length);
    return `<a href="#" class="email-link" data-email-id="${emailId}">📧 ${text}</a>`;
  }
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
};
marked.setOptions({ breaks: true, gfm: true, renderer });

// Disable INDENTED code blocks (lines indented 4+ spaces). The agent's multi-step
// narration ("Je vais chercher…  Pas de résultat…") often arrives indented across
// streamed iterations, and CommonMark would render the whole thing as a <pre> code
// block. We never want that in chat. Fenced code blocks (```) are untouched — they
// go through the separate `fences` tokenizer.
marked.use({
  tokenizer: {
    code() {
      return undefined;
    },
  },
});

// ─── Types ──────────────────────────────────────────────────────────

interface ToolTrace {
  toolName: string;
  args?: string;
  steps: string[];
  status: "calling" | "done" | "error";
  errorMsg?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  emailList?: { name: string; emails: EmailListItem[] };
  traces?: ToolTrace[];
}

// ─── Styles ─────────────────────────────────────────────────────────

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    gap: "0",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    paddingBottom: "8px",
  },
  messagesArea: {
    flex: 1,
    minHeight: 0, // allow the flex child to shrink and scroll INSIDE itself,
    // so the header (+ quick action) above stays pinned instead of scrolling away
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    paddingBottom: "8px",
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    padding: "8px 12px",
    borderRadius: tokens.borderRadiusMedium,
    maxWidth: "85%",
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    wordBreak: "break-word",
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: tokens.colorNeutralBackground2,
    padding: "8px 12px",
    borderRadius: tokens.borderRadiusMedium,
    maxWidth: "95%",
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    wordBreak: "break-word",
    "& h1, & h2, & h3": {
      fontSize: tokens.fontSizeBase300,
      marginTop: "8px",
      marginBottom: "4px",
    },
    "& ul, & ol": {
      paddingLeft: "16px",
      margin: "4px 0",
    },
    "& p": {
      margin: "4px 0",
    },
    // Code blocks (intended, or an accidental ``` fence the model wrapped its
    // reply in) must WRAP, not force horizontal page scroll in the narrow pane.
    "& pre": {
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      wordBreak: "break-word",
      backgroundColor: tokens.colorNeutralBackground3,
      padding: "8px",
      borderRadius: tokens.borderRadiusSmall,
      margin: "4px 0",
      maxWidth: "100%",
      overflowX: "auto",
    },
    "& code": {
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      wordBreak: "break-word",
    },
    "& .email-link": {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "2px 6px",
      borderRadius: tokens.borderRadiusSmall,
      color: tokens.colorBrandForeground1,
      textDecoration: "none",
      cursor: "pointer",
      ":hover": {
        backgroundColor: tokens.colorNeutralBackground2Hover,
        textDecoration: "underline",
      },
    },
  },
  thinking: {
    alignSelf: "flex-start",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    fontSize: tokens.fontSizeBase200,
    fontStyle: "italic",
    color: tokens.colorNeutralForeground3,
  },
  tracePanel: {
    alignSelf: "flex-start",
    width: "100%",
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    padding: "6px 10px",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    "& > summary": {
      cursor: "pointer",
      userSelect: "none",
      display: "flex",
      alignItems: "center",
      gap: "6px",
      fontWeight: tokens.fontWeightSemibold,
    },
  },
  traceTool: {
    marginTop: "6px",
    paddingLeft: "4px",
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
    paddingBlock: "2px",
  },
  traceToolHeader: {
    display: "flex",
    alignItems: "flex-start",
    gap: "6px",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground2,
    marginLeft: "4px",
    minWidth: 0,
  },
  traceToolArgs: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    opacity: 0.8,
    // Flex child: minWidth:0 lets it shrink so the text WRAPS within the panel
    // instead of forcing a horizontal scroll (default min-width:auto would keep
    // the nowrap content at full width and overflow the container).
    flex: "1 1 auto",
    minWidth: 0,
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  },
  traceSteps: {
    margin: "2px 0 4px 20px",
    padding: 0,
    listStyle: "disc",
    "& li": {
      margin: "2px 0",
      overflowWrap: "anywhere",
      wordBreak: "break-word",
    },
  },
  traceError: {
    marginLeft: "20px",
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase100,
  },
  inputArea: {
    display: "flex",
    gap: "8px",
    paddingTop: "8px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  inputField: { flex: 1 },
  suggestions: {
    display: "flex",
    gap: "6px",
    flexWrap: "wrap",
    paddingTop: "4px",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    flex: 1,
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
    padding: "20px",
  },
  emailList: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "300px",
    overflow: "auto",
    alignSelf: "flex-start",
    width: "100%",
  },
  emailItem: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    cursor: "pointer",
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    "&:hover": {
      backgroundColor: tokens.colorNeutralBackground2Hover,
    },
  },
  emailItemIcon: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  emailItemContent: {
    flex: 1,
    overflow: "hidden",
  },
  emailItemSubject: {
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  emailItemMeta: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
});

// ─── Tool name mapping for UI ───────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  search_contacts: "Recherche de contacts",
  get_email_interactions: "Récupération des emails",
  summarize_email_interactions: "Résumé des échanges",
  get_calendar_events: "Consultation du calendrier",
  search_emails: "Recherche dans les emails",
  display_emails: "Affichage de la sélection",
  prepare_meeting: "Préparation de réunion",
  identify_topic_participants: "Identification des acteurs",
  summarize_topic_status: "Point d'avancement",
  summarize_current_email: "Lecture de l'email ouvert",
  load_skill: "Chargement du savoir-faire",
  find_common_slots: "Recherche de créneaux",
};

/** True when the Office item is an editable (compose/reply) message. */
const detectComposeMode = (): boolean => {
  const item = (window as any).Office?.context?.mailbox?.item;
  return !!(item && item.body && typeof item.body.setAsync === "function");
};

// ─── Markdown renderer ──────────────────────────────────────────────

const MarkdownContent: React.FC<{
  content: string;
  className?: string;
  onEmailClick?: (emailId: string) => void;
}> = ({ content, className, onEmailClick }) => {
  const html = useMemo(() => {
    let cleaned = content;
    const codeBlockMatch = cleaned.match(/^```(?:markdown)?\s*\n([\s\S]*?)(?:\n```\s*)?$/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1];
    }
    const raw = marked.parse(cleaned) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["data-email-id"] });
  }, [content]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const link = (e.target as HTMLElement).closest(".email-link") as HTMLElement | null;
      if (link) {
        e.preventDefault();
        const emailId = link.dataset.emailId;
        if (emailId && onEmailClick) onEmailClick(emailId);
      }
    },
    [onEmailClick]
  );

  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
};

// ─── Trace panel (tool execution steps, persistent in chat) ────────

const formatToolArgs = (raw?: string): string => {
  if (!raw) return "";
  try {
    const args = JSON.parse(raw);
    const parts: string[] = [];
    if (args.topic) parts.push(`topic: "${String(args.topic).slice(0, 60)}${String(args.topic).length > 60 ? "…" : ""}"`);
    if (args.name) parts.push(`name: "${args.name}"`);
    if (args.query) parts.push(`query: "${args.query}"`);
    if (args.sender) parts.push(`from: "${args.sender}"`);
    if (args.months) parts.push(`${args.months} mois`);
    if (args.max_emails) parts.push(`max_emails: ${args.max_emails}`);
    if (args.max_people) parts.push(`max_people: ${args.max_people}`);
    if (args.start_date || args.end_date) {
      parts.push(`${args.start_date?.slice(0, 10) || "…"} → ${args.end_date?.slice(0, 10) || "…"}`);
    }
    return parts.join(", ");
  } catch {
    return "";
  }
};

const TracePanelView: React.FC<{
  traces: ToolTrace[];
  isLive?: boolean;
  styles: ReturnType<typeof useStyles>;
}> = ({ traces, isLive, styles }) => {
  if (traces.length === 0) return null;
  const totalSteps = traces.reduce((s, t) => s + t.steps.length, 0);
  const anyRunning = traces.some((t) => t.status === "calling");
  const title = isLive && anyRunning
    ? `Actions en cours — ${traces.length} outil${traces.length > 1 ? "s" : ""}, ${totalSteps} étape${totalSteps > 1 ? "s" : ""}`
    : `Actions de l'agent — ${traces.length} outil${traces.length > 1 ? "s" : ""}, ${totalSteps} étape${totalSteps > 1 ? "s" : ""}`;
  return (
    <details className={styles.tracePanel} open={isLive}>
      <summary>
        {anyRunning ? <Spinner size="tiny" /> : <Badge appearance="filled" color="success" size="tiny" />}
        <span>{title}</span>
      </summary>
      {traces.map((t, i) => {
        const argsText = formatToolArgs(t.args);
        return (
          <div key={i} className={styles.traceTool}>
            <div className={styles.traceToolHeader}>
              {t.status === "calling" && <Spinner size="tiny" />}
              {t.status === "done" && <Badge appearance="filled" color="success" size="tiny" />}
              {t.status === "error" && <Badge appearance="filled" color="danger" size="tiny" />}
              <span style={{ fontWeight: 600 }}>{TOOL_LABELS[t.toolName] || t.toolName}</span>
              {argsText && <span className={styles.traceToolArgs}>— {argsText}</span>}
            </div>
            {t.steps.length > 0 && (
              <ul className={styles.traceSteps}>
                {t.steps.map((s, j) => <li key={j}>{s}</li>)}
              </ul>
            )}
            {t.status === "error" && t.errorMsg && (
              <div className={styles.traceError}>Erreur : {t.errorMsg}</div>
            )}
          </div>
        );
      })}
    </details>
  );
};

// ─── Suggestions ────────────────────────────────────────────────────

const SUGGESTIONS = [
  "Résume mes échanges avec ",
  "Quelles sont mes prochaines réunions ?",
  "Cherche des emails sur ",
];

// ─── Component ──────────────────────────────────────────────────────

// Persist chat across remounts AND across surfaces. Outlook loads the task pane
// as a separate instance per surface (read pane vs reply/compose window). The
// conversation is stored via OfficeRuntime.storage (shared across surfaces and
// persistent on web + desktop) with a localStorage mirror for instant initial
// paint and cross-instance live-sync — see services/convStorage.ts.
const CONV_STORAGE_KEY = "epfl-mail-ai-conversation";

interface PersistedConv {
  messages: ChatMessage[];
  conversation: AgentMessage[];
}

function loadPersistedConv(): PersistedConv {
  try {
    const raw = localStorage.getItem(CONV_STORAGE_KEY);
    if (!raw) return { messages: [], conversation: [] };
    const data = JSON.parse(raw);
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      conversation: Array.isArray(data.conversation) ? data.conversation : [],
    };
  } catch {
    return { messages: [], conversation: [] };
  }
}

export const AssistantView: React.FC<{ isActive?: boolean }> = ({ isActive = true }) => {
  const styles = useStyles();
  const initialConv = useMemo(() => loadPersistedConv(), []);
  const [messages, setMessages] = useState<ChatMessage[]>(initialConv.messages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [liveTraces, setLiveTraces] = useState<ToolTrace[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [isCompose, setIsCompose] = useState(detectComposeMode);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const conversationRef = useRef<AgentMessage[]>(initialConv.conversation);
  const pendingEmailListRef = useRef<{ name: string; emails: EmailListItem[] } | null>(null);
  const tracesRef = useRef<ToolTrace[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Persist messages + LLM history whenever the chat changes.
  // conversationRef is set just before setMessages in handleSend, so by the
  // time this effect runs (post-render), both are in sync.
  useEffect(() => {
    if (messages.length === 0) {
      void removeConv(CONV_STORAGE_KEY);
      return;
    }
    void saveConv(
      CONV_STORAGE_KEY,
      JSON.stringify({ messages, conversation: conversationRef.current })
    );
  }, [messages]);

  // Reconcile with OfficeRuntime.storage on mount. The synchronous initial load
  // (loadPersistedConv) reads localStorage for instant paint, but on desktop the
  // localStorage may be isolated/empty while OfficeRuntime.storage holds the real
  // shared conversation — so adopt it if we currently have nothing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const raw = await loadConv(CONV_STORAGE_KEY);
      if (cancelled || !raw) return;
      try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data.messages) || data.messages.length === 0) return;
        setMessages((prev) => {
          if (prev.length > 0) return prev; // already populated (sync load or user input)
          conversationRef.current = Array.isArray(data.conversation) ? data.conversation : [];
          return data.messages;
        });
      } catch {
        // ignore malformed payloads
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live-sync the conversation across task-pane instances (e.g. the read pane
  // stays pinned while a reply window opens its own instance). The storage event
  // fires in the OTHER instances when one updates localStorage. Skip while a turn
  // is running here so we don't disrupt an in-progress stream.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== CONV_STORAGE_KEY || e.newValue == null || loading) return;
      try {
        const data = JSON.parse(e.newValue);
        if (Array.isArray(data.messages)) {
          conversationRef.current = Array.isArray(data.conversation) ? data.conversation : [];
          setMessages(data.messages);
        }
      } catch {
        // ignore malformed payloads
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [loading]);
  // Accumulates every streamed chunk of the turn (tool outputs + final agent reply)
  // so the final persisted message contains the full text, not just runAgent.response.
  const streamBufferRef = useRef("");

  // Auto-scroll only on discrete events (new user message, final assistant message).
  // Do NOT scroll during streaming or trace updates — let the user scroll freely
  // to read at their own pace while the response is being generated.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-focus input when tab becomes active
  useEffect(() => {
    if (isActive && !loading) {
      inputRef.current?.focus();
    }
  }, [isActive, loading]);

  // Re-check read vs compose surface once mounted (Office may be loading at first render)
  useEffect(() => {
    setIsCompose(detectComposeMode());
  }, []);

  const handleSend = useCallback(async (overrideText?: string) => {
    const text = (typeof overrideText === "string" ? overrideText : input).trim();
    if (!text || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    tracesRef.current = [];
    setLiveTraces([]);
    setStreamingContent("");
    streamBufferRef.current = "";

    const findLastTraceIdx = (toolName: string): number => {
      for (let i = tracesRef.current.length - 1; i >= 0; i--) {
        if (tracesRef.current[i].toolName === toolName) return i;
      }
      return -1;
    };

    const updateTraces = (updater: (prev: ToolTrace[]) => ToolTrace[]) => {
      tracesRef.current = updater(tracesRef.current);
      setLiveTraces(tracesRef.current);
    };

    const onToolProgress: ToolProgressCallback = (toolName, status, detail) => {
      const isInitialCall = status === "calling" && !!detail && detail.trim().startsWith("{");
      if (isInitialCall) {
        updateTraces((prev) => [...prev, { toolName, args: detail, steps: [], status: "calling" }]);
        return;
      }
      const idx = findLastTraceIdx(toolName);
      if (idx < 0) return;
      updateTraces((prev) => {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          status: status === "done" || status === "error" ? status : next[idx].status,
          errorMsg: status === "error" ? detail : next[idx].errorMsg,
        };
        return next;
      });
    };

    const onLog: LogCallback = (msg) => {
      const match = msg.match(/^\[([^\]]+)\] ([\s\S]+)$/);
      if (!match) return;
      const prefix = match[1];
      const rest = match[2];
      if (prefix === "Agent") return;
      const idx = findLastTraceIdx(prefix);
      if (idx < 0) return;
      updateTraces((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], steps: [...next[idx].steps, rest] };
        return next;
      });
    };

    const onStream: StreamCallback = (chunk) => {
      if (chunk === null) {
        setStreamingContent("");
        streamBufferRef.current = "";
      } else {
        streamBufferRef.current += chunk;
        setStreamingContent(streamBufferRef.current);
      }
    };

    const onEmailList: EmailListCallback = (name, emails) => {
      pendingEmailListRef.current = { name, emails };
    };

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const { response, updatedHistory } = await runAgent(
        text,
        conversationRef.current,
        onToolProgress,
        onStream,
        onLog,
        onEmailList,
        controller.signal
      );

      conversationRef.current = updatedHistory;
      const emailList = pendingEmailListRef.current;
      pendingEmailListRef.current = null;
      const finalTraces = tracesRef.current;
      // Use the full streamed buffer (tool output + final agent reply) as the
      // persisted content, falling back to runAgent's response if nothing was streamed.
      const persistedContent = streamBufferRef.current || response;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: persistedContent,
          emailList: emailList || undefined,
          traces: finalTraces.length > 0 ? finalTraces : undefined,
        },
      ]);
      setStreamingContent("");
      streamBufferRef.current = "";
      tracesRef.current = [];
      setLiveTraces([]);
    } catch (err: any) {
      const wasAborted = err?.name === "AbortError" || controller.signal.aborted;
      const finalTraces = tracesRef.current;
      // Mark any still-running tool traces as errored so the UI doesn't keep spinning.
      if (wasAborted) {
        for (const t of finalTraces) {
          if (t.status === "calling") {
            t.status = "error";
            t.errorMsg = "Arrêté par l'utilisateur";
          }
        }
      }
      const partial = streamBufferRef.current;
      const content = wasAborted
        ? (partial ? `${partial}\n\n_⏹ Arrêté par l'utilisateur._` : "_⏹ Arrêté par l'utilisateur._")
        : `**Erreur :** ${err?.message || "Erreur inattendue"}`;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content,
          traces: finalTraces.length > 0 ? finalTraces : undefined,
        },
      ]);
      setStreamingContent("");
      streamBufferRef.current = "";
      tracesRef.current = [];
      setLiveTraces([]);
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
    }
  }, [input, loading]);

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const handleSuggestion = (suggestion: string) => {
    setInput(suggestion);
  };

  const handleEmailClick = (emailIdOrRef: string) => {
    try {
      // Resolve short refs (ref_0, ref_1...) to real Graph API IDs
      const emailId = resolveEmailRef(emailIdOrRef) ?? emailIdOrRef;

      // Office.js API to open an email in Outlook
      const mailbox = (window as any).Office?.context?.mailbox;
      if (mailbox?.displayMessageForm) {
        mailbox.displayMessageForm(emailId);
      } else {
        console.warn("[AssistantView] Office.context.mailbox.displayMessageForm not available");
      }
    } catch (err) {
      console.error("[AssistantView] Error opening email:", err);
    }
  };

  const isEmpty = messages.length === 0;

  const handleReset = useCallback(() => {
    setMessages([]);
    setInput("");
    tracesRef.current = [];
    setLiveTraces([]);
    setStreamingContent("");
    conversationRef.current = [];
    pendingEmailListRef.current = null;
    void removeConv(CONV_STORAGE_KEY);
    clearEmailRefs();
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Bot24Regular />
        <Text size={300} weight="semibold">
          Assistant EPFL Mail
        </Text>
        <div style={{ marginLeft: "auto" }}>
          {!isEmpty && (
            <Tooltip content="Nouvelle conversation" relationship="label">
              <Button
                appearance="subtle"
                icon={<ArrowReset24Regular />}
                size="small"
                onClick={handleReset}
                disabled={loading}
              />
            </Tooltip>
          )}
        </div>
      </div>

      <div className={styles.messagesArea}>
        {/* Quick action at the START of the conversation — inside the scroll area,
            so it simply scrolls away with the content (no need to hide it). */}
        {!isCompose && (
          <div style={{ display: "flex" }}>
            <Tooltip content="Résume le mail actuellement ouvert dans Outlook (corps + pièces jointes), puis continue la discussion" relationship="label">
              <Button
                size="small"
                appearance="outline"
                icon={<DocumentText24Regular />}
                disabled={loading}
                onClick={() =>
                  handleSend(
                    "Résume l'email actuellement ouvert dans Outlook (corps et pièces jointes compris)."
                  )
                }
              >
                Résumer l'email ouvert
              </Button>
            </Tooltip>
          </div>
        )}

        {isEmpty && (
          <div className={styles.emptyState}>
            <Bot24Regular style={{ fontSize: "32px" }} />
            <Text size={300}>Posez une question sur vos emails ou votre calendrier</Text>
            <Text size={200}>
              Par exemple : "Résume mes échanges avec Dupont" ou "Quelles réunions cette semaine ?"
            </Text>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === "user" ? (
              <div className={styles.userBubble}>{msg.content}</div>
            ) : (
              <>
                {msg.traces && msg.traces.length > 0 && (
                  <TracePanelView traces={msg.traces} styles={styles} />
                )}
                {msg.content && (
                  <MarkdownContent content={msg.content} className={styles.assistantBubble} onEmailClick={handleEmailClick} />
                )}
                {msg.emailList && (
                  <div className={styles.emailList}>
                    {msg.emailList.emails.map((email, j) => (
                      <div
                        key={j}
                        className={styles.emailItem}
                        onClick={() => handleEmailClick(email.id)}
                      >
                        <span className={styles.emailItemIcon}>
                          {email.direction === "sent" ? (
                            <Send24Regular style={{ fontSize: "16px" }} />
                          ) : (
                            <Mail24Regular style={{ fontSize: "16px" }} />
                          )}
                        </span>
                        <div className={styles.emailItemContent}>
                          <div className={styles.emailItemSubject}>{email.subject}</div>
                          <div className={styles.emailItemMeta}>
                            {email.direction === "sent" ? "→" : "←"} {email.from} · {new Date(email.date).toLocaleDateString("fr-FR")}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {/* Live tool trace (during current turn) */}
        {liveTraces.length > 0 && (
          <TracePanelView traces={liveTraces} isLive styles={styles} />
        )}

        {/* "Thinking" indicator: the LLM is running an inference (deciding the next
            tool or composing the answer) with nothing streaming yet and no tool
            currently executing — otherwise the UI looks frozen during that gap. */}
        {loading && !streamingContent &&
          !(liveTraces[liveTraces.length - 1]?.status === "calling") && (
          <div className={styles.thinking}>
            <Spinner size="tiny" />
            <span>Réflexion en cours…</span>
          </div>
        )}

        {/* Streaming response */}
        {streamingContent && (
          <MarkdownContent content={streamingContent} className={styles.assistantBubble} onEmailClick={handleEmailClick} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggestions (only when empty) */}
      {isEmpty && (
        <div className={styles.suggestions}>
          {SUGGESTIONS.map((s, i) => (
            <Button
              key={i}
              size="small"
              appearance="outline"
              onClick={() => handleSuggestion(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      <div className={styles.inputArea}>
        <Input
          className={styles.inputField}
          input={{ ref: inputRef }}
          placeholder="Posez votre question..."
          value={input}
          onChange={(_, data) => setInput(data.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          disabled={loading}
        />
        {loading ? (
          <Tooltip content="Arrêter" relationship="label">
            <Button
              appearance="primary"
              icon={<Stop24Filled />}
              onClick={handleStop}
            />
          </Tooltip>
        ) : (
          <Button
            appearance="primary"
            icon={<Send24Regular />}
            onClick={() => handleSend()}
            disabled={!input.trim()}
          />
        )}
      </div>
    </div>
  );
};
