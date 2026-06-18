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
import { config } from "../config";
import { saveRcpSettings, loadRcpSettings } from "../services/rcpApiService";
import {
  isAuthenticated,
  isUsingNaa,
  getAccount,
  signOut,
  getGraphToken,
  acquireTokenInteractive,
  onAuthStateChanged,
} from "../services/authService";

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
  // Auth status is module-level state in authService — re-render when it changes.
  const [, setAuthTick] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // OCR for scanned PDF attachments. On unless explicitly disabled (see attachmentService).
  const [ocrEnabled, setOcrEnabled] = useState(true);
  // Default meeting participation, drives find_common_slots' include_self when the
  // request gives no explicit "avec moi"/"sans moi" signal. "unset" → assistant asks.
  const [meetingSelfDefault, setMeetingSelfDefault] = useState<"unset" | "include" | "exclude">("unset");
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
    setOcrEnabled(localStorage.getItem("ocr_enabled") !== "false");
    const self = localStorage.getItem("meeting_self_default");
    setMeetingSelfDefault(self === "include" || self === "exclude" ? self : "unset");
    loadedRef.current = true;
  }, []);

  // Refresh the auth badge whenever a token is acquired or the user signs out.
  useEffect(() => onAuthStateChanged(() => setAuthTick((t) => t + 1)), []);

  // Auto-save on every change once the initial values are loaded.
  useEffect(() => {
    if (!loadedRef.current) return;
    saveRcpSettings(rcpUrl, rcpKey, rcpModel, customPrompt);
    // Store only the "off" state — absence of the key means OCR is on (default).
    if (ocrEnabled) localStorage.removeItem("ocr_enabled");
    else localStorage.setItem("ocr_enabled", "false");
    // Absence of the key means "unset" (the assistant asks before scheduling).
    if (meetingSelfDefault === "unset") localStorage.removeItem("meeting_self_default");
    else localStorage.setItem("meeting_self_default", meetingSelfDefault);
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }, [rcpUrl, rcpKey, rcpModel, customPrompt, ocrEnabled, meetingSelfDefault]);

  const handleSignIn = async () => {
    setConnecting(true);
    setAuthError(null);
    try {
      await acquireTokenInteractive();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const handleSignOut = async () => {
    setAuthError(null);
    await signOut();
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
        {!isAuthenticated() && (
          <Button
            size="small"
            appearance="primary"
            disabled={connecting}
            onClick={handleSignIn}
          >
            {connecting ? "Connexion en cours…" : "Se connecter"}
          </Button>
        )}
        {authError && (
          <Text size={100} style={{ color: tokens.colorPaletteRedForeground1 }}>
            Échec de la connexion : {authError}
          </Text>
        )}
        {isAuthenticated() && (
          <>
          {/* Under NAA the Office broker owns the session: logoutPopup is unsupported
              and a local sign-out only strands the user in a "disconnected" state whose
              sole exit is the fragile interactive popup. Hide it there — to switch
              account the user reloads the add-in (silent SSO reconnects via the broker). */}
          {!isUsingNaa() && (
            <Button size="small" onClick={handleSignOut}>
              Se déconnecter
            </Button>
          )}
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

        <div className={styles.field}>
          <InfoLabel
            htmlFor="meeting-self-default"
            size="small"
            info={
              <>
                Quand vous demandez à organiser une réunion sans préciser « avec moi » ou
                « sans moi », l'assistant doit savoir si vous comptez parmi les participants.
                Choisissez votre cas habituel : un dirigeant participe en général aux réunions
                qu'il organise, un·e assistant·e planifie souvent pour d'autres. Tant que ce
                réglage reste « Demander à chaque fois », l'assistant vous posera la question.
                Une précision explicite dans la demande prime toujours sur ce réglage.
              </>
            }
          >
            Participation par défaut aux réunions
          </InfoLabel>
          <select
            id="meeting-self-default"
            className={styles.select}
            value={meetingSelfDefault}
            onChange={(e) =>
              setMeetingSelfDefault(e.target.value as "unset" | "include" | "exclude")
            }
          >
            <option value="unset">Demander à chaque fois</option>
            <option value="include">Je participe à la réunion</option>
            <option value="exclude">Je ne participe pas (je planifie pour d'autres)</option>
          </select>
        </div>
      </div>

      {/* RCP API settings */}
      <div className={styles.section}>
        <InfoLabel
          weight="semibold"
          size="small"
          info={
            <>
              Nécessite une clé API RCP <strong>premium</strong>. Créez-la sur le{" "}
              <a
                href="https://portal.rcp.epfl.ch/aiaas/keys"
                target="_blank"
                rel="noopener noreferrer"
              >
                portail RCP (portal.rcp.epfl.ch/aiaas/keys)
              </a>
              . La clé premium doit être validée par votre chef d'unité avant de
              pouvoir être utilisée.
            </>
          }
        >
          API RCP (LLM)
        </InfoLabel>

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

      {/* Version déployée — permet de vérifier que le cache est à jour */}
      <Text size={100} style={{ color: tokens.colorNeutralForeground3, textAlign: "center" }}>
        {config.buildTime
          ? `Version déployée le ${new Date(config.buildTime).toLocaleString("fr-CH", {
              dateStyle: "short",
              timeStyle: "short",
            })}`
          : "Build de développement local"}
      </Text>
    </div>
  );
};
