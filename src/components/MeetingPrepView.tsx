import React, { useState, useCallback, useRef, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  Button,
  Spinner,
  Text,
  Tooltip,
  ProgressBar,
  makeStyles,
  tokens,
  MessageBar,
  MessageBarBody,
  Card,
  CardHeader,
  Badge,
  Switch,
} from "@fluentui/react-components";
import {
  CalendarLtr24Regular,
  Sparkle24Regular,
  People24Regular,
  Mail24Regular,
  ArrowDownload24Regular,
  ArrowReset24Regular,
} from "@fluentui/react-icons";
import {
  prepareMeeting,
  PipelineProgress,
  MeetingBriefing,
} from "../services/meetingPrepService";
import { GraphMailDataSource } from "../services/graphMailDataSource";
import { useOutlookItem } from "./OutlookItemContext";
import { exportToWord, exportToHtml, exportMeetingReport, exportDecisionReport } from "../services/exportService";

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
  logPanel: {
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
  logList: {
    margin: "6px 0 4px 0",
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  logEntry: {
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
    fontSize: tokens.fontSizeBase100,
    lineHeight: tokens.lineHeightBase200,
  },
  logPhase: {
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground3,
    minWidth: "150px",
  },
  logMessage: {
    color: tokens.colorNeutralForeground2,
    flex: 1,
    wordBreak: "break-word",
  },
  logDetail: {
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
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

const NOT_APPOINTMENT_MSG =
  "L'élément ouvert n'est pas un événement calendrier (c'est probablement un email). " +
  "Ouvrez un événement dans Outlook, ou demandez à l'Assistant de préparer une réunion par son nom.";

/** Whether an Office item type string designates a calendar appointment. */
const isAppointment = (itemType: unknown): boolean =>
  String(itemType).toLowerCase().includes("appointment");

/**
 * Resolve an item's EWS id. In read mode `item.itemId` is available
 * synchronously, but in the calendar organizer/attendee form (compose surface)
 * it is null and must be fetched via getItemIdAsync.
 */
const getItemEwsId = (item: any): Promise<string | null> =>
  new Promise((resolve) => {
    if (item?.itemId) {
      resolve(item.itemId);
      return;
    }
    if (typeof item?.getItemIdAsync === "function") {
      item.getItemIdAsync((res: Office.AsyncResult<string>) => {
        resolve(res.status === Office.AsyncResultStatus.Succeeded ? res.value : null);
      });
    } else {
      resolve(null);
    }
  });

export const MeetingPrepView: React.FC = () => {
  const styles = useStyles();
  const { item: dialogItem } = useOutlookItem();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [progressLog, setProgressLog] = useState<Array<{ phase: string; message: string; detail?: string; ts: number }>>([]);
  const [briefingText, setBriefingText] = useState("");
  const [briefingData, setBriefingData] = useState<MeetingBriefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eventInfo, setEventInfo] = useState<{
    subject: string;
    date: string;
    attendees: string[];
  } | null>(null);
  // Report depth + period to look back over (defaults: soft, last 6 months).
  const [mode, setMode] = useState<"soft" | "deep">("soft");
  const [startDate, setStartDate] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const abortRef = useRef(false);

  const handlePrepare = useCallback(async () => {
    setLoading(true);
    setError(null);
    setBriefingText("");
    setBriefingData(null);
    setProgress(null);
    setProgressLog([]);
    abortRef.current = false;

    try {
      let restId: string;
      let subject: string;
      let startDate: string | null;

      if (dialogItem) {
        // Dialog mode: use data relayed from taskpane
        if (!isAppointment(dialogItem.itemType)) {
          setError(NOT_APPOINTMENT_MSG);
          setLoading(false);
          return;
        }
        restId = dialogItem.itemId;
        subject = typeof dialogItem.subject === "string" ? dialogItem.subject : "Réunion";
        startDate = typeof dialogItem.start === "string" ? dialogItem.start : null;
      } else {
        // Taskpane mode: read Office.context directly
        const item = Office.context?.mailbox?.item;
        if (!item) {
          setError(
            "Aucun événement sélectionné. Ouvrez un événement calendrier dans Outlook pour préparer la réunion."
          );
          setLoading(false);
          return;
        }

        // Guard: this pipeline reads a calendar event (/me/events/{id}). Viewing
        // an email here would 404 against /me/events with a confusing error.
        if (!isAppointment(item.itemType)) {
          setError(NOT_APPOINTMENT_MSG);
          setLoading(false);
          return;
        }

        // In compose surfaces (organizer/attendee form), item.subject and
        // item.start are async-getter OBJECTS, not plain values — using them
        // directly would render an object and crash React. The real subject/date
        // come from Graph (extractContext) anyway; use safe placeholders here.
        subject = typeof item.subject === "string" ? item.subject : "Réunion";
        startDate = typeof item.start === "string" ? item.start : null;

        // In the organizer/attendee form (compose surface), item.itemId is null;
        // the EWS id must be fetched asynchronously via getItemIdAsync.
        const ewsId = await getItemEwsId(item);
        if (!ewsId) {
          setError(
            "Impossible de récupérer l'identifiant de cet événement. " +
            "S'il vient d'être créé, enregistrez-le d'abord, puis réessayez."
          );
          setLoading(false);
          return;
        }
        restId = ewsId;
        try {
          restId = Office.context.mailbox.convertToRestId(
            ewsId,
            Office.MailboxEnums.RestVersion.v2_0
          );
        } catch {
          // If conversion fails, use original ID
        }
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
          if (abortRef.current) return;
          setProgress(prog);
          setProgressLog((prev) => {
            // Skip exact-duplicate consecutive messages (same phase + same text + same detail)
            const last = prev[prev.length - 1];
            if (last && last.phase === prog.phase && last.message === prog.message && last.detail === prog.detail) return prev;
            return [...prev, { phase: prog.phase, message: prog.message, detail: prog.detail, ts: Date.now() }];
          });
        },
        (chunk) => {
          if (!abortRef.current) setBriefingText((prev) => prev + chunk);
        },
        {
          mode,
          startISO: startDate ? `${startDate}T00:00:00Z` : undefined,
          endISO: endDate ? `${endDate}T23:59:59Z` : undefined,
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
  }, [dialogItem, mode, startDate, endDate]);

  const handleReset = useCallback(() => {
    setBriefingText("");
    setBriefingData(null);
    setProgress(null);
    setProgressLog([]);
    setError(null);
    setEventInfo(null);
    abortRef.current = true;
  }, []);

  const phaseLabel: Record<string, string> = {
    extracting_context: "Contexte",
    collecting_emails: "Collecte emails",
    embedding_ranking: "Analyse sémantique",
    filtering_emails: "Chargement en contexte",
    searching_nonparticipants: "Recherche hors participants",
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

      {/* Options : profondeur + période */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "8px 0" }}>
        <Switch
          checked={mode === "deep"}
          disabled={loading}
          onChange={(_, d) => setMode(d.checked ? "deep" : "soft")}
          label={
            mode === "deep"
              ? "Analyse approfondie — décisions majeures + synthèse (plus long)"
              : "Briefing global rapide"
          }
        />
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <Text size={200}>Période :</Text>
          <input
            type="date"
            value={startDate}
            max={endDate}
            disabled={loading}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <Text size={200}>→</Text>
          <input
            type="date"
            value={endDate}
            min={startDate}
            disabled={loading}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <Button
          appearance="primary"
          icon={<Sparkle24Regular />}
          onClick={handlePrepare}
          disabled={loading}
          style={{ flex: 1 }}
        >
          {loading ? "Préparation en cours..." : "Préparer cette réunion"}
        </Button>
        {briefingText && !loading && (
          <Tooltip content="Réinitialiser" relationship="label">
            <Button
              appearance="subtle"
              icon={<ArrowReset24Regular />}
              size="medium"
              onClick={handleReset}
            />
          </Tooltip>
        )}
      </div>

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

      {/* Persistent log of all pipeline steps — visible during AND after the run */}
      {progressLog.length > 0 && (
        <details className={styles.logPanel} open={loading}>
          <summary>
            Étapes du pipeline — {progressLog.length} évènement{progressLog.length > 1 ? "s" : ""}
          </summary>
          <ul className={styles.logList}>
            {progressLog.map((entry, i) => (
              <li key={i} className={styles.logEntry}>
                <span className={styles.logPhase}>[{phaseLabel[entry.phase] || entry.phase}]</span>
                <span className={styles.logMessage}>
                  {entry.message}
                  {entry.detail && <span className={styles.logDetail}> — {entry.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
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
              // Prefer the structured, source-linked report:
              //  - deep → decisions-style report (major decisions + synthesis)
              //  - soft → briefing + per-participant sources
              // Fall back to the plain briefing export.
              if (briefingData?.decisionReport) {
                exportDecisionReport(briefingData.decisionReport);
              } else if (briefingData?.report) {
                exportMeetingReport(briefingData.report);
              } else {
                const title = eventInfo?.subject || "Briefing";
                const meta = { date: eventInfo?.date, attendees: eventInfo?.attendees };
                exportToWord(briefingText, title, meta);
              }
            }}
          >
            Word
          </Button>
        </div>
      )}
    </div>
  );
};
