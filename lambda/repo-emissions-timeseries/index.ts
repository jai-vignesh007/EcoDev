import { Octokit } from "@octokit/rest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

type Bucket = "day" | "week" | "month";

const ok = (body: any) => ({
  statusCode: 200,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  },
  body: JSON.stringify(body)
});

const bad = (statusCode: number, body: any) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  },
  body: JSON.stringify(body)
});

const parseBucket = (s?: string | null): Bucket => {
  if (!s) return "day";
  const normalized = s.toLowerCase();
  return normalized === "week" || normalized === "month" ? normalized as Bucket : "day";
};

const labelFor = (dt: DateTime, bucket: Bucket) => {
  if (bucket === "day") return dt.toFormat("yyyy-LL-dd");
  if (bucket === "week") return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`;
  return dt.toFormat("yyyy-LL");
};

const step = (dt: DateTime, bucket: Bucket) => {
  if (bucket === "day") return dt.plus({ days: 1 });
  if (bucket === "week") return dt.plus({ weeks: 1 });
  return dt.plus({ months: 1 });
};

export const handler = async (event: any) => {
  const LOG_PREFIX = "📊 [RepoTS]";

  try {
    // CHANGE THIS: Use 'name' instead of 'repo' to match your API Gateway
    const { owner, name } = event.pathParameters || {}; // ← Changed from 'repo' to 'name'
    
    if (!owner || !name) {
      console.error(`${LOG_PREFIX} Missing owner or name`, event.pathParameters);
      return bad(400, { error: "Missing owner or name" });
    }

    const qs = event.queryStringParameters || {};
    const timezone = qs.tz || process.env.DEFAULT_TZ || "America/New_York";
    const bucket = parseBucket(qs.bucket);
    const branchFilter = qs.branch ?? null;
    const eventFilter = qs.event ?? null;
    const workflowFilter = qs.workflow ?? null;

    const today = DateTime.now().setZone(timezone).startOf("day");
    let from = qs.from ? DateTime.fromISO(qs.from, { zone: timezone }).startOf("day") : today.minus({ days: 365 });
    let to = qs.to ? DateTime.fromISO(qs.to, { zone: timezone }).startOf("day") : today.plus({ days: 1 });

    // CHANGE THIS: Use 'name' instead of 'repo'
    const repoFullName = `${owner}/${name}`; // ← Changed from 'repo' to 'name'
    
    console.log(`${LOG_PREFIX} Processing repo`, { repoFullName, from: from.toISO(), to: to.toISO() });
    // Fetch workflow runs from DynamoDB for THIS SPECIFIC REPO only
    let workflowRuns: any[] = [];
    let LastEvaluatedKey: any = undefined;
    
    do {
      const out = await ddb.send(new QueryCommand({
        TableName: process.env.WORKFLOW_TABLE_NAME!,
        KeyConditionExpression: "repoFullName = :r",
        ExpressionAttributeValues: { ":r": repoFullName },
        ExclusiveStartKey: LastEvaluatedKey
      }));
      workflowRuns = workflowRuns.concat(out.Items ?? []);
      LastEvaluatedKey = out.LastEvaluatedKey;
    } while (LastEvaluatedKey);

    console.log(`${LOG_PREFIX} Raw workflow runs fetched`, { count: workflowRuns.length });

    // Process and filter runs
    const processedRuns = workflowRuns
      .filter((run: any) => run.status === "completed")
      .map((run: any) => {
        const completedAt = run.completedAt ? DateTime.fromISO(String(run.completedAt), { zone: "utc" }).setZone(timezone) : null;
        const emissionsMg = typeof run.emissions_mg === "number" ? run.emissions_mg : null;
        const emissionsG = typeof run.emissions_g === "number" ? run.emissions_g : null;
        const emissions = emissionsMg != null ? emissionsMg / 1000 : emissionsG;
        const minutes = typeof run.minutes === "number" ? run.minutes : 0;
        return {
          completedAt,
          emissions,
          minutes,
          branch: run.branch,
          event: run.event,
          workflowName: run.workflowName,
          runId: run.runId || run.id
        };
      })
      .filter(run => run.completedAt !== null && typeof run.emissions === "number") // Fixed null check
      .filter(run => (branchFilter ? run.branch === branchFilter : true))
      .filter(run => (eventFilter ? run.event === eventFilter : true))
      .filter(run => (workflowFilter ? run.workflowName === workflowFilter : true));

    console.log(`${LOG_PREFIX} Processed runs with emissions`, { 
      totalRuns: workflowRuns.length, 
      completedWithEmissions: processedRuns.length,
      sampleRun: processedRuns[0] 
    });

    let windowAdjusted = false;
    if (!qs.from && !qs.to) {
      const anyInWindow = processedRuns.some(run => run.completedAt! >= from && run.completedAt! < to);
      if (!anyInWindow && processedRuns.length > 0) {
        const earliest = processedRuns.reduce((min, run) => run.completedAt! < min ? run.completedAt! : min, processedRuns[0].completedAt!);
        from = earliest.startOf("day");
        const candidate = from.plus({ days: 365 });
        to = candidate < today.plus({ days: 1 }) ? candidate : today.plus({ days: 1 });
        windowAdjusted = true;
        console.log(`${LOG_PREFIX} Window adjusted`, { from: from.toISO(), to: to.toISO() });
      }
    }

    // Create time buckets
    const start = from.startOf(bucket);
    const end = to.startOf(bucket);
    const bucketPoints: Record<string, { date: string; runs: number; completed: number; minutes: number; emissions_g: number }> = {};
    let cursor = start;
    while (cursor < end) {
      const label = labelFor(cursor, bucket);
      bucketPoints[label] = { date: label, runs: 0, completed: 0, minutes: 0, emissions_g: 0 };
      cursor = step(cursor, bucket);
    }

    console.log(`${LOG_PREFIX} Time buckets created`, { bucketCount: Object.keys(bucketPoints).length });

    // Aggregate data into buckets
    for (const run of processedRuns) {
      const completedAt = run.completedAt!;
      if (completedAt < from || completedAt >= to) continue;
      
      const label = labelFor(completedAt.startOf(bucket), bucket);
      const point = bucketPoints[label];
      if (!point) continue;
      
      point.completed += 1;
      point.minutes += run.minutes;
      point.emissions_g += run.emissions;
      point.runs += 1;
    }

    const series = Object.values(bucketPoints)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(p => ({ ...p, minutes: +p.minutes.toFixed(2), emissions_g: +p.emissions_g.toFixed(3) }));

    const totals = series.reduce(
      (acc, p) => ({
        runs: acc.runs + p.runs,
        completed: acc.completed + p.completed,
        minutes: +(acc.minutes + p.minutes).toFixed(2),
        emissions_g: +(acc.emissions_g + p.emissions_g).toFixed(3)
      }),
      { runs: 0, completed: 0, minutes: 0, emissions_g: 0 }
    );

    console.log(`${LOG_PREFIX} Final aggregation`, { 
      seriesLength: series.length, 
      totals,
      windowAdjusted 
    });

    return ok({
      repo: repoFullName,
      window: { 
        from: from.toFormat("yyyy-LL-dd"), 
        to: to.toFormat("yyyy-LL-dd"), 
        tz: timezone, 
        bucket 
      },
      windowAdjusted,
      totals,
      series,
      notes: [
        "This endpoint returns data for ONLY the specified repository.",
        "Data is not aggregated across other repositories owned by the same user."
      ]
    });
  } catch (e) {
    console.error(`${LOG_PREFIX} ERROR`, e);
    return bad(500, { error: "Failed to build repo emissions timeline" });
  }
};