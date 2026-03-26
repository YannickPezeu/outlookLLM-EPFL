import React, { useState, useEffect } from "react";
import {
  Button,
  Input,
  Text,
  Label,
  makeStyles,
  tokens,
  MessageBar,
  MessageBarBody,
  Badge,
} from "@fluentui/react-components";
import { Settings24Regular, Checkmark24Regular } from "@fluentui/react-icons";
import { saveRcpSettings, loadRcpSettings } from "../services/rcpApiService";
import { isAuthenticated, isUsingNaa, getAccount, signOut } from "../services/authService";

const useStyles = makeStyles({
  container: { display: "flex", flexDirection: "column", gap: "16px" },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px",
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  field: { display: "flex", flexDirection: "column", gap: "4px" },
  row: { display: "flex", gap: "8px", alignItems: "center" },
  statusRow: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
});

export const SettingsView: React.FC = () => {
  const styles = useStyles();
  const [rcpUrl, setRcpUrl] = useState("");
  const [rcpKey, setRcpKey] = useState("");
  const [rcpModel, setRcpModel] = useState("");
  const [graphToken, setGraphToken] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const settings = loadRcpSettings();
    setRcpUrl(settings.baseUrl);
    setRcpKey(settings.apiKey);
    setRcpModel(settings.model);
    setGraphToken(localStorage.getItem("graph_dev_token") || "");
  }, []);

  const handleSave = () => {
    saveRcpSettings(rcpUrl, rcpKey, rcpModel);
    if (graphToken.trim()) {
      localStorage.setItem("graph_dev_token", graphToken.trim());
    } else {
      localStorage.removeItem("graph_dev_token");
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const account = getAccount();

  return (
    <div className={styles.container}>
      <Text size={300} weight="semibold">
        <Settings24Regular /> Configuration
      </Text>

      {/* Auth status */}
      <div className={styles.section}>
        <Text weight="semibold" size={200}>
          Authentification Microsoft
        </Text>
        <div className={styles.statusRow}>
          {isAuthenticated() ? (
            <>
              <Badge appearance="filled" color="success">
                Connecté
              </Badge>
              <Text size={200}>{account?.username}</Text>
              {isUsingNaa() && (
                <Badge appearance="outline" color="informative">
                  NAA
                </Badge>
              )}
            </>
          ) : (
            <Badge appearance="filled" color="warning">
              Non connecté
            </Badge>
          )}
        </div>
        {isAuthenticated() && (
          <Button size="small" onClick={signOut}>
            Se déconnecter
          </Button>
        )}
      </div>

      {/* Graph Dev Token */}
      <div className={styles.section}>
        <Text weight="semibold" size={200}>
          Token Graph API (dev)
        </Text>
        <Text size={100}>
          Collez un token depuis Graph Explorer pour tester sans Azure AD App Registration.
          Laissez vide pour utiliser l'auth MSAL normale.
        </Text>
        <div className={styles.field}>
          <Label htmlFor="graph-token" size="small">
            Access Token
          </Label>
          <Input
            id="graph-token"
            type="password"
            placeholder="eyJ0eXAiOiJKV1Qi..."
            value={graphToken}
            onChange={(_, data) => setGraphToken(data.value)}
          />
        </div>
      </div>

      {/* RCP API settings */}
      <div className={styles.section}>
        <Text weight="semibold" size={200}>
          API RCP (LLM)
        </Text>

        <div className={styles.field}>
          <Label htmlFor="rcp-url" size="small">
            URL de l'API
          </Label>
          <Input
            id="rcp-url"
            placeholder="https://rcp.epfl.ch"
            value={rcpUrl}
            onChange={(_, data) => setRcpUrl(data.value)}
          />
        </div>

        <div className={styles.field}>
          <Label htmlFor="rcp-key" size="small">
            Clé API
          </Label>
          <Input
            id="rcp-key"
            type="password"
            placeholder="sk-..."
            value={rcpKey}
            onChange={(_, data) => setRcpKey(data.value)}
          />
        </div>

        <div className={styles.field}>
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

        <div className={styles.row}>
          <Button
            appearance="primary"
            icon={<Checkmark24Regular />}
            onClick={handleSave}
            size="small"
          >
            Sauvegarder
          </Button>
          {saved && (
            <MessageBar intent="success">
              <MessageBarBody>Configuration sauvegardée !</MessageBarBody>
            </MessageBar>
          )}
        </div>
      </div>
    </div>
  );
};
