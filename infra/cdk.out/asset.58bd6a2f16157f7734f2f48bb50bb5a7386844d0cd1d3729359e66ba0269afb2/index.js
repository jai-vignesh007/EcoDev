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
var REPOINFO_TABLE = process.env.REPOINFO_TABLE;
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
var handler = async (event) => {
  try {
    const body = typeof event.body === "string" ? event.body : JSON.stringify(event.body ?? {});
    const sig = event.headers?.["x-hub-signature-256"] || event.headers?.["X-Hub-Signature-256"];
    if (!verifySignature(body, sig)) {
      return { statusCode: 401, body: "Invalid signature" };
    }
    const payload = JSON.parse(body);
    const ghEvent = event.headers?.["x-github-event"] || event.headers?.["X-GitHub-Event"];
    const repo = payload.repository?.name || "unknown";
    const owner = payload.repository?.owner?.login || "unknown";
    const sha = payload.after || payload.head_commit?.id || "unknown";
    const branch = payload.ref?.replace("refs/heads/", "") || "unknown";
    const author = payload.head_commit?.author?.username || payload.sender?.login || "unknown";
    const ts = new Date(payload.head_commit?.timestamp || Date.now()).toISOString();
    let filesChanged = 0, additions = 0, deletions = 0;
    if (Array.isArray(payload.commits)) {
      for (const c of payload.commits) {
        filesChanged += (c.added?.length || 0) + (c.removed?.length || 0) + (c.modified?.length || 0);
        additions += c.added?.length || 0;
        deletions += c.removed?.length || 0;
      }
    }
    const durationSec = payload.workflow_run?.run_duration_ms ? Math.round(payload.workflow_run.run_duration_ms / 1e3) : void 0;
    const co2g = durationSec ? durationSec * 15 / 3600 * 393 : void 0;
    const item = {
      pk: `user#${owner}`,
      sk: `repo#${repo}#ts#${ts}#sha#${String(sha).slice(0, 7)}`,
      repo,
      branch,
      sha: String(sha).slice(0, 7),
      author,
      timestamp: ts,
      event: ghEvent,
      filesChanged,
      additions,
      deletions,
      durationSec,
      co2g,
      url: payload.head_commit?.url || null
    };
    await ddb.send(new import_lib_dynamodb.PutCommand({ TableName: COMMITS_TABLE, Item: item }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, item }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "error" };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
