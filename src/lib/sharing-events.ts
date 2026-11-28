/**
 * Browser event fired after the share sheet changes a project's members, so
 * other panels (the agent panel's model routing) re-read project state
 * without a reload. detail: { projectId: string }.
 */
export const PROJECT_SHARING_CHANGED_EVENT = "botflow:project-sharing-changed";

export function notifyProjectSharingChanged(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROJECT_SHARING_CHANGED_EVENT, { detail: { projectId } }));
}
