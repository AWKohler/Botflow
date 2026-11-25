"use client";

import { useEffect, useId, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button, buttonClass } from "@/components/ui/button";

export interface DeletableProject {
  id: string;
  name: string;
  backendType: string | null;
  convexProjectId: string | null;
}

/** What DELETE /api/projects/[id] reports about the user's own Convex project. */
export interface UserConvexProjectReport {
  slug: string;
  dashboardUrl: string;
  deleted: boolean;
  error?: string;
}

/** The project has a Convex project in the user's own Convex account. */
export function hasOwnConvexProject(project: DeletableProject) {
  return project.backendType === "user" && Boolean(project.convexProjectId);
}

/**
 * Confirms deleting a project. When the project has its own Convex project in
 * the user's Convex account, it asks whether to delete that too (on by
 * default: usually it is no longer wanted, but its data may be). If deleting
 * the Convex project fails, the dialog stays open to say so and links to it.
 */
export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: DeletableProject | null;
  onClose: () => void;
  /**
   * Called once the Botflow project is gone (also when its Convex project was
   * kept). Do not clear `project` here: the dialog may still be showing what
   * happened to the Convex project. Clear it in `onClose`.
   */
  onDeleted: (projectId: string, convex: UserConvexProjectReport | undefined) => void;
}) {
  const [deleteConvex, setDeleteConvex] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keptConvex, setKeptConvex] = useState<UserConvexProjectReport | null>(null);
  const checkboxId = useId();

  // A fresh question for every project.
  useEffect(() => {
    setDeleteConvex(true);
    setBusy(false);
    setError(null);
    setKeptConvex(null);
  }, [project?.id]);

  if (!project) return null;
  const ownConvex = hasOwnConvexProject(project);
  const platformDatabase = project.backendType === "platform" && Boolean(project.convexProjectId);

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const query = ownConvex && deleteConvex ? "?deleteConvexProject=true" : "";
      const res = await fetch(`/api/projects/${project.id}${query}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        cleanup?: { userConvexProject?: UserConvexProjectReport };
      };
      if (!res.ok) {
        setError(body.error === "Not found" ? "This project no longer exists, or only its owner can delete it." : (body.error ?? "The project could not be deleted. Try again."));
        return;
      }
      const convex = body.cleanup?.userConvexProject;
      onDeleted(project.id, convex);
      if (ownConvex && deleteConvex && convex && !convex.deleted) {
        // The project is gone, but its Convex project is not: say why, and where it is.
        setKeptConvex(convex);
        return;
      }
      onClose();
    } catch {
      setError("The project could not be deleted. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (keptConvex) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Project deleted, Convex project kept"
        footer={
          <>
            <a
              href={keptConvex.dashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({ variant: "secondary" })}
            >
              Open Convex dashboard
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <Button variant="primary" onClick={onClose} data-autofocus>
              Done
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-fg">
          &ldquo;{project.name}&rdquo; is deleted from Botflow.{" "}
          {keptConvex.error ?? "Its Convex project could not be deleted."}
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          You can delete <code className="rounded bg-elevated px-1 py-0.5 text-[12px]">{keptConvex.slug}</code> yourself
          in the Convex dashboard, under the project&rsquo;s settings.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={close}
      dismissable={!busy}
      title={<>Delete &ldquo;{project.name}&rdquo;?</>}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} disabled={busy} data-autofocus>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? "Deleting…" : "Delete project"}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-muted">
        This deletes the project&rsquo;s code, chats, preview and published site from Botflow. It can&rsquo;t be undone.
        {platformDatabase && " Its database, hosted by Botflow, is deleted with it."}
      </p>
      {ownConvex && (
        <div className="mt-4 rounded-xl border border-border bg-surface px-4 py-3">
          <div className="flex items-start gap-3">
            <input
              id={checkboxId}
              type="checkbox"
              checked={deleteConvex}
              onChange={(e) => setDeleteConvex(e.target.checked)}
              disabled={busy}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-danger-solid"
            />
            <label htmlFor={checkboxId} className="min-w-0 cursor-pointer">
              <span className="block text-[13px] font-medium text-fg">Also delete its Convex project</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted">
                <code className="rounded bg-elevated px-1 py-0.5 text-[12px]">{project.convexProjectId}</code> in your
                Convex account, with all its data: tables, files and user accounts.{" "}
                {deleteConvex
                  ? "Uncheck to keep it in your Convex account."
                  : "It stays in your Convex account; you can delete it there later."}
              </span>
            </label>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
