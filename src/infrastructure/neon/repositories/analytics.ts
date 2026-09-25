import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { conversations, conversationMessages, meetings } from "../schema/conversations";

export interface WeeklyTrendPoint {
  label: string;
  replies: number;
  meetings: number;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Last 7 calendar days (UTC), oldest first. Real counts from Neon — no synthetic noise. */
export async function getWeeklyTrend(workspaceId: string): Promise<WeeklyTrendPoint[]> {
  const db = getDb();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const replyRows = await db
    .select({
      day: sql<string>`date_trunc('day', ${conversationMessages.createdAt})`,
      total: sql<number>`count(*)`,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversationMessages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversationMessages.direction, "incoming"),
        gte(conversationMessages.createdAt, since),
      ),
    )
    .groupBy(sql`date_trunc('day', ${conversationMessages.createdAt})`);

  const meetingRows = await db
    .select({
      day: sql<string>`date_trunc('day', ${meetings.createdAt})`,
      total: sql<number>`count(*)`,
    })
    .from(meetings)
    .innerJoin(conversations, eq(meetings.conversationId, conversations.id))
    .where(and(eq(conversations.workspaceId, workspaceId), gte(meetings.createdAt, since)))
    .groupBy(sql`date_trunc('day', ${meetings.createdAt})`);

  const repliesByDay = new Map(replyRows.map((row) => [new Date(row.day).toDateString(), row.total]));
  const meetingsByDay = new Map(meetingRows.map((row) => [new Date(row.day).toDateString(), row.total]));

  const points: WeeklyTrendPoint[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = date.toDateString();
    points.push({
      label: DAY_LABELS[date.getUTCDay()]!,
      replies: repliesByDay.get(key) ?? 0,
      meetings: meetingsByDay.get(key) ?? 0,
    });
  }
  return points;
}
