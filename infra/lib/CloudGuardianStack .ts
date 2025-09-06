import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejsLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.AWS_REGION || "us-east-1",
};

export class CloudGuardianStack extends cdk.Stack {
  public readonly languageTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Create the DynamoDB Table for Language Snapshots
    this.languageTable = new dynamodb.Table(this, "CloudGuardianLanguageSnapshots", {
      tableName: "CloudGuardianLanguageSnapshots",
      partitionKey: { name: "repoFullName", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 2. Create the Lambda Functions
    const backfillCoordinator = new nodejsLambda.NodejsFunction(this, "BackfillCoordinator", {
      functionName: "cloudguardian-backfill-coordinator",
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: "../lambda/backfill-coordinator/index.ts", // Points to your logic
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        LANGUAGE_TABLE_NAME: this.languageTable.tableName,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN || "", // Pass environment variables
        GITHUB_USERNAME: process.env.GITHUB_USERNAME || "",
      },
    });

    const languageFetcher = new nodejsLambda.NodejsFunction(this, "LanguageFetcher", {
      functionName: "cloudguardian-language-fetcher",
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: "../lambda/language-fetcher/index.ts", // Shell for now
      handler: "handler",
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        LANGUAGE_TABLE_NAME: this.languageTable.tableName,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
      },
    });

    // 3. Grant Lambda permissions to access the table
    this.languageTable.grantWriteData(backfillCoordinator);
    this.languageTable.grantReadData(languageFetcher);

    // 4. Create the API Gateway
    const api = new apigateway.RestApi(this, "CloudGuardianApi", {
      restApiName: "CloudGuardian Service",
      description: "API for CloudGuardian language tracking",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // 5. Add API endpoints and connect them to Lambda functions
    // POST /backfill -> Triggers the backfillCoordinator
    const backfillResource = api.root.addResource("backfill");
    backfillResource.addMethod("POST", new apigateway.LambdaIntegration(backfillCoordinator));

    // GET /repo/{owner}/{name}/languages -> Triggers the languageFetcher
    const repoResource = api.root.addResource("repo");
    const ownerResource = repoResource.addResource("{owner}");
    const nameResource = ownerResource.addResource("{name}");
    const languagesResource = nameResource.addResource("languages");
    languagesResource.addMethod("GET", new apigateway.LambdaIntegration(languageFetcher));

    // 6. Output useful information after deployment
    new cdk.CfnOutput(this, "LanguageTableName", {
      value: this.languageTable.tableName,
    });

    new cdk.CfnOutput(this, "ApiGatewayUrl", {
      value: api.url,
      description: "The base URL for the API Gateway",
    });

    new cdk.CfnOutput(this, "BackfillEndpoint", {
      value: `${api.url}backfill`,
      description: "The endpoint to trigger a language data backfill",
    });

    new cdk.CfnOutput(this, "LanguagesEndpointExample", {
      value: `${api.url}repo/octocat/hello-world/languages`,
      description: "Example endpoint to fetch language data for a repo",
    });
  }
}