/**
 * Record a user's answer to an in-chat askQuestion tool call.
 *
 * Body: { toolCallId, selectedIds, selectedLabels?, text?, dismissed? }
 *   • toolCallId — matches the chat_questions row created by the agent's
 *                  askQuestion tool execute.
 *   • selectedIds — option ids the user picked. Required unless dismissed.
 *   • selectedLabels — denormalized labels so the agent can read them
 *                       without dereferencing option ids. Provided by the
 *                       UI from the active question's options.
 *   • text — optional custom free-form answer (when allowCustom).
 *   • dismissed — true if the user cancelled / skipped.
 *
 * On success the row is marked `answered` (or `dismissed`); the agent's
 * polling execute unblocks within ~2 seconds and the agent's next turn
 * sees the structured answer.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatQuestions, projects } from "@/db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AnswerBody {
  toolCallId?: string;
  questionId?: string; // Allow lookup by row id too (for Claude Code path)
  selectedIds?: string[];
  selectedLabels?: string[];
  text?: string;
  dismissed?: boolean;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = getDb();
    const [proj] = await db.select().from(projects).where(eq(projects.id, id));
    if (!proj || proj.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = (await req.json()) as AnswerBody;
    if (!body.toolCallId && !body.questionId) {
      return NextResponse.json(
        { error: "toolCallId or questionId is required" },
        { status: 400 },
      );
    }

    const whereClause = body.toolCallId
      ? and(eq(chatQuestions.projectId, id), eq(chatQuestions.toolCallId, body.toolCallId))
      : and(eq(chatQuestions.projectId, id), eq(chatQuestions.id, body.questionId!));

    // Resolve the target row. The Claude Code paths (MCP ask_question and the
    // native AskUserQuestion bridged through canUseTool) key their row by a
    // synthetic server-side toolCallId the client never sees — the stream
    // carries the SDK's tool_use id instead — so when the exact lookup misses
    // we fall back to the project's most recent pending question.
    let [target] = await db
      .select({ id: chatQuestions.id })
      .from(chatQuestions)
      .where(whereClause)
      .limit(1);
    if (!target) {
      [target] = await db
        .select({ id: chatQuestions.id })
        .from(chatQuestions)
        .where(and(eq(chatQuestions.projectId, id), eq(chatQuestions.status, "pending")))
        .orderBy(desc(chatQuestions.createdAt))
        .limit(1);
    }
    if (!target) return NextResponse.json({ error: "Question not found" }, { status: 404 });
    // Only resolve a still-pending question — a late answer must not clobber a
    // dismissed one, and a late dismiss must not clobber an answered one. If the
    // row is already resolved the update affects 0 rows → 404 below (no-op).
    const targetClause = and(eq(chatQuestions.id, target.id), eq(chatQuestions.status, "pending"));

    if (body.dismissed) {
      const [updated] = await db
        .update(chatQuestions)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(targetClause)
        .returning();
      if (!updated) return NextResponse.json({ error: "Question not found" }, { status: 404 });
      return NextResponse.json({ ok: true, status: "dismissed" });
    }

    const answer = {
      selectedIds: body.selectedIds ?? [],
      selectedLabels: body.selectedLabels ?? [],
      text: body.text ?? null,
    };
    const [updated] = await db
      .update(chatQuestions)
      .set({
        status: "answered",
        answer: answer as unknown as object,
        updatedAt: new Date(),
      })
      .where(targetClause)
      .returning();
    if (!updated) return NextResponse.json({ error: "Question not found" }, { status: 404 });
    return NextResponse.json({ ok: true, status: "answered" });
  } catch (err) {
    console.error("POST /chat/questions/answer failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to record answer" },
      { status: 500 },
    );
  }
}
