/**
 * Data about the currently selected Outlook item,
 * sent from the taskpane to the pop-out dialog via messageChild.
 */
export interface OutlookItemData {
  /** REST-format item ID (already converted via convertToRestId) */
  itemId: string;
  /** Item subject line */
  subject: string;
  /** ISO 8601 start time (calendar items) or null (mail items) */
  start: string | null;
  /** "message" or "appointment" */
  itemType: string;
}

/**
 * Envelope for messages sent from taskpane to dialog.
 * Discriminated union allows adding new message types later.
 */
export type TaskpaneToDialogMessage =
  | { type: "ITEM_DATA"; payload: OutlookItemData }
  | { type: "ITEM_CLEARED" }
  | { type: "GRAPH_TOKEN"; token: string };
