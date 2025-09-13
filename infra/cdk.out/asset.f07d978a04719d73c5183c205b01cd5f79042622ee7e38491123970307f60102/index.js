"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lambda/webhook-router/index.ts
var index_exports = {};
__export(index_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(index_exports);
var import_client_lambda = require("@aws-sdk/client-lambda");
var lambdaClient = new import_client_lambda.LambdaClient();
var handler = async (event) => {
  console.log("\u{1F50D} [DEBUG] Webhook router handler started");
  console.log("\u{1F50D} [DEBUG] Received headers:", JSON.stringify(event.headers, null, 2));
  console.log("\u{1F50D} [DEBUG] Event body type:", typeof event.body);
  console.log("\u{1F50D} [DEBUG] Event body length:", event.body?.length || 0);
  if (!event.headers || !event.headers["X-GitHub-Event"]) {
    console.error("\u274C [DEBUG] Missing required headers or x-github-event header");
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Missing required headers",
        message: "x-github-event header is required"
      })
    };
  }
  const signature = event.headers["X-Hub-Signature-256"];
  const githubEventType = event.headers["X-GitHub-Event"];
  const body = event.body;
  console.log(`\u{1F50D} [DEBUG] Event type: ${githubEventType}`);
  console.log(`\u{1F50D} [DEBUG] Signature present: ${!!signature}`);
  try {
    console.log("\u{1F50D} [DEBUG] Skipping signature verification for debugging");
    let targetLambda;
    switch (githubEventType) {
      case "push":
        targetLambda = "cloudguardian-language-snapshotter";
        console.log("\u2705 [DEBUG] Routing to Language Snapshotter");
        break;
      case "ping":
        console.log("\u2705 [DEBUG] Handling GitHub ping event");
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Pong! Webhook is working" })
        };
      default:
        console.log(`\u{1F50D} [DEBUG] No handler for event type: ${githubEventType}`);
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "Event ignored - no handler",
            eventType: githubEventType
          })
        };
    }
    const payload = {
      headers: event.headers,
      body: event.body
    };
    console.log(`\u{1F50D} [DEBUG] Invoking target Lambda: ${targetLambda}`);
    const invokeCommand = new import_client_lambda.InvokeCommand({
      FunctionName: targetLambda,
      InvocationType: "Event",
      // Asynchronous execution
      Payload: JSON.stringify(payload)
    });
    await lambdaClient.send(invokeCommand);
    console.log(`\u2705 [DEBUG] Successfully routed ${githubEventType} event to ${targetLambda}`);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Event routed successfully",
        eventType: githubEventType,
        targetLambda
      })
    };
  } catch (error) {
    console.error("\u274C [DEBUG] ERROR in webhook router:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal server error"
        // message: error.message
      })
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
