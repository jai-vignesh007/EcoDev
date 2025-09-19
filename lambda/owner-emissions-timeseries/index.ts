// ../lambda/owner-emissions-timeseries/index.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { Octokit } from "@octokit/rest";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

type Bucket = "day" | "week" | "month";

const ok = (body: any) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});
const bad = (code: number, body: any) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});

function parseBucket(s?: string | null): Bucket {
  if (!s) return "day";
  const v = s.toLowerCase();
  return (v === "week" || v === "month") ? v : "day";
}

function labelFor(dt: DateTime, bucket: Bucket): string {
  if (bucket === "day") return dt.toFormat("yyyy-LL-dd");
  if (bucket === "week") return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`;
  return dt.toFormat("yyyy-LL");
}

function nextStep(dt: DateTime, bucket: Bucket): DateTime {
  if (bucket === "day") return dt.plus({ days: 1 });
  if (bucket === "week") return dt.plus({ weeks: 1 });
  return dt.plus({ months: 1 });
}

export const handler = async (event: any) => {
  const LOG_PREFIX = "🔍 [OwnerTS]";
  try {
    // --- Parse path & query ---
    const { owner } = event.pathParameters || {};
    if (!owner) {
      console.error(`${LOG_PREFIX} Missing owner in pathParameters`, event.pathParameters);
      return bad(400, { error: "Missing owner" });
    }

    const qs = event.queryStringParameters || {};
    const tz = qs.tz || process.env.DEFAULT_TZ || "America/New_York";
    const bucket = parseBucket(qs.bucket);

    // Get all repositories for this owner
    let allRepos: any[] = [];
    try {
      const response = await octokit.repos.listForUser({
        username: owner,
        per_page: 100,
      });
      allRepos = response.data;
      console.log(`${LOG_PREFIX} Found ${allRepos.length} repos for ${owner}`);
    } catch (error) {
      console.error(`${LOG_PREFIX} Error fetching repos for ${owner}`, error);
      return bad(500, { error: "Failed to fetch user repositories" });
    }

    // Default window = last 365 days [from, to)
    const today = DateTime.now().setZone(tz).startOf("day");
    let from = qs.from ? DateTime.fromISO(qs.from, { zone: tz }).startOf("day") : today.minus({ days: 365 });
    let to = qs.to ? DateTime.fromISO(qs.to, { zone: tz }).startOf("day") : today.plus({ days: 1 });

    // --- Scan all workflow runs for this owner's repos ---
    let allItems: any[] = [];
    let LastEvaluatedKey: any = undefined;

    do {
      const out = await ddb.send(new ScanCommand({
        TableName: process.env.WORKFLOW_TABLE_NAME!,
        ExclusiveStartKey: LastEvaluatedKey,
      }));
      
      // Filter for this owner's repositories
      const ownerItems = (out.Items ?? []).filter(item => 
        item.repoFullName && item.repoFullName.startsWith(`${owner}/`)
      );
      
      allItems = allItems.concat(ownerItems);
      LastEvaluatedKey = out.LastEvaluatedKey;
    } while (LastEvaluatedKey);

    console.log(`${LOG_PREFIX} Fetched items for owner ${owner}`, { count: allItems.length });

    // --- Process the data ---
    const completed = allItems
      .filter(r => r.status === "completed")
      .map(r => {
        const ca = r.completedAt ? DateTime.fromISO(String(r.completedAt), { zone: "utc" }).setZone(tz) : null;
        const mg = typeof r.emissions_mg === "number" ? r.emissions_mg : null;
        const g = typeof r.emissions_g === "number" ? r.emissions_g : null;
        return { ...r, ca, emissions: mg != null ? mg / 1000 : g };
      })
      .filter(r => r.ca && typeof r.emissions === "number");

    console.log(`${LOG_PREFIX} Completed runs with emissions`, { count: completed.length });

    // --- Prepare zero-filled buckets ---
    const start = from.startOf(bucket === "day" ? "day" : bucket === "week" ? "week" : "month");
    const end = to.startOf(bucket === "day" ? "day" : bucket === "week" ? "week" : "month");
    const points: Record<string, { date: string; runs: number; completed: number; minutes: number; emissions_g: number }> = {};
    let cursor = start;
    while (cursor < end) {
      const label = labelFor(cursor, bucket);
      points[label] = { date: label, runs: 0, completed: 0, minutes: 0, emissions_g: 0 };
      cursor = nextStep(cursor, bucket);
    }

    // --- Aggregate data into buckets ---
    for (const r of completed) {
      const label = labelFor(
        (r.ca as DateTime).startOf(bucket === "day" ? "day" : bucket === "week" ? "week" : "month"),
        bucket
      );
      const p = points[label];
      if (!p) continue;
      p.completed += 1;
      if (typeof r.minutes === "number") p.minutes += r.minutes;
      p.emissions_g += r.emissions as number;
    }

    // --- Count all runs ---
    const allInWindow = allItems.filter(r => {
      const t = r.timestamp ? DateTime.fromISO(String(r.timestamp), { zone: "utc" }).setZone(tz) : null;
      return !!t && t >= from && t < to;
    });
    for (const r of allInWindow) {
      const anchor = r.completedAt
        ? DateTime.fromISO(String(r.completedAt), { zone: "utc" }).setZone(tz)
        : null;
      if (!anchor) continue;
      const label = labelFor(anchor.startOf(bucket === "day" ? "day" : bucket === "week" ? "week" : "month"), bucket);
      if (points[label]) points[label].runs += 1;
    }

    // --- Finalise series & totals ---
    const series = Object.values(points)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(p => ({ ...p, minutes: +p.minutes.toFixed(2), emissions_g: +p.emissions_g.toFixed(3) }));

    const totals = series.reduce(
      (acc, p) => ({
        runs: acc.runs + p.runs,
        completed: acc.completed + p.completed,
        minutes: +(acc.minutes + p.minutes).toFixed(2),
        emissions_g: +(acc.emissions_g + p.emissions_g).toFixed(3),
      }),
      { runs: 0, completed: 0, minutes: 0, emissions_g: 0 }
    );

    return ok({
      owner: owner,
      repositories: allRepos.map(repo => repo.full_name),
      window: { from: from.toFormat("yyyy-LL-dd"), to: to.toFormat("yyyy-LL-dd"), tz, bucket },
      totals,
      series,
      notes: [
        "Aggregated emissions across all repositories owned by this user",
        "Buckets are anchored to the local date of completedAt.",
      ],
    });
  } catch (e) {
    console.error(`${LOG_PREFIX} ERROR`, e);
    return bad(500, { error: "Failed to build owner emissions timeline" });
  }
};