import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  Button,
  Input,
  Spinner,
  Text,
  makeStyles,
  tokens,
  Badge,
} from "@fluentui/react-components";
import { Send24Regular, Bot24Regular } from "@fluentui/react-icons";
import { runAgent, resolveEmailRef, type ToolProgressCallback, type StreamCallback, type EmailListCallback, type EmailListItem } from "../services/agentService";
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

// ─── Types ──────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  emailList?: { name: string; emails: EmailListItem[] };
}

interface ToolProgress {
  toolName: string;
  status: "calling" | "done" | "error";
  detail?: string;
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
  toolIndicator: {
    alignSelf: "flex-start",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 8px",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
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
  show_emails: "Affichage des emails",
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

// ─── Suggestions ────────────────────────────────────────────────────

const SUGGESTIONS = [
  "Résume mes échanges avec ",
  "Quelles sont mes prochaines réunions ?",
  "Cherche des emails sur ",
];

// ─── Component ──────────────────────────────────────────────────────

export const AssistantView: React.FC = () => {
  const styles = useStyles();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [toolProgress, setToolProgress] = useState<ToolProgress[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<AgentMessage[]>([]);
  const pendingEmailListRef = useRef<{ name: string; emails: EmailListItem[] } | null>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, toolProgress, streamingContent]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    setToolProgress([]);
    setStreamingContent("");

    const onToolProgress: ToolProgressCallback = (toolName, status, detail) => {
      setToolProgress((prev) => {
        const existing = prev.findIndex((t) => t.toolName === toolName);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = { toolName, status, detail };
          return updated;
        }
        return [...prev, { toolName, status, detail }];
      });
    };

    const onStream: StreamCallback = (chunk) => {
      if (chunk === null) {
        setStreamingContent("");
      } else {
        setStreamingContent((prev) => prev + chunk);
      }
    };

    const onEmailList: EmailListCallback = (name, emails) => {
      pendingEmailListRef.current = { name, emails };
    };

    try {
      const { response, updatedHistory } = await runAgent(
        text,
        conversationRef.current,
        onToolProgress,
        onStream,
        undefined,
        onEmailList
      );

      conversationRef.current = updatedHistory;
      const emailList = pendingEmailListRef.current;
      pendingEmailListRef.current = null;
      setMessages((prev) => [...prev, { role: "assistant", content: response, emailList: emailList || undefined }]);
      setStreamingContent("");
      setToolProgress([]);
    } catch (err: any) {
      const errorMsg = err.message || "Erreur inattendue";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `**Erreur :** ${errorMsg}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

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

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Bot24Regular />
        <Text size={300} weight="semibold">
          Assistant EPFL Mail
        </Text>
      </div>

      <div className={styles.messagesArea}>
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

        {/* Tool progress indicators */}
        {toolProgress.map((tp, i) => {
          // Format tool args for display
          let argsDisplay = "";
          if (tp.detail) {
            try {
              const args = JSON.parse(tp.detail);
              const parts: string[] = [];
              if (args.name) parts.push(args.name);
              if (args.query) parts.push(`"${args.query}"`);
              if (args.start_date || args.end_date) {
                const from = args.start_date?.slice(0, 10) || "...";
                const to = args.end_date?.slice(0, 10) || "...";
                parts.push(`${from} → ${to}`);
              }
              if (parts.length > 0) argsDisplay = ` (${parts.join(", ")})`;
            } catch { /* ignore */ }
          }
          return (
            <div key={`tool-${i}`} className={styles.toolIndicator}>
              {tp.status === "calling" && <Spinner size="tiny" />}
              {tp.status === "done" && <Badge appearance="filled" color="success" size="tiny" />}
              {tp.status === "error" && <Badge appearance="filled" color="danger" size="tiny" />}
              <span>{TOOL_LABELS[tp.toolName] || tp.toolName}{argsDisplay}</span>
              {tp.status === "calling" && "..."}
            </div>
          );
        })}

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
          placeholder="Posez votre question..."
          value={input}
          onChange={(_, data) => setInput(data.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          disabled={loading}
        />
        <Button
          appearance="primary"
          icon={<Send24Regular />}
          onClick={handleSend}
          disabled={loading || !input.trim()}
        />
      </div>
    </div>
  );
};
