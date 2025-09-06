import { Octokit } from "@octokit/rest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

// Initialize AWS and GitHub clients
const ddbClient = new DynamoDBClient();
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

interface Repository {
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  archived: boolean;
  default_branch?: string;
}

interface LanguageSnapshot {
  repoFullName: string;
  timestamp: string;
  languages: { [key: string]: number };
  totalBytes: number;
  defaultBranch: string;
  commitSha: string;
  isPrivate: boolean;
  isArchived: boolean;
  backfillBatch: string;
}

export const handler = async (event: any) => {
  console.log("Starting Backfill Coordinator");
  
  try {
    // Initialize Octokit with authentication
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const username = process.env.GITHUB_USERNAME;

    if (!username) {
      throw new Error('GITHUB_USERNAME environment variable is required');
    }

    console.log(`Fetching all repositories for user: ${username}`);

    // 1. Fetch ALL repositories for the user
    const repos = await octokit.paginate(octokit.repos.listForUser, { 
      username: username,
      per_page: 100, // Max items per page
      sort: 'updated', // Get most recently updated repos first
    }) as Repository[];

    console.log(`Found ${repos.length} repositories to process.`);

    const batchId = `BATCH_${Date.now()}`;
    let successfulSnapshots = 0;

    // 2. Process each repository sequentially (to be nice to GitHub's API)
    for (const repo of repos) {
      console.log(`Processing: ${repo.full_name}`);
      
      try {
        // 2a. Get detailed repo information to find the default branch
        const { data: repoDetails } = await octokit.repos.get({
          owner: repo.owner.login,
          repo: repo.name,
        });

        // 2b. Fetch language data for this repository
        const { data: languages } = await octokit.repos.listLanguages({
          owner: repo.owner.login,
          repo: repo.name,
        });

        // 2c. Calculate total bytes and prepare the snapshot
        const totalBytes = Object.values(languages).reduce((sum, bytes) => sum + bytes, 0);
        const timestamp = new Date().toISOString();

        const snapshot: LanguageSnapshot = {
          repoFullName: repo.full_name,
          timestamp: timestamp,
          languages: languages,
          totalBytes: totalBytes,
          defaultBranch: repoDetails.default_branch || 'main',
          commitSha: 'BACKFILL_INITIAL', // We don't have a specific commit for backfill
          isPrivate: repo.private,
          isArchived: repo.archived,
          backfillBatch: batchId,
        };

        // 2d. Save the snapshot to DynamoDB
        await ddbDocClient.send(new PutCommand({
          TableName: process.env.LANGUAGE_TABLE_NAME,
          Item: snapshot,
        }));

        successfulSnapshots++;
        console.log(`✅ Successfully saved snapshot for ${repo.full_name}`);

        // 2e. Be nice to the GitHub API - add a small delay between requests
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`❌ Failed to process ${repo.full_name}:`, (error as Error).message);
        // Continue with the next repository even if one fails
      }
    }

    // 3. Return success response
    const message = `Backfill completed. Successfully processed ${successfulSnapshots} out of ${repos.length} repositories.`;
    console.log(message);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message,
        batchId,
        successful: successfulSnapshots,
        total: repos.length,
      }),
    };

  } catch (error) {
    // 4. Handle any unexpected errors
    console.error('Backfill job failed completely:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Backfill job failed',
        message: (error as Error).message 
      }),
    };
  }
};