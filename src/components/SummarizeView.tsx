import React, { useState, useCallback } from "react";
import {
  Button,
  Spinner,
  Text,
  makeStyles,
  tokens,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { Mail24Regular, Sparkle24Regular } from "@fluentui/react-icons";
import { summarizeEmail } from "../services/rcpApiService";

/* global Office */

const useStyles = makeStyles({
  container: { display: "flex", flexDirection: "column", gap: "12px" },
  resultBox: {
    whiteSpace: "pre-wrap",
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    padding: "12px",
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    maxHeight: "400px",
    overflow: "auto",
  },
  emailInfo: {
    padding: "8px 12px",
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase200,
  },
});

export const SummarizeView: React.FC = () => {
  const styles = useStyles();
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState("");
  const [emailSubject, setEmailSubject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSummarize = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSummary("");

    try {
      const item = Office.context?.mailbox?.item;
      if (!item) {
        setError("Aucun email sélectionné. Ouvrez un email pour le résumer.");
        setLoading(false);
        return;
      }

      setEmailSubject(item.subject);

      // Read the email body
      const body = await new Promise<string>((resolve, reject) => {
        item.body.getAsync(Office.CoercionType.Text, (result) => {
          if (result.status === Office.AsyncResultStatus.Succeeded) {
            resolve(result.value);
          } else {
            reject(new Error(result.error.message));
          }
        });
      });

      if (!body.trim()) {
        setSummary("L'email est vide.");
        setLoading(false);
        return;
      }

      // Stream summary from RCP
      await summarizeEmail(body, (chunk) => {
        setSummary((prev) => prev + chunk);
      });
    } catch (err: any) {
      setError(err.message || "Erreur lors du résumé");
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className={styles.container}>
      <Text size={300} weight="semibold">
        <Mail24Regular /> Résumer l'email courant
      </Text>
      <Text size={200}>
        Cliquez pour obtenir un résumé IA de l'email actuellement ouvert.
      </Text>

      <Button
        appearance="primary"
        icon={<Sparkle24Regular />}
        onClick={handleSummarize}
        disabled={loading}
      >
        {loading ? "Résumé en cours..." : "Résumer cet email"}
      </Button>

      {loading && <Spinner size="small" label="Analyse en cours..." />}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {emailSubject && (
        <div className={styles.emailInfo}>
          <strong>Sujet :</strong> {emailSubject}
        </div>
      )}

      {summary && <div className={styles.resultBox}>{summary}</div>}
    </div>
  );
};
