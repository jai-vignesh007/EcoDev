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
  const signature = event.headers["x-hub-signature-256"];
  const githubEventType = event.headers["x-github-event"];
  const body = event.body;
  console.log(`\u{1F50D} [DEBUG] Event type: ${githubEventType}`);
  try {
    console.log("\u{1F50D} [DEBUG] Skipping signature verification");
    let targetLambda;
    switch (githubEventType) {
      case "push":
        targetLambda = "cloudguardian-language-snapshotter";
        console.log("\u2705 [DEBUG] Routing to Language Snapshotter");
        break;
      default:
        console.log(`\u{1F50D} [DEBUG] No handler for event type: ${githubEventType}`);
        return { statusCode: 200, body: JSON.stringify({ message: "Event ignored - no handler" }) };
    }
    const invokeCommand = new import_client_lambda.InvokeCommand({
      FunctionName: targetLambda,
      InvocationType: "Event",
      Payload: JSON.stringify({
        headers: event.headers,
        body: event.body
      })
    });
    await lambdaClient.send(invokeCommand);
    console.log(`\u2705 [DEBUG] Successfully routed event`);
    return { statusCode: 200, body: JSON.stringify({ message: "Event routed successfully" }) };
  } catch (error) {
    console.error("\u274C [DEBUG] ERROR:", error);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal server error" }) };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
