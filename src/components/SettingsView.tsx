import React, { useState, useEffect, useRef } from "react";
import {
  Button,
  Input,
  Text,
  Label,
  makeStyles,
  tokens,
  Badge,
  Textarea,
  InfoLabel,
  Switch,
} from "@fluentui/react-components";
import { Settings24Regular, Checkmark24Regular } from "@fluentui/react-icons";
import { saveRcpSettings, loadRcpSettings } from "../services/rcpApiService";
import { isAuthenticated, isUsingNaa, getAccount, signOut, getGraphToken } from "../services/authService";

const AVAILABLE_MODELS = [
  "moonshotai/Kimi-K2.6",
  "mistralai/Mistral-Small-3.2-24B-Instruct-2506-bfloat16",
  "openai/gpt-oss-120b",
];

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
  savedIcon: {
    color: tokens.colorPaletteGreenForeground1,
    verticalAlign: "middle",
    fontSize: "16px",
  },
  // Native <select>: the Fluent Combobox renders its listbox in a portal that gets
  // mispositioned/clipped inside the narrow Office taskpane iframe (the dropdown never
  // appears). A native select is rendered by the host and always works there.
  select: {
    width: "100%",
    height: "32px",
    padding: "0 8px",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase300,
  },
});

const CUSTOM_MODEL_VALUE = "__custom__";

export const SettingsView: React.FC = () => {
  const styles = useStyles();
  const [rcpUrl, setRcpUrl] = useState("");
  const [rcpKey, setRcpKey] = useState("");
  const [rcpModel, setRcpModel] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  // True when the user picked "Autre…" to type a model not in the preset list.
  const [customModelMode, setCustomModelMode] = useState(false);
  const [graphToken, setGraphToken] = useState("");
  // OCR for scanned PDF attachments. On unless explicitly disabled (see attachmentService).
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [saved, setSaved] = useState(false);
  // Don't persist during the initial load (when state is populated from storage),
  // otherwise the auto-save effect would fire and re-write the same values.
  const loadedRef = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const settings = loadRcpSettings();
    setRcpUrl(settings.baseUrl);
    setRcpKey(settings.apiKey);
    setRcpModel(settings.model);
    setCustomPrompt(settings.customPrompt);
    setGraphToken(localStorage.getItem("graph_dev_token") || "");
    setOcrEnabled(localStorage.getItem("ocr_enabled") !== "false");
    loadedRef.current = true;
  }, []);

  // Auto-save on every change once the initial values are loaded.
  useEffect(() => {
    if (!loadedRef.current) return;
    saveRcpSettings(rcpUrl, rcpKey, rcpModel, customPrompt);
    if (graphToken.trim()) {
      localStorage.setItem("graph_dev_token", graphToken.trim());
    } else {
      localStorage.removeItem("graph_dev_token");
    }
    // Store only the "off" state — absence of the key means OCR is on (default).
    if (ocrEnabled) localStorage.removeItem("ocr_enabled");
    else localStorage.setItem("ocr_enabled", "false");
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }, [rcpUrl, rcpKey, rcpModel, customPrompt, graphToken, ocrEnabled]);

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
              <Text size={200}>{account?.username ?? "Token dev"}</Text>
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
          <>
          <Button size="small" onClick={signOut}>
            Se déconnecter
          </Button>
          <Button size="small" onClick={async () => {
            try {
              const token = await getGraphToken();
              const pages = [];
              let url: string | null = "https://graph.microsoft.com/v1.0/me/messages?$top=100&$select=id,subject,body,bodyPreview,receivedDateTime&$orderby=receivedDateTime desc";
              while (url && pages.length < 500) {
                const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
                const j: { value?: unknown[]; "@odata.nextLink"?: string } = await r.json();
                pages.push(...(j.value || []));
                url = j["@odata.nextLink"] || null;
              }
              const blob = new Blob([JSON.stringify(pages, null, 2)], { type: "application/json" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `emails-export-${pages.length}.json`;
              a.click();
              URL.revokeObjectURL(a.href);
              console.log(`${pages.length} emails exportés !`);
            } catch (e) { console.error("Export error:", e); }
          }}>
            Exporter emails (debug)
          </Button>
          </>
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

      {/* Personnalisation — prompt utilisateur */}
      <div className={styles.section}>
        <Text weight="semibold" size={200}>
          Personnalisation
        </Text>
        <div className={styles.field}>
          <InfoLabel
            htmlFor="custom-prompt"
            size="small"
            info={
              <>
                Indiquez votre nom, votre fonction et vos besoins récurrents, notamment
                pour le résumé d'emails. Devez-vous expliquer des projets complexes à un
                membre du personnel administratif ? à un chercheur ? Précisez-le pour que
                l'IA adapte le ton et le niveau de détail de ses réponses à vos besoins.
              </>
            }
          >
            Contexte personnel (optionnel)
          </InfoLabel>
          <Textarea
            id="custom-prompt"
            resize="vertical"
            placeholder="Ex : Je suis Jean Dupont, adjoint de direction. Je résume souvent les échanges pour les transmettre à des chercheurs ; privilégie un ton clair et synthétique, et mets en avant les actions à entreprendre."
            value={customPrompt}
            onChange={(_, data) => setCustomPrompt(data.value)}
            rows={4}
          />
          <Text size={100}>
            Ce contexte est ajouté aux instructions de l'assistant et des résumés.
            Il reste stocké localement sur votre poste.
          </Text>
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
          <select
            id="rcp-model"
            className={styles.select}
            value={customModelMode || (rcpModel && !AVAILABLE_MODELS.includes(rcpModel)) ? CUSTOM_MODEL_VALUE : rcpModel}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_MODEL_VALUE) {
                setCustomModelMode(true);
              } else {
                setCustomModelMode(false);
                setRcpModel(v);
              }
            }}
          >
            {AVAILABLE_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            <option value={CUSTOM_MODEL_VALUE}>Autre (personnalisé)…</option>
          </select>
          {(customModelMode || (rcpModel && !AVAILABLE_MODELS.includes(rcpModel))) && (
            <Input
              aria-label="Modèle personnalisé"
              placeholder="Saisir un identifiant de modèle"
              value={rcpModel}
              onChange={(_, data) => setRcpModel(data.value)}
            />
          )}
        </div>

        <div className={styles.field}>
          <InfoLabel
            size="small"
            info={
              <>
                Pour les PDF scannés (sans couche texte), reconnaît le texte des
                pages-images via le modèle vision PaddleOCR-VL de l'API RCP. Ne se
                déclenche que sur les pages sans texte natif. Plus lent (~1–12 s par
                page scannée) et consomme l'API — désactivez-le si vous ne traitez
                jamais de documents scannés.
              </>
            }
          >
            OCR des pièces jointes scannées
          </InfoLabel>
          <Switch
            checked={ocrEnabled}
            onChange={(_, data) => setOcrEnabled(data.checked)}
            label={ocrEnabled ? "Activé" : "Désactivé"}
          />
        </div>

        <div className={styles.row}>
          <Text size={100} aria-live="polite">
            {saved ? (
              <>
                <Checkmark24Regular className={styles.savedIcon} /> Enregistré automatiquement
              </>
            ) : (
              "Les modifications sont enregistrées automatiquement."
            )}
          </Text>
        </div>
      </div>
    </div>
  );
};
