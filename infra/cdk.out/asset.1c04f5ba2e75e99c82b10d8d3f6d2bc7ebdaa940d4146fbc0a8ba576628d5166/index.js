"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
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

// node_modules/@octokit/webhooks-methods/dist-node/index.js
var dist_node_exports = {};
__export(dist_node_exports, {
  sign: () => sign,
  verify: () => verify,
  verifyWithFallback: () => verifyWithFallback
});
async function sign(secret, payload) {
  if (!secret || !payload) {
    throw new TypeError(
      "[@octokit/webhooks-methods] secret & payload required for sign()"
    );
  }
  if (typeof payload !== "string") {
    throw new TypeError("[@octokit/webhooks-methods] payload must be a string");
  }
  const algorithm = "sha256";
  return `${algorithm}=${(0, import_node_crypto.createHmac)(algorithm, secret).update(payload).digest("hex")}`;
}
async function verify(secret, eventPayload, signature) {
  if (!secret || !eventPayload || !signature) {
    throw new TypeError(
      "[@octokit/webhooks-methods] secret, eventPayload & signature required"
    );
  }
  if (typeof eventPayload !== "string") {
    throw new TypeError(
      "[@octokit/webhooks-methods] eventPayload must be a string"
    );
  }
  const signatureBuffer = import_node_buffer.Buffer.from(signature);
  const verificationBuffer = import_node_buffer.Buffer.from(await sign(secret, eventPayload));
  if (signatureBuffer.length !== verificationBuffer.length) {
    return false;
  }
  return (0, import_node_crypto2.timingSafeEqual)(signatureBuffer, verificationBuffer);
}
async function verifyWithFallback(secret, payload, signature, additionalSecrets) {
  const firstPass = await verify(secret, payload, signature);
  if (firstPass) {
    return true;
  }
  if (additionalSecrets !== void 0) {
    for (const s of additionalSecrets) {
      const v = await verify(s, payload, signature);
      if (v) {
        return v;
      }
    }
  }
  return false;
}
var import_node_crypto, import_node_crypto2, import_node_buffer, VERSION;
var init_dist_node = __esm({
  "node_modules/@octokit/webhooks-methods/dist-node/index.js"() {
    import_node_crypto = require("node:crypto");
    import_node_crypto2 = require("node:crypto");
    import_node_buffer = require("node:buffer");
    VERSION = "6.0.0";
    sign.VERSION = VERSION;
    verify.VERSION = VERSION;
  }
});

// lambda/webhook-router/index.ts
var index_exports = {};
__export(index_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(index_exports);
var import_client_lambda = require("@aws-sdk/client-lambda");
var lambdaClient = new import_client_lambda.LambdaClient();
var handler = async (event) => {
  console.log("Received GitHub event");
  const signature = event.headers["x-hub-signature-256"];
  const githubEventType = event.headers["x-github-event"];
  const body = event.body;
  console.log(`Event type: ${githubEventType}`);
  try {
    const { verify: verify2 } = await Promise.resolve().then(() => (init_dist_node(), dist_node_exports));
    const isVerified = await verify2(process.env.GITHUB_WEBHOOK_SECRET, body, signature);
    if (!isVerified) {
      console.error("Invalid webhook signature");
      return { statusCode: 401, body: JSON.stringify({ error: "Invalid signature" }) };
    }
    let targetLambda;
    switch (githubEventType) {
      case "push":
        targetLambda = "cloudguardian-language-snapshotter";
        console.log("Routing to Language Snapshotter");
        break;
      // We'll add more cases later for other events (workflow_run, etc.)
      default:
        console.log(`No handler for event type: ${githubEventType}`);
        return { statusCode: 200, body: JSON.stringify({ message: "Event ignored - no handler" }) };
    }
    const invokeCommand = new import_client_lambda.InvokeCommand({
      FunctionName: targetLambda,
      InvocationType: "Event",
      // Asynchronous execution
      Payload: JSON.stringify({
        headers: event.headers,
        body: event.body
      })
    });
    await lambdaClient.send(invokeCommand);
    console.log(`Successfully routed ${githubEventType} event to ${targetLambda}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Event routed successfully" })
    };
  } catch (error) {
    console.error("Error in webhook router:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" })
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
