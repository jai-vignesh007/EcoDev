import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient();
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

interface GitHubPushEvent {
  ref: string;
  repository: {
    full_name: string;
    name: string;
    owner: { name: string };
    default_branch: string;
  };
  after: string;
}

export const handler = async (event: any) => {
  console.log("🔍 [DEBUG] Language Snapshotter received event");
  
  try {
    // Parse the incoming webhook payload
    const payload: GitHubPushEvent = JSON.parse(event.body);
    const { repository, ref } = payload;

    console.log(`🔍 [DEBUG] Processing push to: ${repository.full_name}, ref: ${ref}`);

    // Only process pushes to the default branch
    const defaultBranchRef = `refs/heads/${repository.default_branch}`;
    if (ref !== defaultBranchRef) {
      console.log(`🔍 [DEBUG] Skipping non-default branch push: ${ref}`);
      return { statusCode: 200, body: JSON.stringify({ message: 'Skipped non-default branch' }) };
    }

    console.log(`🔍 [DEBUG] Fetching language data for ${repository.full_name}`);

    // Fetch language data from GitHub API
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const { data: languages } = await octokit.repos.listLanguages({
      owner: repository.owner.name,
      repo: repository.name,
    });

    console.log(`✅ [DEBUG] Retrieved languages for ${repository.full_name}`);

    // Prepare the database record
    const totalBytes = Object.values(languages).reduce((sum, bytes) => sum + bytes, 0);
    const timestamp = new Date().toISOString();

    const params = {
      TableName: process.env.LANGUAGE_TABLE_NAME,
      Item: {
        repoFullName: repository.full_name,
        timestamp: timestamp,
        languages: languages,
        totalBytes: totalBytes,
        defaultBranch: repository.default_branch,
        commitSha: payload.after,
      },
    };

    // Write to DynamoDB
    console.log(`🔍 [DEBUG] Writing to DynamoDB: ${process.env.LANGUAGE_TABLE_NAME}`);
    await ddbDocClient.send(new PutCommand(params));
    console.log(`✅ [DEBUG] Successfully saved language snapshot for ${repository.full_name}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: 'Language snapshot saved successfully',
        repository: repository.full_name,
        timestamp: timestamp
      }),
    };

  } catch (error) {
    console.error('❌ [DEBUG] ERROR in Language Snapshotter:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to process language snapshot',
       // message: error.message
      }),
    };
  }
};