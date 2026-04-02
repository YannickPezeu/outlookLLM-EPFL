import React, { useState, useCallback, useRef, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  Button,
  Spinner,
  Text,
  ProgressBar,
  makeStyles,
  tokens,
  MessageBar,
  MessageBarBody,
  Card,
  CardHeader,
  Badge,
} from "@fluentui/react-components";
import {
  CalendarLtr24Regular,
  Sparkle24Regular,
  People24Regular,
  Mail24Regular,
  ArrowDownload24Regular,
} from "@fluentui/react-icons";
import {
  prepareMeeting,
  PipelineProgress,
  MeetingBriefing,
} from "../services/meetingPrepService";
import { GraphMailDataSource } from "../services/graphMailDataSource";
import { useOutlookItem } from "./OutlookItemContext";
import { exportToWord, exportToHtml } from "../services/exportService";

/* global Office */

const useStyles = makeStyles({
  container: { display: "flex", flexDirection: "column", gap: "12px" },
  progressSection: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "12px",
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  progressDetail: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  briefingBox: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    padding: "12px",
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    "& h1": { fontSize: "18px", fontWeight: 600, margin: "16px 0 8px 0", borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, paddingBottom: "4px" },
    "& h2": { fontSize: "16px", fontWeight: 600, margin: "14px 0 6px 0" },
    "& h3": { fontSize: "14px", fontWeight: 600, margin: "10px 0 4px 0" },
    "& ul, & ol": { paddingLeft: "20px", margin: "4px 0" },
    "& li": { marginBottom: "2px" },
    "& p": { margin: "4px 0" },
    "& strong": { fontWeight: 600 },
    "& hr": { border: "none", borderTop: `1px solid ${tokens.colorNeutralStroke2}`, margin: "12px 0" },
  },
  eventInfo: {
    padding: "8px 12px",
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase200,
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  participantList: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    marginTop: "4px",
  },
  statsRow: {
    display: "flex",
    gap: "12px",
    alignItems: "center",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  statItem: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
});

// Configure marked for safe rendering
marked.setOptions({ breaks: true, gfm: true });

const MarkdownRenderer: React.FC<{ content: string; className?: string }> = ({
  content,
  className,
}) => {
  const html = useMemo(() => {
    // Strip ```markdown ... ``` wrapper if the LLM wraps its output in a code block
    let cleaned = content;
    const codeBlockMatch = cleaned.match(/^```(?:markdown)?\s*\n([\s\S]*?)(?:\n```\s*)?$/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1];
    }
    const raw = marked.parse(cleaned) as string;
    return DOMPurify.sanitize(raw);
  }, [content]);
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export const MeetingPrepView: React.FC = () => {
  const styles = useStyles();
  const { item: dialogItem } = useOutlookItem();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [briefingText, setBriefingText] = useState("");
  const [briefingData, setBriefingData] = useState<MeetingBriefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eventInfo, setEventInfo] = useState<{
    subject: string;
    date: string;
    attendees: string[];
  } | null>(null);
  const abortRef = useRef(false);

  const handlePrepare = useCallback(async () => {
    setLoading(true);
    setError(null);
    setBriefingText("");
    setBriefingData(null);
    setProgress(null);
    abortRef.current = false;

    try {
      let restId: string;
      let subject: string;
      let startDate: string | null;

      if (dialogItem) {
        // Dialog mode: use data relayed from taskpane
        restId = dialogItem.itemId;
        subject = dialogItem.subject || "Réunion";
        startDate = dialogItem.start;
      } else {
        // Taskpane mode: read Office.context directly
        const item = Office.context?.mailbox?.item;
        if (!item || !item.itemId) {
          setError(
            "Aucun événement sélectionné. Ouvrez un événement calendrier dans Outlook pour préparer la réunion."
          );
          setLoading(false);
          return;
        }

        restId = item.itemId;
        try {
          restId = Office.context.mailbox.convertToRestId(
            item.itemId,
            Office.MailboxEnums.RestVersion.v2_0
          );
        } catch {
          // If conversion fails, use original ID
        }
        subject = item.subject || "Réunion";
        startDate = item.start ? (item.start as unknown as string) : null;
      }

      setEventInfo({
        subject,
        date: startDate
          ? new Date(startDate).toLocaleDateString("fr-FR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })
          : "",
        attendees: [],
      });

      // Run the pipeline
      const result = await prepareMeeting(
        new GraphMailDataSource(),
        restId,
        (prog: PipelineProgress) => {
          if (!abortRef.current) setProgress(prog);
        },
        (chunk) => {
          if (!abortRef.current) setBriefingText((prev) => prev + chunk);
        }
      );

      if (!abortRef.current) {
        setBriefingData(result);
        setEventInfo({
          subject: result.event.subject,
          date: new Date(result.event.start.dateTime).toLocaleDateString("fr-FR", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
          attendees: result.participants.map((p) => p.name),
        });
      }
    } catch (err: any) {
      if (!abortRef.current) {
        setError(err.message || "Erreur lors de la préparation");
      }
    } finally {
      if (!abortRef.current) setLoading(false);
    }
  }, [dialogItem]);

  const phaseLabel: Record<string, string> = {
    extracting_context: "Contexte",
    collecting_emails: "Collecte emails",
    embedding_ranking: "Analyse sémantique",
    reading_emails: "Lecture emails",
    summarizing_participants: "Résumés participants",
    generating_briefing: "Briefing final",
    done: "Terminé",
    error: "Erreur",
  };

  return (
    <div className={styles.container}>
      <Text size={300} weight="semibold">
        <CalendarLtr24Regular /> Préparer une réunion
      </Text>
      <Text size={200}>
        Ouvrez un événement calendrier, puis cliquez pour générer un briefing basé sur
        vos échanges email avec les participants.
      </Text>

      <Button
        appearance="primary"
        icon={<Sparkle24Regular />}
        onClick={handlePrepare}
        disabled={loading}
      >
        {loading ? "Préparation en cours..." : "Préparer cette réunion"}
      </Button>

      {/* Event info */}
      {eventInfo && (
        <div className={styles.eventInfo}>
          <strong>{eventInfo.subject}</strong>
          {eventInfo.date && <span>{eventInfo.date}</span>}
          {eventInfo.attendees.length > 0 && (
            <div className={styles.participantList}>
              {eventInfo.attendees.map((name, i) => (
                <Badge key={i} appearance="outline" size="small">
                  {name}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Progress */}
      {progress && loading && (
        <div className={styles.progressSection}>
          <div className={styles.statsRow}>
            <span className={styles.statItem}>
              <Spinner size="tiny" />
              {phaseLabel[progress.phase] || progress.phase}
            </span>
          </div>
          <ProgressBar value={progress.percent / 100} />
          <Text size={200}>{progress.message}</Text>
          {progress.detail && (
            <Text className={styles.progressDetail}>{progress.detail}</Text>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* Stats after completion */}
      {briefingData && !loading && (
        <div className={styles.statsRow}>
          <span className={styles.statItem}>
            <People24Regular />
            {briefingData.participants.length} participants
          </span>
          <span className={styles.statItem}>
            <Mail24Regular />
            {briefingData.participantBriefings.reduce(
              (sum, b) => sum + b.emailCount,
              0
            )}{" "}
            emails analysés
          </span>
        </div>
      )}

      {/* Streaming briefing output */}
      {briefingText && <MarkdownRenderer content={briefingText} className={styles.briefingBox} />}

      {/* Export buttons */}
      {briefingText && !loading && (
        <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
          <Button
            appearance="outline"
            icon={<ArrowDownload24Regular />}
            size="small"
            onClick={() => {
              const title = eventInfo?.subject || "Briefing";
              const meta = { date: eventInfo?.date, attendees: eventInfo?.attendees };
              exportToHtml(briefingText, title, meta);
            }}
          >
            HTML
          </Button>
          <Button
            appearance="outline"
            icon={<ArrowDownload24Regular />}
            size="small"
            onClick={() => {
              const title = eventInfo?.subject || "Briefing";
              const meta = { date: eventInfo?.date, attendees: eventInfo?.attendees };
              exportToWord(briefingText, title, meta);
            }}
          >
            Word
          </Button>
        </div>
      )}
    </div>
  );
};
