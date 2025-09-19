import { Octokit } from "@octokit/rest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

interface Repository {
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  archived: boolean;
}

function msToHours(ms: number) { return ms / 3_600_000; }
function instanceKw(vcpus: number, wattsPerVcpu: number) {
  // kW = vCPUs * W_per_vCPU / 1000
  return (vcpus * wattsPerVcpu) / 1000;
}

export const handler = async () => {
  console.log("🚀 [WF-BACKFILL] start (with emissions)");

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
  const GITHUB_USERNAME = process.env.GITHUB_USERNAME!;
  const TABLE = process.env.WORKFLOW_TABLE_NAME!;

  const WATTS_PER_VCPU = Number(process.env.WATTS_PER_VCPU || "20");
  const PUE = Number(process.env.PUE || "1.12");
  const GRID_G_PER_KWH = Number(process.env.GRID_G_PER_KWH || "250");
  const VCPU_PUBLIC = Number(process.env.VCPU_PUBLIC || "4");
  const VCPU_PRIVATE = Number(process.env.VCPU_PRIVATE || "2");
  const VER = String(process.env.ASSUMPTIONS_VERSION || "v1");

  if (!GITHUB_TOKEN || !GITHUB_USERNAME || !TABLE) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env: GITHUB_TOKEN / GITHUB_USERNAME / WORKFLOW_TABLE_NAME" }) };
  }

  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const batchId = `WF_BATCH_${Date.now()}`;

  // 1) all repos for the user
  const repos = await octokit.paginate(octokit.repos.listForUser, {
    username: GITHUB_USERNAME,
    per_page: 100,
    sort: "updated",
  }) as Repository[];

  console.log(`[WF-BACKFILL] repos: ${repos.length}`);

  let runsSeen = 0, runsInserted = 0, runsUpdated = 0;

  for (const repo of repos) {
    const owner = repo.owner.login;
    const name = repo.name;
    console.log(`📦 ${repo.full_name}`);

    try {
      const runs = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
        owner, repo: name, per_page: 100,
      });

      console.log(`  ↳ runs: ${runs.length}`);

      // assume GitHub-hosted runner sizes: 2 vCPU (private), 4 vCPU (public)
      const assumedVcpus = repo.private ? VCPU_PRIVATE : VCPU_PUBLIC;
      const assumedKw = instanceKw(assumedVcpus, WATTS_PER_VCPU);

      for (const run of runs) {
        runsSeen++;

        const startedAt: string | null = run.run_started_at ?? run.created_at ?? null;
        const completedAt: string | null = run.updated_at ?? null;
        const timestamp = new Date((startedAt ?? run.created_at)!).toISOString();

        const base: Record<string, any> = {
          repoFullName: repo.full_name,
          runId: String(run.id),
          timestamp,
          workflowName: run.name || "unknown",
          branch: run.head_branch ?? null,
          startedAt,
          completedAt,
          conclusion: run.conclusion ?? null,
          status: run.status ?? null,
          event: run.event ?? null,
          commitSha: run.head_sha ?? null,
          backfillBatch: batchId,
          factors: {
            VCPU_ASSUMED: assumedVcpus,
            WATTS_PER_VCPU,
            PUE,
            GRID_G_PER_KWH,
          },
          assumptionsVersion: VER,
        };

        // --- Emissions (only when we have a positive duration) ---
        if (run.status === "completed" && startedAt && completedAt) {
          const t0 = Date.parse(startedAt);
          const t1 = Date.parse(completedAt);
          if (!Number.isNaN(t0) && !Number.isNaN(t1) && t1 > t0) {
            const hours = msToHours(t1 - t0);
            const energyKWh = assumedKw * hours * PUE;
            const g = energyKWh * GRID_G_PER_KWH;       // grams (float)

            // never store zero for non-zero duration
            const mgInt = Math.max(1, Math.round(g * 1000));
            const gSync = mgInt / 1000;

            base.minutes = +(hours * 60).toFixed(2);
            base.energyKWh = +energyKWh.toFixed(6);
            base.emissions_mg = mgInt;                  // integer mg
            base.emissions_g = +gSync.toFixed(3);       // derived from mg
            base.carbonComputedAt = new Date().toISOString();
          }
        }

        // Idempotent write: try insert; if exists, upsert core fields and fill emissions if missing
        try {
          await ddb.send(new PutCommand({
            TableName: TABLE,
            Item: base,
            ConditionExpression: "attribute_not_exists(repoFullName) AND attribute_not_exists(runId)",
          }));
          runsInserted++;
        } catch (err: any) {
          if (err.name === "ConditionalCheckFailedException") {
            const names: Record<string, string> = { "#ts": "timestamp", "#st": "status", "#ev": "event" };
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
              "factors = if_not_exists(factors, :f)",
              "assumptionsVersion = if_not_exists(assumptionsVersion, :ver)",
            ];
            const values: Record<string, any> = {
              ":ts": base.timestamp,
              ":w": base.workflowName,
              ":b": base.branch,
              ":sa": base.startedAt,
              ":ca": base.completedAt,
              ":co": base.conclusion,
              ":st": base.status,
              ":ev": base.event,
              ":sha": base.commitSha,
              ":f": base.factors,
              ":ver": base.assumptionsVersion,
            };

            if (base.emissions_mg !== undefined) {
              sets.push(
                "minutes = if_not_exists(minutes, :m)",
                "energyKWh = if_not_exists(energyKWh, :k)",
                "emissions_g = if_not_exists(emissions_g, :g)",
                "emissions_mg = if_not_exists(emissions_mg, :mg)",
                "carbonComputedAt = if_not_exists(carbonComputedAt, :now)"
              );
              values[":m"] = base.minutes;
              values[":k"] = base.energyKWh;
              values[":g"] = base.emissions_g;
              values[":mg"] = base.emissions_mg;
              values[":now"] = base.carbonComputedAt;
            }

            await ddb.send(new UpdateCommand({
              TableName: TABLE,
              Key: { repoFullName: base.repoFullName, runId: base.runId },
              UpdateExpression: "SET " + sets.join(", "),
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            }));
            runsUpdated++;
          } else {
            console.error(`    ❌ Put failed for run ${run.id} (${repo.full_name}):`, err);
          }
        }
      }

      await new Promise(r => setTimeout(r, 150)); // polite to GitHub API
    } catch (err) {
      console.error(`  ❌ Error on ${repo.full_name}:`, err);
    }
  }

  const result = { message: "Workflow backfill (with emissions) complete", batchId, runsSeen, runsInserted, runsUpdated };
  console.log("✅", result);
  return { statusCode: 200, body: JSON.stringify(result) };
};
