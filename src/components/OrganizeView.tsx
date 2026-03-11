import React, { useState, useEffect, useCallback } from "react";
import {
  Button,
  Input,
  Text,
  Spinner,
  makeStyles,
  tokens,
  Tree,
  TreeItem,
  TreeItemLayout,
  MessageBar,
  MessageBarBody,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  DialogTrigger,
} from "@fluentui/react-components";
import {
  FolderArrowRight24Regular,
  FolderAdd24Regular,
  Sparkle24Regular,
  ArrowRight16Regular,
} from "@fluentui/react-icons";
import {
  listFolders,
  createFolder,
  moveMessage,
  type MailFolder,
} from "../services/graphMailService";
import { suggestFolder } from "../services/rcpApiService";

/* global Office */

const useStyles = makeStyles({
  container: { display: "flex", flexDirection: "column", gap: "12px" },
  folderTree: {
    maxHeight: "300px",
    overflow: "auto",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "8px",
  },
  actions: { display: "flex", gap: "8px", flexWrap: "wrap" },
  suggestion: {
    padding: "8px 12px",
    backgroundColor: tokens.colorBrandBackground2,
    borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase200,
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
});

export const OrganizeView: React.FC = () => {
  const styles = useStyles();
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(true);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load folders on mount
  const loadFolders = useCallback(async () => {
    setLoadingFolders(true);
    try {
      const result = await listFolders();
      setFolders(result);
    } catch (err: any) {
      setError(`Impossible de charger les dossiers: ${err.message}`);
    } finally {
      setLoadingFolders(false);
    }
  }, []);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  // Move current email to selected folder
  const handleMove = async () => {
    if (!selectedFolderId) return;

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const item = Office.context?.mailbox?.item;
      if (!item?.itemId) {
        setError("Aucun email sélectionné.");
        return;
      }

      // Get the REST-compatible item ID
      const itemId = Office.context.mailbox.convertToRestId(
        item.itemId,
        Office.MailboxEnums.RestVersion.v2_0
      );

      await moveMessage(itemId, selectedFolderId);
      const folderName = folders.find((f) => f.id === selectedFolderId)?.displayName;
      setSuccess(`Email déplacé vers "${folderName}" avec succès !`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Create a new folder
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;

    setLoading(true);
    setError(null);

    try {
      await createFolder(newFolderName.trim());
      setNewFolderName("");
      setShowNewFolder(false);
      await loadFolders();
      setSuccess(`Dossier "${newFolderName}" créé !`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Ask LLM to suggest a folder
  const handleSuggest = async () => {
    setLoading(true);
    setSuggestion(null);
    setError(null);

    try {
      const item = Office.context?.mailbox?.item;
      if (!item) {
        setError("Aucun email sélectionné.");
        return;
      }

      const body = await new Promise<string>((resolve, reject) => {
        item.body.getAsync(Office.CoercionType.Text, (result) => {
          if (result.status === Office.AsyncResultStatus.Succeeded) {
            resolve(result.value);
          } else {
            reject(new Error(result.error.message));
          }
        });
      });

      const folderNames = folders.map((f) => f.displayName);
      const suggested = await suggestFolder(item.subject, body, folderNames);
      setSuggestion(suggested);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <Text size={300} weight="semibold">
        <FolderArrowRight24Regular /> Organiser les emails
      </Text>

      <div className={styles.actions}>
        <Button
          icon={<Sparkle24Regular />}
          onClick={handleSuggest}
          disabled={loading}
          size="small"
        >
          Suggérer un dossier
        </Button>
        <Dialog open={showNewFolder} onOpenChange={(_, data) => setShowNewFolder(data.open)}>
          <DialogTrigger>
            <Button icon={<FolderAdd24Regular />} size="small">
              Nouveau dossier
            </Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Créer un dossier</DialogTitle>
              <DialogContent>
                <Input
                  placeholder="Nom du dossier"
                  value={newFolderName}
                  onChange={(_, data) => setNewFolderName(data.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
                />
              </DialogContent>
              <DialogActions>
                <DialogTrigger>
                  <Button appearance="secondary">Annuler</Button>
                </DialogTrigger>
                <Button
                  appearance="primary"
                  onClick={handleCreateFolder}
                  disabled={!newFolderName.trim()}
                >
                  Créer
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>

      {suggestion && (
        <div className={styles.suggestion}>
          <Sparkle24Regular />
          <span>
            Suggestion IA : <strong>{suggestion}</strong>
          </span>
          <Button
            size="small"
            appearance="primary"
            onClick={() => {
              // Find matching folder or create it
              const match = folders.find(
                (f) => f.displayName.toLowerCase() === suggestion.toLowerCase()
              );
              if (match) {
                setSelectedFolderId(match.id);
              } else {
                setNewFolderName(suggestion);
                setShowNewFolder(true);
              }
            }}
          >
            Appliquer
          </Button>
        </div>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {success && (
        <MessageBar intent="success">
          <MessageBarBody>{success}</MessageBarBody>
        </MessageBar>
      )}

      {loadingFolders ? (
        <Spinner size="small" label="Chargement des dossiers..." />
      ) : (
        <div className={styles.folderTree}>
          <Tree aria-label="Dossiers mail">
            {folders.map((folder) => (
              <TreeItem
                key={folder.id}
                itemType="leaf"
                onClick={() => setSelectedFolderId(folder.id)}
                style={{
                  backgroundColor:
                    selectedFolderId === folder.id
                      ? tokens.colorBrandBackground2
                      : undefined,
                  borderRadius: tokens.borderRadiusSmall,
                  cursor: "pointer",
                }}
              >
                <TreeItemLayout>
                  {folder.displayName} ({folder.totalItemCount})
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      )}

      <Button
        appearance="primary"
        icon={<ArrowRight16Regular />}
        onClick={handleMove}
        disabled={loading || !selectedFolderId}
      >
        {loading ? "Déplacement..." : "Déplacer l'email ici"}
      </Button>
    </div>
  );
};
