/**
 * Traces des outils appelés par l'assistant (« Actions de l'agent »), mises à
 * jour au fil des événements. Fonctions pures, sans React, pour être testées :
 * src/services/toolTraces.test.ts.
 */

export interface ToolTrace {
  toolName: string;
  args?: string;
  steps: string[];
  status: "calling" | "done" | "error";
  errorMsg?: string;
}

function lastIndexOf(traces: ToolTrace[], toolName: string): number {
  for (let i = traces.length - 1; i >= 0; i--) {
    if (traces[i].toolName === toolName) return i;
  }
  return -1;
}

/** Applique un événement de progression d'outil. Un appel initial (détail =
 *  arguments JSON) ouvre une trace ; une fin (done/error) clôt la PLUS
 *  ANCIENNE trace de ce nom encore en cours — avec deux appels parallèles du
 *  même outil (deux search_emails), viser la dernière faisait clore deux fois
 *  la même, et l'autre tournait à jamais. */
export function applyToolProgress(
  traces: ToolTrace[],
  toolName: string,
  status: ToolTrace["status"],
  detail?: string,
): ToolTrace[] {
  if (status === "calling" && !!detail && detail.trim().startsWith("{")) {
    return [...traces, { toolName, args: detail, steps: [], status: "calling" }];
  }
  const finishing = status === "done" || status === "error";
  const open = finishing
    ? traces.findIndex((t) => t.toolName === toolName && t.status === "calling")
    : -1;
  const idx = open >= 0 ? open : lastIndexOf(traces, toolName);
  if (idx < 0) return traces;
  const next = [...traces];
  next[idx] = {
    ...next[idx],
    status: finishing ? status : next[idx].status,
    errorMsg: status === "error" ? detail : next[idx].errorMsg,
  };
  return next;
}

/** Ajoute une étape (ligne de journal « [outil] détail ») à la dernière trace
 *  de cet outil. */
export function appendTraceStep(traces: ToolTrace[], toolName: string, step: string): ToolTrace[] {
  const idx = lastIndexOf(traces, toolName);
  if (idx < 0) return traces;
  const next = [...traces];
  next[idx] = { ...next[idx], steps: [...next[idx].steps, step] };
  return next;
}
