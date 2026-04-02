import React, { useState, useCallback, useRef } from "react";
import {
  Button,
  Input,
  Text,
  Label,
  Spinner,
  ProgressBar,
  MessageBar,
  MessageBarBody,
  Card,
  CardHeader,
  Badge,
  makeStyles,
  tokens,
  Divider,
} from "@fluentui/react-components";
import {
  CalendarLtr24Regular,
  Sparkle24Regular,
  People24Regular,
  Mail24Regular,
  Settings24Regular,
  Checkmark24Regular,
} from "@fluentui/react-icons";
import { getCalendarView, CalendarEvent } from "../services/graphMailService";
import {
  prepareMeeting,
  PipelineProgress,
  MeetingBriefing,
} from "../services/meetingPrepService";
import { GraphMailDataSource } from "../services/graphMailDataSource";
import { saveRcpSettings, loadRcpSettings } from "../services/rcpApiService";

const useStyles = makeStyles({
  page: {
    maxWidth: "900px",
    margin: "0 auto",
    padding: "24px",
    fontFamily: tokens.fontFamilyBase,
  },
  title: {
    fontSize: "24px",
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorBrandForeground1,
    marginBottom: "8px",
  },
  subtitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "24px",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "16px",
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    marginBottom: "16px",
  },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  field: { display: "flex", flexDirection: "column", gap: "4px" },
  row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  eventList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "300px",
    overflow: "auto",
  },
  eventCard: {
    cursor: "pointer",
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  eventCardSelected: {
    cursor: "pointer",
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
    border: `2px solid ${tokens.colorBrandStroke1}`,
  },
  eventMeta: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  participantList: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    marginTop: "4px",
  },
  progressSection: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "12px",
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  briefingBox: {
    whiteSpace: "pre-wrap",
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    padding: "16px",
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    maxHeight: "600px",
    overflow: "auto",
  },
  statsRow: {
    display: "flex",
    gap: "16px",
    alignItems: "center",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  statItem: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  savedMsg: {
    color: tokens.colorPaletteGreenForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

export const TestApp: React.FC = () => {
  const styles = useStyles();

  // Config state
  const [graphToken, setGraphToken] = useState(
    localStorage.getItem("graph_dev_token") || ""
  );
  const [rcpUrl, setRcpUrl] = useState("");
  const [rcpKey, setRcpKey] = useState("");
  const [rcpModel, setRcpModel] = useState("");
  const [configSaved, setConfigSaved] = useState(false);

  // Calendar state
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(
    null
  );

  // Pipeline state
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [briefingText, setBriefingText] = useState("");
  const [briefingData, setBriefingData] = useState<MeetingBriefing | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(false);

  // Load RCP settings on mount
  React.useEffect(() => {
    const settings = loadRcpSettings();
    setRcpUrl(settings.baseUrl);
    setRcpKey(settings.apiKey);
    setRcpModel(settings.model);
  }, []);

  const handleSaveConfig = () => {
    // Save Graph token
    if (graphToken.trim()) {
      localStorage.setItem("graph_dev_token", graphToken.trim());
    } else {
      localStorage.removeItem("graph_dev_token");
    }
    // Save RCP settings
    saveRcpSettings(rcpUrl, rcpKey, rcpModel);
    setConfigSaved(true);
    setTimeout(() => setConfigSaved(false), 2000);
  };

  const handleLoadEvents = useCallback(async () => {
    setLoadingEvents(true);
    setError(null);
    try {
      // Load events for next 30 days
      const now = new Date();
      const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const evts = await getCalendarView(
        now.toISOString(),
        future.toISOString(),
        50
      );
      setEvents(evts);
      if (evts.length === 0) {
        setError("Aucun événement trouvé dans les 30 prochains jours.");
      }
    } catch (err: any) {
      setError(err.message || "Erreur lors du chargement des événements");
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  const handleRunPipeline = useCallback(async () => {
    if (!selectedEvent) return;

    setLoading(true);
    setError(null);
    setBriefingText("");
    setBriefingData(null);
    setProgress(null);
    abortRef.current = false;

    try {
      const result = await prepareMeeting(
        new GraphMailDataSource(),
        selectedEvent.id,
        (prog: PipelineProgress) => {
          if (!abortRef.current) setProgress(prog);
        },
        (chunk) => {
          if (!abortRef.current) setBriefingText((prev) => prev + chunk);
        }
      );

      if (!abortRef.current) {
        setBriefingData(result);
      }
    } catch (err: any) {
      if (!abortRef.current) {
        setError(err.message || "Erreur lors de la préparation");
      }
    } finally {
      if (!abortRef.current) setLoading(false);
    }
  }, [selectedEvent]);

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

  const formatDate = (dateTime: string) => {
    return new Date(dateTime).toLocaleDateString("fr-FR", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.title}>EPFL Mail AI — Test Pipeline</div>
      <div className={styles.subtitle}>
        Page de test standalone (sans Outlook). Collez vos tokens, choisissez un
        événement, et testez le pipeline complet.
      </div>

      {/* ─── Config Section ─── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <Settings24Regular /> Configuration
        </div>

        <div className={styles.field}>
          <Label htmlFor="graph-token" size="small">
            Graph API Token (depuis Graph Explorer)
          </Label>
          <Input
            id="graph-token"
            type="password"
            placeholder="eyJ0eXAiOiJKV1Qi..."
            value={graphToken}
            onChange={(_, data) => setGraphToken(data.value)}
          />
        </div>

        <div className={styles.row}>
          <div className={styles.field} style={{ flex: 1 }}>
            <Label htmlFor="rcp-url" size="small">
              RCP API URL
            </Label>
            <Input
              id="rcp-url"
              placeholder="https://inference.rcp.epfl.ch/v1"
              value={rcpUrl}
              onChange={(_, data) => setRcpUrl(data.value)}
            />
          </div>
          <div className={styles.field} style={{ flex: 1 }}>
            <Label htmlFor="rcp-key" size="small">
              RCP API Key
            </Label>
            <Input
              id="rcp-key"
              type="password"
              placeholder="sk-..."
              value={rcpKey}
              onChange={(_, data) => setRcpKey(data.value)}
            />
          </div>
          <div className={styles.field} style={{ flex: 1 }}>
            <Label htmlFor="rcp-model" size="small">
              Modèle
            </Label>
            <Input
              id="rcp-model"
              placeholder="default"
              value={rcpModel}
              onChange={(_, data) => setRcpModel(data.value)}
            />
          </div>
        </div>

        <div className={styles.row}>
          <Button
            appearance="primary"
            icon={<Checkmark24Regular />}
            onClick={handleSaveConfig}
            size="small"
          >
            Sauvegarder
          </Button>
          {configSaved && (
            <span className={styles.savedMsg}>Sauvegardé !</span>
          )}
        </div>
      </div>

      {/* ─── Calendar Events ─── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <CalendarLtr24Regular /> Événements calendrier
        </div>

        <Button
          appearance="primary"
          onClick={handleLoadEvents}
          disabled={loadingEvents || !graphToken.trim()}
          size="small"
        >
          {loadingEvents ? (
            <Spinner size="tiny" />
          ) : (
            "Charger les événements (30 jours)"
          )}
        </Button>

        {!graphToken.trim() && (
          <Text size={100}>
            Configurez le Graph API Token ci-dessus d'abord.
          </Text>
        )}

        {events.length > 0 && (
          <div className={styles.eventList}>
            {events.map((evt) => (
              <div
                key={evt.id}
                className={
                  selectedEvent?.id === evt.id
                    ? styles.eventCardSelected
                    : styles.eventCard
                }
                onClick={() => setSelectedEvent(evt)}
              >
                <Text weight="semibold" size={200}>
                  {evt.subject}
                </Text>
                <div className={styles.eventMeta}>
                  {formatDate(evt.start.dateTime)}
                  {evt.location?.displayName &&
                    ` — ${evt.location.displayName}`}
                </div>
                {evt.attendees && evt.attendees.length > 0 && (
                  <div className={styles.participantList}>
                    {evt.attendees
                      .filter((a) => a.type !== "resource")
                      .map((a, i) => (
                        <Badge key={i} appearance="outline" size="small">
                          {a.emailAddress.name || a.emailAddress.address}
                        </Badge>
                      ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Pipeline ─── */}
      {selectedEvent && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <Sparkle24Regular /> Pipeline de préparation
          </div>

          <Text size={200}>
            Événement sélectionné : <strong>{selectedEvent.subject}</strong> —{" "}
            {formatDate(selectedEvent.start.dateTime)}
          </Text>

          <Button
            appearance="primary"
            icon={<Sparkle24Regular />}
            onClick={handleRunPipeline}
            disabled={loading}
          >
            {loading
              ? "Préparation en cours..."
              : "Lancer le pipeline complet"}
          </Button>

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
                <Text
                  size={100}
                  style={{ color: tokens.colorNeutralForeground3 }}
                >
                  {progress.detail}
                </Text>
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

          {/* Streaming briefing */}
          {briefingText && (
            <>
              <Divider />
              <div className={styles.briefingBox}>{briefingText}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
