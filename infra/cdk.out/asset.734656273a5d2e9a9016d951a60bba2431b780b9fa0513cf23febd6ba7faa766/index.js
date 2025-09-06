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

// lambda/language-fetcher/index.ts
var index_exports = {};
__export(index_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(index_exports);
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_lib_dynamodb = require("@aws-sdk/lib-dynamodb");
var ddbClient = new import_client_dynamodb.DynamoDBClient({});
var ddbDocClient = import_lib_dynamodb.DynamoDBDocumentClient.from(ddbClient);
var handler = async (event) => {
  const { owner, name } = event.pathParameters || {};
  const repoFullName = `${owner}/${name}`;
  console.log(`Fetching language data for: ${repoFullName}`);
  if (!owner || !name) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing owner or name parameters" })
    };
  }
  try {
    const params = {
      TableName: process.env.LANGUAGE_TABLE_NAME,
      KeyConditionExpression: "repoFullName = :repo",
      ExpressionAttributeValues: {
        ":repo": repoFullName
      },
      Limit: 1,
      // Get only the most recent item
      ScanIndexForward: false
      // Sort descending (newest first)
    };
    const { Items } = await ddbDocClient.send(new import_lib_dynamodb.QueryCommand(params));
    const latestSnapshot = Items && Items[0];
    if (!latestSnapshot) {
      return {
        statusCode: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({
          error: "No language data found for this repository",
          repository: repoFullName
        })
      };
    }
    const { languages, totalBytes, timestamp } = latestSnapshot;
    const languagesWithPercentages = Object.entries(languages).map(([name2, bytes]) => {
      const byteCount = Number(bytes);
      return {
        name: name2,
        bytes: byteCount,
        percentage: parseFloat((byteCount / totalBytes * 100).toFixed(2))
        // Calculate to 2 decimal places
      };
    });
    languagesWithPercentages.sort((a, b) => b.percentage - a.percentage);
    const response = {
      repository: repoFullName,
      totalBytes,
      languages: languagesWithPercentages,
      lastUpdated: timestamp
    };
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
        // Critical for frontend
      },
      body: JSON.stringify(response)
    };
  } catch (error) {
    console.error("Error fetching language data:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        error: "Failed to fetch language data",
        message: error.message
      })
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
