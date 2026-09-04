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
import { initAuth, getGraphToken, trySilentSignIn } from "../services/authService";
import { AssistantView } from "../components/AssistantView";
import { MeetingPrepView } from "../components/MeetingPrepView";
import { SettingsView } from "../components/SettingsView";
import { OutlookItemProvider, useOutlookItem } from "../components/OutlookItemContext";
import type { OutlookItemData } from "../types/dialogMessages";
import { epflBrand } from "../theme/epflTheme";

/* global Office */

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
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
  lockup: {
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    minWidth: 0,
  },
  // The one place the vivid brand red is right: a filled mark, not text.
  // brand[110] rather than a token because Fluent's light theme never exposes
  // that rung as a foreground on light ground — see epflTheme.ts.
  logo: {
    height: "16px",
    width: "auto",
    flexShrink: 0,
    color: epflBrand[110],
  },
  rule: {
    width: "1px",
    height: "17px",
    backgroundColor: tokens.colorNeutralStroke2,
    flexShrink: 0,
  },
  title: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    margin: "0",
    // Was colorBrandForeground1. In the EPFL lockup the logo carries the red
    // and the service name is set in text colour; two reds side by side would
    // read as one long red word.
    color: tokens.colorNeutralForeground1,
    whiteSpace: "nowrap",
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

// Ctrl + wheel zoom configuration
const ZOOM_STORAGE_KEY = "epfl-mail-ai-zoom";
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.0015; // zoom change per wheel-delta unit

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
  const [zoom, setZoom] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem(ZOOM_STORAGE_KEY) || "");
    return Number.isFinite(saved) && saved >= ZOOM_MIN && saved <= ZOOM_MAX ? saved : 1;
  });
  const dialogRef = useRef<Office.Dialog | null>(null);
  const { setItem } = useOutlookItem();

  // Ctrl + mouse wheel zoom — the Office webview doesn't zoom on its own.
  // Applies a browser-like zoom to the whole task pane; Ctrl+0 resets.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z - e.deltaY * ZOOM_STEP)));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Apply the zoom to the page and persist it across remounts.
  useEffect(() => {
    (document.body.style as unknown as { zoom: string }).zoom = String(zoom);
    try {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom));
    } catch {
      // localStorage unavailable — zoom stays in memory only
    }
  }, [zoom]);

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
        // Connect by default: silent token acquisition (no popup). If it fails,
        // the Config tab shows "Non connecté" with a "Se connecter" button.
        if (!inDialog) void trySilentSignIn();
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

    // Clean up popout token when dialog closes
    const cleanup = () => localStorage.removeItem("graph_popout_token");
    window.addEventListener("beforeunload", cleanup);

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
    return () => window.removeEventListener("beforeunload", cleanup);
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
          <div className={styles.lockup}>
            {/* EPFL logo, inlined from elements/svg/epfl-logo.svg. Elements ships
                it with a `<style>.cls-1{fill:red}</style>` block; that is dropped
                here so the mark inherits `currentColor` and stays one value to
                retheme. The rule and the service name after it are the standard
                EPFL lockup for a tool that is not epfl.ch itself — which is also
                why the title loses its "EPFL " prefix: the logo says it. */}
            <svg
              className={styles.logo}
              viewBox="0 0 182.4 53"
              role="img"
              aria-label="EPFL"
              fill="currentColor"
            >
              <polygon points="0 21.6 11.43 21.6 11.43 9.8 38.34 9.8 38.34 0 0 0 0 21.6" />
              <polygon points="0 53 38.34 53 38.34 43.2 11.43 43.2 11.43 31.4 0 31.4 0 53" />
              <rect x="11.43" y="21.6" width="24.61" height="9.8" />
              <path d="M86,4.87a16.12,16.12,0,0,0-5.68-3.53A23.76,23.76,0,0,0,71.82,0H48.14V53H59.57V31.4H71.82a23.76,23.76,0,0,0,8.46-1.34A16.12,16.12,0,0,0,86,26.53a13.43,13.43,0,0,0,3.19-5,17.38,17.38,0,0,0,0-11.62A13.52,13.52,0,0,0,86,4.87ZM78,18.73a5.7,5.7,0,0,1-2.26,1.8,11.33,11.33,0,0,1-3.27.85,32,32,0,0,1-3.86.22H59.57V9.8h9.05a32,32,0,0,1,3.86.22,11,11,0,0,1,3.27.86A5.59,5.59,0,0,1,78,12.67a5,5,0,0,1,.86,3A5,5,0,0,1,78,18.73Z" />
              <polygon points="155.47 43.2 155.47 0 144.04 0 144.04 53 182.38 53 182.38 43.2 155.47 43.2" />
              <polygon points="97.42 21.6 108.85 21.6 108.85 9.8 135.76 9.8 135.76 0 97.42 0 97.42 21.6" />
              <rect x="97.42" y="31.4" width="11.43" height="21.6" />
              <rect x="108.85" y="21.6" width="24.61" height="9.8" />
            </svg>
            <span className={styles.rule} aria-hidden="true" />
            <h1 className={styles.title}>Mail AI</h1>
          </div>
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

        <div style={{ display: activeTab === "assistant" ? "contents" : "none" }}>
          <AssistantView isActive={activeTab === "assistant"} />
        </div>
        <div style={{ display: activeTab === "meeting" ? "contents" : "none" }}>
          <MeetingPrepView />
        </div>
        {activeTab === "settings" && <SettingsView />}
      </div>
    </div>
  );
};
