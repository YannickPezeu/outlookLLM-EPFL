import React, { useState, useEffect } from "react";
import {
  Tab,
  TabList,
  Spinner,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  Bot24Regular,
  CalendarLtr24Regular,
  Mail24Regular,
  PeopleChat24Regular,
  Settings24Regular,
} from "@fluentui/react-icons";
import { initAuth, isAuthenticated, getAccount } from "../services/authService";
import { AssistantView } from "../components/AssistantView";
import { MeetingPrepView } from "../components/MeetingPrepView";
import { SummarizeView } from "../components/SummarizeView";
import { InteractionsView } from "../components/InteractionsView";
import { SettingsView } from "../components/SettingsView";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    fontFamily: tokens.fontFamilyBase,
  },
  header: {
    padding: "12px 16px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  title: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    margin: "0 0 8px 0",
    color: tokens.colorBrandForeground1,
  },
  content: {
    flex: 1,
    overflow: "auto",
    padding: "16px",
  },
  center: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    height: "100%",
  },
});

type TabType = "assistant" | "meeting" | "summarize" | "interactions" | "settings";

export const App: React.FC = () => {
  const styles = useStyles();
  const [activeTab, setActiveTab] = useState<TabType>("assistant");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    initAuth()
      .then(() => {
        setAuthReady(true);
        setLoading(false);
      })
      .catch((err) => {
        // Auth failure is non-blocking: user can still configure RCP settings
        // and test the UI. Graph API features will fail gracefully.
        console.warn("[App] Auth init failed (expected if clientId not configured):", err.message);
        setError(`Auth non configuree - configurez clientId dans config.ts. L'onglet Config RCP reste accessible.`);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className={styles.center}>
        <Spinner label="Initialisation..." />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>EPFL Mail AI</h1>
        <TabList
          selectedValue={activeTab}
          onTabSelect={(_, data) => setActiveTab(data.value as TabType)}
          size="small"
        >
          <Tab value="assistant" icon={<Bot24Regular />}>
            Assistant
          </Tab>
          <Tab value="meeting" icon={<CalendarLtr24Regular />}>
            Réunion
          </Tab>
          <Tab value="summarize" icon={<Mail24Regular />}>
            Résumé
          </Tab>
          <Tab value="interactions" icon={<PeopleChat24Regular />}>
            Interactions
          </Tab>
          <Tab value="settings" icon={<Settings24Regular />}>
            Config
          </Tab>
        </TabList>
      </div>

      <div className={styles.content}>
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}

        {activeTab === "assistant" && <AssistantView />}
        {activeTab === "meeting" && <MeetingPrepView />}
        {activeTab === "summarize" && <SummarizeView />}
        {activeTab === "interactions" && <InteractionsView />}
        {activeTab === "settings" && <SettingsView />}
      </div>
    </div>
  );
};
