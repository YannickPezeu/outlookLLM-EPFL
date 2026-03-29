import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { marked } from "marked";
import {
  Button,
  Input,
  Spinner,
  Text,
  makeStyles,
  tokens,
  Badge,
} from "@fluentui/react-components";
import { Send24Regular, Bot24Regular, Info24Regular } from "@fluentui/react-icons";
import { runAgent, type ToolProgressCallback, type StreamCallback, type LogCallback } from "../services/agentService";
import { type AgentMessage } from "../services/rcpApiService";

// ─── Markdown config ────────────────────────────────────────────────

marked.setOptions({ breaks: true, gfm: true });

// ─── Types ──────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
  logToggle: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    cursor: "pointer",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    padding: "4px 0",
    userSelect: "none",
  },
  logPanel: {
    maxHeight: "150px",
    overflow: "auto",
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: "8px",
    fontSize: "11px",
    fontFamily: "monospace",
    lineHeight: "1.4",
    whiteSpace: "pre-wrap",
    color: tokens.colorNeutralForeground2,
  },
});

// ─── Tool name mapping for UI ───────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  search_contacts: "Recherche de contacts",
  get_email_interactions: "Récupération des emails",
  summarize_email_interactions: "Résumé des échanges",
  get_calendar_events: "Consultation du calendrier",
  search_emails: "Recherche dans les emails",
};

// ─── Markdown renderer ──────────────────────────────────────────────

const MarkdownContent: React.FC<{ content: string; className?: string }> = ({
  content,
  className,
}) => {
  const html = useMemo(() => {
    let cleaned = content;
    const codeBlockMatch = cleaned.match(/^```(?:markdown)?\s*\n([\s\S]*?)(?:\n```\s*)?$/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1];
    }
    return marked.parse(cleaned) as string;
  }, [content]);

  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
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
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<AgentMessage[]>([]);

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
    setLogs([]);

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
      setStreamingContent((prev) => prev + chunk);
    };

    const onLog: LogCallback = (message) => {
      const timestamp = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setLogs((prev) => [...prev, `${timestamp} ${message}`]);
    };

    try {
      const { response, updatedHistory } = await runAgent(
        text,
        conversationRef.current,
        onToolProgress,
        onStream,
        onLog
      );

      conversationRef.current = updatedHistory;
      setMessages((prev) => [...prev, { role: "assistant", content: response }]);
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
              <MarkdownContent content={msg.content} className={styles.assistantBubble} />
            )}
          </div>
        ))}

        {/* Tool progress indicators */}
        {toolProgress.map((tp, i) => (
          <div key={`tool-${i}`} className={styles.toolIndicator}>
            {tp.status === "calling" && <Spinner size="tiny" />}
            {tp.status === "done" && <Badge appearance="filled" color="success" size="tiny" />}
            {tp.status === "error" && <Badge appearance="filled" color="danger" size="tiny" />}
            <span>{TOOL_LABELS[tp.toolName] || tp.toolName}</span>
            {tp.status === "calling" && "..."}
          </div>
        ))}

        {/* Streaming response */}
        {streamingContent && (
          <MarkdownContent content={streamingContent} className={styles.assistantBubble} />
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

      {/* Log panel */}
      {logs.length > 0 && (
        <>
          <div
            className={styles.logToggle}
            onClick={() => setShowLogs((prev) => !prev)}
          >
            <Info24Regular style={{ fontSize: "14px" }} />
            <span>{showLogs ? "Masquer" : "Afficher"} les logs ({logs.length})</span>
          </div>
          {showLogs && (
            <div className={styles.logPanel}>
              {logs.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </>
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
