import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

interface WorkflowRunPayload {
  action: string; // requested | in_progress | completed | ...
  repository: {
    full_name: string;
    private?: boolean;
    name?: string;
    owner?: { login?: string };
  };
  workflow_run: {
    id: number;
    name?: string | null;
    head_branch?: string | null;
    head_sha?: string | null;
    run_started_at?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    status?: string | null;      // queued | in_progress | completed
    conclusion?: string | null;  // success | failure | cancelled | null
    event?: string | null;       // push | workflow_dispatch | schedule | ...
  };
}

// helpers
function parseISO(s?: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export const handler = async (event: any) => {
  console.log("🔔 [workflow-run-processor] received");

  try {
    const bodyStr = typeof event.body === "string" ? event.body : JSON.stringify(event.body);
    const payload: WorkflowRunPayload = JSON.parse(bodyStr);

    const repoFullName = payload.repository?.full_name;
    const isPrivate = !!payload.repository?.private;
    const run = payload.workflow_run;

    if (!repoFullName || !run?.id) {
      console.error("❌ Missing repoFullName or run.id");
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid payload" })
      };
    }

    // Resolve core timestamps & fields
    const startedAt = run.run_started_at ?? run.created_at ?? null;
    const completedAt = run.updated_at ?? null;
    const timestamp = new Date((startedAt ?? new Date().toISOString())).toISOString();

    // Assumptions from env
    const WATTS_PER_VCPU = Number(process.env.WATTS_PER_VCPU || "20");
    const PUE = Number(process.env.PUE || "1.12");
    const GRID_G_PER_KWH = Number(process.env.GRID_G_PER_KWH || "250");
    const VCPU_PUBLIC = Number(process.env.VCPU_PUBLIC || "4");
    const VCPU_PRIVATE = Number(process.env.VCPU_PRIVATE || "2");
    const ASSUMPTIONS_VERSION = String(process.env.ASSUMPTIONS_VERSION || "v1");

    const assumedVcpus = isPrivate ? VCPU_PRIVATE : VCPU_PUBLIC;
    const assumedKw = (assumedVcpus * WATTS_PER_VCPU) / 1000; // kW

    // Build dynamic update
    const names: Record<string, string> = {
      "#ts": "timestamp",
      "#st": "status",
      "#ev": "event",
    };

    const sets: string[] = [
      "#ts = :ts",
      "workflowName = :w",
      "branch = :b",
      "startedAt = :sa",
      "completedAt = :ca",
      "conclusion = :co",
      "#st = :st",
      "#ev = :ev",
      "commitSha = :sha",
      // keep factors/version up to date (safe to overwrite)
      "factors = :f",
      "assumptionsVersion = :ver"
    ];

    const values: Record<string, any> = {
      ":ts": timestamp,
      ":w": run.name ?? "unknown",
      ":b": run.head_branch ?? null,
      ":sa": startedAt,
      ":ca": completedAt,
      ":co": run.conclusion ?? null,
      ":st": run.status ?? null,
      ":ev": run.event ?? null,
      ":sha": run.head_sha ?? null,
      ":f": {
        VCPU_ASSUMED: assumedVcpus,
        WATTS_PER_VCPU,
        PUE,
        GRID_G_PER_KWH,
      },
      ":ver": ASSUMPTIONS_VERSION,
    };

    // If completed with a positive duration → compute emissions now
    const t0 = parseISO(startedAt);
    const t1 = parseISO(completedAt);
    if (run.status === "completed" && t0 !== null && t1 !== null && t1 > t0) {
      const durMs = t1 - t0;
      const hours = durMs / 3_600_000;
      const energyKWh = assumedKw * hours * PUE;         // kWh
      const g = energyKWh * GRID_G_PER_KWH;              // grams (float)

      // never zero for non-zero durations
      const emissions_mg = Math.max(1, Math.round(g * 1000)); // integer mg
      const emissions_g = emissions_mg / 1000;                // derived g

      sets.push(
        "minutes = :m",
        "energyKWh = :k",
        "emissions_g = :g",
        "emissions_mg = :mg",
        "carbonComputedAt = :now"
      );

      values[":m"] = +(hours * 60).toFixed(2);
      values[":k"] = +energyKWh.toFixed(6);
      values[":g"] = +emissions_g.toFixed(3);
      values[":mg"] = emissions_mg;
      values[":now"] = new Date().toISOString();
    }

    await ddb.send(new UpdateCommand({
      TableName: process.env.WORKFLOW_TABLE_NAME!,
      Key: { repoFullName, runId: String(run.id) },
      UpdateExpression: "SET " + sets.join(", "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));

    console.log(`✅ upserted ${repoFullName} / run ${run.id} (action=${payload.action})`);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    console.error("❌ processor error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Processor failed" })
    };
  }
};
