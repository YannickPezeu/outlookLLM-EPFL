import React, { useState, useCallback } from "react";
import {
  Button,
  Input,
  Spinner,
  Text,
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Badge,
} from "@fluentui/react-components";
import { PeopleChat24Regular, Search24Regular } from "@fluentui/react-icons";
import { getAllInteractions, type EmailMessage } from "../services/graphMailService";
import { summarizeInteractions } from "../services/rcpApiService";

/* global Office */

const useStyles = makeStyles({
  container: { display: "flex", flexDirection: "column", gap: "12px" },
  inputRow: { display: "flex", gap: "8px", alignItems: "end" },
  inputField: { flex: 1 },
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
  stats: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  },
  streamText: {
    whiteSpace: "pre-wrap",
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
  },
});

export const InteractionsView: React.FC = () => {
  const styles = useStyles();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState("");
  const [stats, setStats] = useState<{ received: number; sent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from currently open email's sender
  const prefillFromCurrentEmail = useCallback(() => {
    try {
      const item = Office.context?.mailbox?.item;
      if (item?.from?.emailAddress) {
        setEmail(item.from.emailAddress);
      }
    } catch {
      // Not in Outlook context (dev mode)
    }
  }, []);

  // Auto-prefill on mount
  React.useEffect(() => {
    prefillFromCurrentEmail();
  }, [prefillFromCurrentEmail]);

  const handleSummarize = async () => {
    if (!email.trim()) return;

    setLoading(true);
    setError(null);
    setSummary("");
    setStats(null);

    try {
      // Step 1: Fetch all interactions via Graph API
      const { received, sent } = await getAllInteractions(email.trim());
      setStats({ received: received.length, sent: sent.length });

      if (received.length === 0 && sent.length === 0) {
        setSummary("Aucun email trouvé avec cette adresse.");
        setLoading(false);
        return;
      }

      // Step 2: Extract content for LLM
      const receivedData = received.map((e) => ({
        subject: e.subject,
        body: e.bodyPreview || e.body?.content || "",
        date: e.receivedDateTime,
      }));

      const sentData = sent.map((e) => ({
        subject: e.subject,
        body: e.bodyPreview || e.body?.content || "",
        date: e.sentDateTime || e.receivedDateTime,
      }));

      // Extract name from first received email, fallback to email address
      const personName = received[0]?.from?.emailAddress?.name || email;

      // Step 3: Stream summary from RCP API
      await summarizeInteractions(
        personName,
        email,
        receivedData,
        sentData,
        (chunk) => {
          setSummary((prev) => prev + chunk);
        }
      );
    } catch (err: any) {
      setError(err.message || "Erreur lors de la récupération des emails");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <Text size={300} weight="semibold">
        <PeopleChat24Regular /> Résumé des interactions
      </Text>
      <Text size={200}>
        Entrez l'adresse email d'un contact pour obtenir un résumé de tous vos échanges.
      </Text>

      <div className={styles.inputRow}>
        <Input
          className={styles.inputField}
          placeholder="prenom.nom@epfl.ch"
          value={email}
          onChange={(_, data) => setEmail(data.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSummarize()}
          disabled={loading}
        />
        <Button
          appearance="primary"
          icon={<Search24Regular />}
          onClick={handleSummarize}
          disabled={loading || !email.trim()}
        >
          {loading ? "Analyse..." : "Analyser"}
        </Button>
      </div>

      {loading && <Spinner size="small" label="Recherche et analyse en cours..." />}

      {error && (
        <Card>
          <CardHeader header={<Text color="red">{error}</Text>} />
        </Card>
      )}

      {stats && (
        <div className={styles.stats}>
          <Badge appearance="filled" color="informative">
            {stats.received} reçus
          </Badge>
          <Badge appearance="filled" color="success">
            {stats.sent} envoyés
          </Badge>
        </div>
      )}

      {summary && <div className={styles.resultBox}>{summary}</div>}
    </div>
  );
};
