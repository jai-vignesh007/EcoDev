import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

// Initialize DynamoDB Client
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

// Interface for the response
interface LanguageInfo {
  name: string;
  bytes: number;
  percentage: number;
}

interface ApiResponse {
  repository: string;
  totalBytes: number;
  languages: LanguageInfo[];
  lastUpdated: string;
}

export const handler = async (event: any) => {
  // Extract owner and repo from the URL path
  const { owner, name } = event.pathParameters || {};
  const repoFullName = `${owner}/${name}`;

  console.log(`Fetching language data for: ${repoFullName}`);

  if (!owner || !name) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing owner or name parameters' }),
    };
  }

  try {
    // Query DynamoDB for the MOST RECENT snapshot for this repository
    const params = {
      TableName: process.env.LANGUAGE_TABLE_NAME,
      KeyConditionExpression: 'repoFullName = :repo',
      ExpressionAttributeValues: {
        ':repo': repoFullName
      },
      Limit: 1, // Get only the most recent item
      ScanIndexForward: false, // Sort descending (newest first)
    };

    const { Items } = await ddbDocClient.send(new QueryCommand(params));
    const latestSnapshot = Items && Items[0];

    // If no data found in DynamoDB, return a 404
    if (!latestSnapshot) {
      return {
        statusCode: 404,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ 
          error: 'No language data found for this repository',
          repository: repoFullName
        }),
      };
    }

    // Calculate percentages for each language
    const { languages, totalBytes, timestamp } = latestSnapshot;
    const languagesWithPercentages: LanguageInfo[] = Object.entries(languages).map(([name, bytes]) => {
      const byteCount = Number(bytes);
      return {
        name,
        bytes: byteCount,
        percentage: parseFloat(((byteCount / totalBytes) * 100).toFixed(2)) // Calculate to 2 decimal places
      };
    });

    // Sort languages by percentage (descending)
    languagesWithPercentages.sort((a, b) => b.percentage - a.percentage);

    // Format the successful response
    const response: ApiResponse = {
      repository: repoFullName,
      totalBytes: totalBytes,
      languages: languagesWithPercentages,
      lastUpdated: timestamp
    };

    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // Critical for frontend
      },
      body: JSON.stringify(response),
    };

  } catch (error) {
    console.error('Error fetching language data:', error);
    return {
      statusCode: 500,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ 
        error: 'Failed to fetch language data',
        message: (error as Error).message 
      }),
    };
  }
};