"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// services/ingest/index.ts
var index_exports = {};
__export(index_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(index_exports);
var import_crypto = __toESM(require("crypto"));
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_lib_dynamodb = require("@aws-sdk/lib-dynamodb");
var ddb = import_lib_dynamodb.DynamoDBDocumentClient.from(new import_client_dynamodb.DynamoDBClient({}));
var COMMITS_TABLE = process.env.COMMITS_TABLE;
var WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
function verifySignature(body, signature256) {
  if (!signature256) return false;
  const hmac = import_crypto.default.createHmac("sha256", WEBHOOK_SECRET);
  const digest = "sha256=" + hmac.update(body).digest("hex");
  try {
    return import_crypto.default.timingSafeEqual(Buffer.from(digest), Buffer.from(signature256));
  } catch {
    return false;
  }
}
function safeIso(input) {
  try {
    return new Date(input ?? Date.now()).toISOString();
  } catch {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
}
function estimateCO2g(durationSec) {
  if (!durationSec) return void 0;
  const CPU_WATTS = Number(process.env.CPU_WATTS ?? "15");
  const GRID = Number(process.env.GRID_FACTOR_G_PER_KWH ?? "393");
  const kwh = durationSec * CPU_WATTS / 3600 / 1e3;
  return Math.round(kwh * GRID * 1e3) / 1e3;
}
var handler = async (event) => {
  try {
    const headers = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [String(k).toLowerCase(), v])
    );
    const ghEvent = headers["x-github-event"] || "unknown";
    const body = typeof event.body === "string" ? event.body : JSON.stringify(event.body ?? {});
    const sig = headers["x-hub-signature-256"];
    if (!verifySignature(body, sig)) return { statusCode: 401, body: "Invalid signature" };
    const payload = JSON.parse(body);
    const repo = payload?.repository?.name ?? "unknown";
    const owner = payload?.repository?.owner?.login ?? payload?.organization?.login ?? payload?.sender?.login ?? "unknown";
    let sha;
    let branch;
    let author;
    let timestamp = safeIso();
    let url = null;
    let filesChanged = 0, additions = 0, deletions = 0;
    let durationSec;
    let status;
    let conclusion;
    if (ghEvent === "push") {
      sha = payload.after || payload.head_commit?.id;
      branch = (payload.ref || "").replace("refs/heads/", "") || payload.base_ref || payload.head_ref;
      author = payload.head_commit?.author?.username || payload.pusher?.name || payload.sender?.login;
      timestamp = safeIso(payload.head_commit?.timestamp);
      url = payload.head_commit?.url ?? null;
      if (Array.isArray(payload.commits)) {
        for (const c of payload.commits) {
          filesChanged += (c.added?.length || 0) + (c.removed?.length || 0) + (c.modified?.length || 0);
          additions += c.added?.length || 0;
          deletions += c.removed?.length || 0;
        }
      }
    }
    if (ghEvent === "workflow_run") {
      const wr = payload.workflow_run;
      sha = wr?.head_sha || payload?.head_sha || payload?.after || payload?.sha;
      branch = wr?.head_branch;
      author = payload?.sender?.login || wr?.actor?.login;
      timestamp = safeIso(wr?.updated_at || wr?.created_at || wr?.run_started_at);
      url = wr?.html_url ?? null;
      status = wr?.status;
      conclusion = wr?.conclusion;
      if (wr?.run_started_at && wr?.updated_at) {
        const start = new Date(wr.run_started_at).getTime();
        const end = new Date(wr.updated_at).getTime();
        durationSec = Math.max(0, Math.round((end - start) / 1e3));
      } else if (typeof wr?.run_duration_ms === "number") {
        durationSec = Math.round(wr.run_duration_ms / 1e3);
      }
    }
    if (ghEvent === "pull_request") {
      const pr = payload.pull_request;
      sha = pr?.head?.sha || payload?.after;
      branch = pr?.head?.ref;
      author = pr?.user?.login || payload?.sender?.login;
      timestamp = safeIso(pr?.updated_at || pr?.created_at);
      url = pr?.html_url ?? null;
    }
    sha = String(sha ?? payload?.after ?? payload?.head_commit?.id ?? payload?.pull_request?.head?.sha ?? "unknown");
    branch = branch || payload?.ref?.replace("refs/heads/", "") || payload?.workflow_run?.head_branch || payload?.pull_request?.head?.ref || "unknown";
    author = author || payload?.sender?.login || payload?.head_commit?.author?.username || "unknown";
    const shortSha = sha.slice(0, 7) || "unknown";
    const tsIso = timestamp || safeIso();
    const item = {
      pk: `user#${owner}`,
      sk: `repo#${repo}#ts#${tsIso}#sha#${shortSha}`,
      user: owner,
      repo,
      branch,
      sha: shortSha,
      author,
      timestamp: tsIso,
      event: ghEvent,
      filesChanged: filesChanged || void 0,
      additions: additions || void 0,
      deletions: deletions || void 0,
      durationSec,
      status,
      // workflow_run only
      conclusion,
      // workflow_run only
      co2g: estimateCO2g(durationSec),
      // compute even on failure
      url
    };
    await ddb.send(new import_lib_dynamodb.PutCommand({ TableName: COMMITS_TABLE, Item: item }));
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "error" };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
