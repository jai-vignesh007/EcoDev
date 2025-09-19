import { Octokit } from "@octokit/rest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

type Bucket = "day" | "week" | "month";

const ok = (b:any)=>({statusCode:200,headers:{ "Content-Type":"application/json","Access-Control-Allow-Origin":"*" },body:JSON.stringify(b)});
const bad = (c:number,b:any)=>({statusCode:c,headers:{ "Content-Type":"application/json","Access-Control-Allow-Origin":"*" },body:JSON.stringify(b)});

const parseBucket = (s?:string|null):Bucket => (!s ? "day" : (s.toLowerCase()==="week"||s.toLowerCase()==="month")? s.toLowerCase() as Bucket : "day");
const labelFor = (dt:DateTime, bucket:Bucket)=> bucket==="day"?dt.toFormat("yyyy-LL-dd"): bucket==="week"?`${dt.weekYear}-W${String(dt.weekNumber).padStart(2,"0")}`:dt.toFormat("yyyy-LL");
const step = (dt:DateTime,bucket:Bucket)=> bucket==="day"?dt.plus({days:1}):bucket==="week"?dt.plus({weeks:1}):dt.plus({months:1});

export const handler = async (event:any) => {
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
    const branch = qs.branch ?? null;
    const eventFilter = qs.event ?? null;
    const workflowFilter = qs.workflow ?? null;

    // Default window = last 365 days [from, to)
    const today = DateTime.now().setZone(tz).startOf("day");
    let from = qs.from ? DateTime.fromISO(qs.from, { zone: tz }).startOf("day") : today.minus({ days: 365 });
    let to   = qs.to   ? DateTime.fromISO(qs.to,   { zone: tz }).startOf("day") : today.plus({ days: 1 });

    console.log(`${LOG_PREFIX} Input`, {
      owner, tz, bucket, from: from.toISODate(), to: to.toISODate(),
      filters: { branch, event: eventFilter, workflow: workflowFilter }
    });

    // --- Discover repos for this owner (user and/or org) ---
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || undefined });
    let repos:any[] = [];
    try {
      const userRepos = await octokit.paginate(octokit.repos.listForUser, { username: owner, per_page: 100, sort: "updated" });
      repos = repos.concat(userRepos);
      console.log(`${LOG_PREFIX} listForUser repos`, { count: userRepos.length });
    } catch (e) {
      console.warn(`${LOG_PREFIX} listForUser failed (owner may be org)`, String(e));
    }
    try {
      const orgRepos = await octokit.paginate(octokit.repos.listForOrg, { org: owner, per_page: 100, sort: "updated" });
      repos = repos.concat(orgRepos);
      console.log(`${LOG_PREFIX} listForOrg repos`, { count: orgRepos.length });
    } catch (e) {
      console.warn(`${LOG_PREFIX} listForOrg failed (owner may be user)`, String(e));
    }

    // De-dupe by full_name
    const names = Array.from(new Map(repos.map(r => [r.full_name, r])).keys());
    console.log(`${LOG_PREFIX} Unique repos resolved`, { count: names.length });

    if (names.length === 0) {
      console.log(`${LOG_PREFIX} No repos found for owner`);
      return ok({
        owner,
        window: { from: from.toFormat("yyyy-LL-dd"), to: to.toFormat("yyyy-LL-dd"), tz, bucket },
        windowAdjusted: false,
        totals: { runs:0, completed:0, minutes:0, emissions_g:0 },
        series: []
      });
    }

    // --- Load runs per repo; collect completed runs with emissions ---
    const completedByRepo: Record<string, { ca: DateTime, emissions: number, minutes: number }[]> = {};
    let totalItemsScanned = 0;
    for (const fullName of names) {
      let items:any[] = [];
      let LastEvaluatedKey:any = undefined;
      do {
        const out = await ddb.send(new QueryCommand({
          TableName: process.env.WORKFLOW_TABLE_NAME!,
          KeyConditionExpression: "repoFullName = :r",
          ExpressionAttributeValues: { ":r": fullName },
          ExclusiveStartKey: LastEvaluatedKey,
        }));
        items = items.concat(out.Items ?? []);
        LastEvaluatedKey = out.LastEvaluatedKey;
      } while (LastEvaluatedKey);
      totalItemsScanned += items.length;

      const arr = items
        .filter(r => r.status === "completed")
        .map(r => {
          const ca = r.completedAt ? DateTime.fromISO(String(r.completedAt), { zone: "utc" }).setZone(tz) : null;
          const mg = typeof r.emissions_mg === "number" ? r.emissions_mg : null;
          const g  = typeof r.emissions_g === "number"  ? r.emissions_g  : null;
          const minutes = typeof r.minutes === "number" ? r.minutes : 0;
          return { ca, emissions: mg != null ? mg/1000 : g, minutes, branch: r.branch, event: r.event, workflowName: r.workflowName };
        })
        .filter(r => r.ca && typeof r.emissions === "number")
        .filter(r => (branch ? r.branch === branch : true))
        .filter(r => (eventFilter ? r.event === eventFilter : true))
        .filter(r => (workflowFilter ? r.workflowName === workflowFilter : true));

      completedByRepo[fullName] = arr as any[];
      console.log(`${LOG_PREFIX} Repo processed`, {
        repo: fullName,
        items: items.length,
        completedWithEmissions: arr.length
      });
    }
    console.log(`${LOG_PREFIX} Total items scanned across repos`, { totalItemsScanned });

    // --- Fallback: if no data in default window, shift to earliest occurrence across all repos ---
    let windowAdjusted = false;
    if (!qs.from && !qs.to) {
      const anyInWindow = Object.values(completedByRepo).some(arr =>
        arr.some(r => (r.ca as DateTime) >= from && (r.ca as DateTime) < to)
      );
      if (!anyInWindow) {
        const all = Object.values(completedByRepo).flat();
        if (all.length > 0) {
          const earliest = all.reduce(
            (min, r) => ((r.ca as DateTime) < min ? (r.ca as DateTime) : min),
            all[0].ca as DateTime
          );
          from = earliest.startOf("day");
          const candidate = from.plus({ days: 365 });
          to = candidate < today.plus({ days: 1 }) ? candidate : today.plus({ days: 1 });
          windowAdjusted = true;
          console.log(`${LOG_PREFIX} Window adjusted to first occurrence across repos`, {
            earliest: earliest.toISO(),
            from: from.toISODate(),
            to: to.toISODate(),
          });
        }
      }
    }

    // --- Prepare zero-filled bucket map ---
    const start = from.startOf(bucket === "day" ? "day" : bucket === "week" ? "week" : "month");
    const end   = to.startOf(bucket === "day" ? "day" : bucket === "week" ? "week" : "month");
    const points: Record<string, { date:string; runs:number; completed:number; minutes:number; emissions_g:number }> = {};
    let cur = start;
    while (cur < end) {
      const label = labelFor(cur, bucket);
      points[label] = { date: label, runs: 0, completed: 0, minutes: 0, emissions_g: 0 };
      cur = step(cur, bucket);
    }
    console.log(`${LOG_PREFIX} Buckets initialised`, { bucketCount: Object.keys(points).length });

    // --- Aggregate completed emissions & minutes into buckets ---
    let completedTotal = 0;
    for (const arr of Object.values(completedByRepo)) {
      for (const r of arr) {
        const d = r.ca as DateTime;
        if (d < from || d >= to) continue;
        const label = labelFor(d.startOf(bucket === "day" ? "day" : bucket === "week" ? "week" : "month"), bucket);
        const p = points[label]; if (!p) continue;
        p.completed += 1;
        p.minutes += r.minutes || 0;
        p.emissions_g += r.emissions || 0;
        completedTotal++;
      }
    }
    console.log(`${LOG_PREFIX} Aggregated completed runs`, { completedTotal });

    // --- Approximate 'runs' count using completed anchors (optional refinement later) ---
    for (const arr of Object.values(completedByRepo)) {
      for (const r of arr) {
        const d = r.ca as DateTime;
        if (d < from || d >= to) continue;
        const label = labelFor(d.startOf(bucket === "day" ? "day" : bucket === "week" ? "week" : "month"), bucket);
        const p = points[label]; if (!p) continue;
        p.runs += 1;
      }
    }

    // --- Finalise series & totals ---
    const series = Object.values(points)
      .sort((a,b)=>a.date.localeCompare(b.date))
      .map(p=>({ ...p, minutes: +p.minutes.toFixed(2), emissions_g: +p.emissions_g.toFixed(3) }));

    const totals = series.reduce(
      (acc,p)=>({
        runs: acc.runs + p.runs,
        completed: acc.completed + p.completed,
        minutes: +(acc.minutes + p.minutes).toFixed(2),
        emissions_g: +(acc.emissions_g + p.emissions_g).toFixed(3),
      }),
      { runs:0, completed:0, minutes:0, emissions_g:0 }
    );

    console.log(`${LOG_PREFIX} Aggregation complete`, {
      points: series.length,
      totals,
      window: { from: from.toISODate(), to: to.toISODate(), tz, bucket, windowAdjusted }
    });

    return ok({
      owner,
      window: { from: from.toFormat("yyyy-LL-dd"), to: to.toFormat("yyyy-LL-dd"), tz, bucket },
      windowAdjusted,
      totals,
      series,
      notes: [
        "Combined series sums per-repo emissions by bucket.",
        "Default window is last 365 days; falls back to earliest occurrence if empty.",
      ],
    });
  } catch (e) {
    console.error(`${LOG_PREFIX} ERROR`, e);
    return bad(500, { error: "Failed to build owner emissions timeline" });
  }
};
