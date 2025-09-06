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
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_crypto = __toESM(require("crypto"));
var db = new import_client_dynamodb.DynamoDBClient({});
var COMMITS_TABLE = process.env.COMMITS_TABLE;
var REPOINFO_TABLE = process.env.REPOINFO_TABLE;
var WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
function verifySignature(event, body) {
  const signature = event.headers["x-hub-signature-256"];
  if (!signature || !WEBHOOK_SECRET) return false;
  const hmac = import_crypto.default.createHmac("sha256", WEBHOOK_SECRET);
  const digest = `sha256=${hmac.update(body).digest("hex")}`;
  return import_crypto.default.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(digest)
  );
}
var handler = async (event) => {
  console.log("Received event:", JSON.stringify(event));
  const body = event.body;
  if (!body) {
    return { statusCode: 400, body: "Missing body" };
  }
  if (!verifySignature(event, body)) {
    return { statusCode: 401, body: "Invalid signature" };
  }
  const payload = JSON.parse(body);
  const eventType = event.headers["x-github-event"];
  if (eventType === "ping") {
    return { statusCode: 200, body: "pong" };
  }
  if (eventType === "push") {
    const { repository, head_commit, ref } = payload;
    const item = {
      pk: { S: `${repository.full_name}` },
      sk: { S: `${Date.now()}#${head_commit.id}` },
      message: { S: head_commit.message },
      author: { S: head_commit.author.username },
      ref: { S: ref }
    };
    await db.send(new import_client_dynamodb.PutItemCommand({
      TableName: COMMITS_TABLE,
      Item: item
    }));
    const repoItem = {
      pk: { S: `${repository.full_name}` },
      sk: { S: "info" },
      language: { S: repository.language ?? "unknown" }
    };
    await db.send(new import_client_dynamodb.PutItemCommand({
      TableName: REPOINFO_TABLE,
      Item: repoItem
    }));
  }
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true })
  };
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
