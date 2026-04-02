import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Tab,
  TabList,
  Spinner,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
  Button,
  Tooltip,
} from "@fluentui/react-components";
import {
  Bot24Regular,
  CalendarLtr24Regular,
  Settings24Regular,
  OpenRegular,
} from "@fluentui/react-icons";
import { initAuth, isAuthenticated, getAccount, getGraphToken } from "../services/authService";
import { AssistantView } from "../components/AssistantView";
import { MeetingPrepView } from "../components/MeetingPrepView";
import { SettingsView } from "../components/SettingsView";
import { OutlookItemProvider, useOutlookItem } from "../components/OutlookItemContext";
import type { OutlookItemData } from "../types/dialogMessages";

/* global Office */

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
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "8px",
  },
  title: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    margin: "0",
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

type TabType = "assistant" | "meeting" | "settings";

const isInDialog = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).has("popout");
  } catch {
    return false;
  }
};

/** Read current Office item and convert to REST-format data */
const readCurrentItem = (): OutlookItemData | null => {
  try {
    const item = Office.context?.mailbox?.item;
    if (!item || !item.itemId) return null;

    let restId = item.itemId;
    try {
      restId = Office.context.mailbox.convertToRestId(
        item.itemId,
        Office.MailboxEnums.RestVersion.v2_0
      );
    } catch { /* use original */ }

    return {
      itemId: restId,
      subject: item.subject || "",
      start: item.start ? (item.start as unknown as string) : null,
      itemType: item.itemType?.toString() || "unknown",
    };
  } catch {
    return null;
  }
};

export const App: React.FC = () => {
  const inDialog = useMemo(() => isInDialog(), []);

  return (
    <OutlookItemProvider>
      <AppContent inDialog={inDialog} />
    </OutlookItemProvider>
  );
};

const AppContent: React.FC<{ inDialog: boolean }> = ({ inDialog }) => {
  const styles = useStyles();
  const [activeTab, setActiveTab] = useState<TabType>("assistant");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const dialogRef = useRef<Office.Dialog | null>(null);
  const { setItem } = useOutlookItem();

  // Open pop-out dialog
  const openPopout = async () => {
    const baseUrl = window.location.origin + window.location.pathname;

    // Build dialog URL with token and item data in hash (bypasses storage partitioning)
    const hashParams = new URLSearchParams();
    try {
      const token = await getGraphToken();
      hashParams.set("token", token);
    } catch (err) {
      console.warn("[App] Could not get Graph token for dialog:", err);
    }
    const itemData = readCurrentItem();
    if (itemData) {
      hashParams.set("item", JSON.stringify(itemData));
    }

    const dialogUrl = baseUrl + "?popout=1#" + hashParams.toString();

    Office.context.ui.displayDialogAsync(
      dialogUrl,
      { height: 80, width: 45, displayInIframe: false },
      (result) => {
        if (result.status === Office.AsyncResultStatus.Failed) {
          console.error("[App] Failed to open pop-out dialog:", result.error.message);
          return;
        }
        const dialog = result.value;
        dialogRef.current = dialog;
        dialog.addEventHandler(Office.EventType.DialogEventReceived, () => {
          dialogRef.current = null;
        });
      }
    );
  };

  useEffect(() => {
    // In dialog mode, initAuth may hang (NAA broker unavailable), so add a timeout
    const authPromise = initAuth();
    const timeoutMs = inDialog ? 5000 : 30000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Auth timeout")), timeoutMs)
    );

    Promise.race([authPromise, timeout])
      .then(() => {
        setAuthReady(true);
        setLoading(false);
      })
      .catch((err) => {
        console.warn("[App] Auth init failed:", err.message);
        if (!inDialog) {
          setError(`Auth non configuree - configurez clientId dans config.ts. L'onglet Config RCP reste accessible.`);
        }
        setLoading(false);
      });
  }, []);

  // Taskpane: listen for item changes and relay to dialog via messageChild
  useEffect(() => {
    if (inDialog) return;
    try {
      Office.context.mailbox.addHandlerAsync(
        Office.EventType.ItemChanged,
        () => {
          setTimeout(() => {
            if (!dialogRef.current) return;
            const itemData = readCurrentItem();
            try {
              dialogRef.current.messageChild(JSON.stringify({
                type: "ITEM_DATA",
                payload: itemData,
              }));
            } catch (err) {
              console.warn("[App] messageChild failed:", err);
            }
          }, 200);
        }
      );
    } catch (err) {
      console.warn("[App] Could not register ItemChanged handler:", err);
    }
  }, []);

  // Dialog: read initial token and item data from URL hash, then listen for live updates
  useEffect(() => {
    if (!inDialog) return;

    // Read initial data from URL hash (set by taskpane before opening)
    try {
      const hash = window.location.hash.slice(1);
      if (hash) {
        const params = new URLSearchParams(hash);
        const token = params.get("token");
        if (token) {
          localStorage.setItem("graph_popout_token", token);
        }
        const itemRaw = params.get("item");
        if (itemRaw) {
          setItem(JSON.parse(itemRaw));
        }
      }
    } catch (err) {
      console.warn("[Dialog] Could not read data from URL hash:", err);
    }

    // Listen for live item updates from taskpane via messageChild
    try {
      Office.context.ui.addHandlerAsync(
        Office.EventType.DialogParentMessageReceived,
        (arg: any) => {
          try {
            const msg = JSON.parse(arg.message);
            if (msg.type === "ITEM_DATA") {
              setItem(msg.payload);
            }
          } catch (err) {
            console.warn("[Dialog] Could not parse parent message:", err);
          }
        }
      );
    } catch (err) {
      console.warn("[Dialog] Could not register parent message handler:", err);
    }
  }, [inDialog, setItem]);

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
        <div className={styles.headerRow}>
          <h1 className={styles.title}>EPFL Mail AI</h1>
          {!inDialog && (
            <Tooltip content="Ouvrir dans une fenêtre dédiée" relationship="label">
              <Button
                appearance="subtle"
                icon={<OpenRegular />}
                size="small"
                onClick={openPopout}
              />
            </Tooltip>
          )}
        </div>
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
        {activeTab === "settings" && <SettingsView />}
      </div>
    </div>
  );
};
