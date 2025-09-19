import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejsLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";

export class CloudGuardianStack extends cdk.Stack {
  public readonly languageTable: dynamodb.Table;

  public readonly workflowRunsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Create DynamoDB Table
    this.languageTable = new dynamodb.Table(
      this,
      "CloudGuardianLanguageSnapshots",
      {
        tableName: "CloudGuardianLanguageSnapshots",
        partitionKey: {
          name: "repoFullName",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // workflow table
    this.workflowRunsTable = new dynamodb.Table(
      this,
      "CloudGuardianWorkflowRuns",
      {
        tableName: "CloudGuardianWorkflowRuns",
        partitionKey: {
          name: "repoFullName",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "runId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY, // dev-friendly; adjust for prod
      }
    );

    // 2. Create Lambda Functions
    const backfillCoordinator = new nodejsLambda.NodejsFunction(
      this,
      "BackfillCoordinator",
      {
        functionName: "cloudguardian-backfill-coordinator",
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: "../lambda/backfill-coordinator/index.ts",
        handler: "handler",
        timeout: cdk.Duration.seconds(300),
        memorySize: 512,
        environment: {
          LANGUAGE_TABLE_NAME: this.languageTable.tableName,
          GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
          GITHUB_USERNAME: process.env.GITHUB_USERNAME || "",
        },
      }
    );

    const languageFetcher = new nodejsLambda.NodejsFunction(
      this,
      "LanguageFetcher",
      {
        functionName: "cloudguardian-language-fetcher",
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: "../lambda/language-fetcher/index.ts",
        handler: "handler",
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        environment: {
          LANGUAGE_TABLE_NAME: this.languageTable.tableName,
          GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
        },
      }
    );

    const languageSnapshotter = new nodejsLambda.NodejsFunction(
      this,
      "LanguageSnapshotter",
      {
        functionName: "cloudguardian-language-snapshotter",
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: "../lambda/language-snapshotter/index.ts",
        handler: "handler",
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          LANGUAGE_TABLE_NAME: this.languageTable.tableName,
          GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
        },
      }
    );

    const webhookRouter = new nodejsLambda.NodejsFunction(
      this,
      "WebhookRouter",
      {
        functionName: "cloudguardian-webhook-router",
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: "../lambda/webhook-router/index.ts",
        handler: "handler",
        timeout: cdk.Duration.seconds(10),
      }
    );

    const workflowBackfillCoordinator = new nodejsLambda.NodejsFunction(
      this,
      "WorkflowBackfillCoordinator",
      {
        functionName: "cloudguardian-workflow-backfill-coordinator",
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: "../lambda/workflow-backfill-coordinator/index.ts",
        handler: "handler",
        timeout: cdk.Duration.seconds(300),
        memorySize: 512,
        environment: {
          WORKFLOW_TABLE_NAME: this.workflowRunsTable.tableName,
          GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
          GITHUB_USERNAME: process.env.GITHUB_USERNAME || "",

          // Emissions assumptions (your formula)
          WATTS_PER_VCPU: "20",
          PUE: "1.12",
          GRID_G_PER_KWH: "250",
          VCPU_PUBLIC: "4",
          VCPU_PRIVATE: "2",
          ASSUMPTIONS_VERSION: "v1",
        },
      }
    );

    const workflowRunProcessor = new nodejsLambda.NodejsFunction(
      this,
      "WorkflowRunProcessor",
      {
        functionName: "cloudguardian-workflow-run-processor",
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: "../lambda/workflow-run-processor/index.ts",
        handler: "handler",
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        environment: {
          WORKFLOW_TABLE_NAME: this.workflowRunsTable.tableName,

          // Emissions assumptions (tweak anytime)
          WATTS_PER_VCPU: "20", // ~20W per vCPU (your baseline)
          PUE: "1.12", // Azure
          GRID_G_PER_KWH: "250", // grid intensity (gCO2e/kWh)
          VCPU_PUBLIC: "4", // GitHub-hosted (public repos)
          VCPU_PRIVATE: "2", // GitHub-hosted (private repos)
          ASSUMPTIONS_VERSION: "v1", // tag your model version
        },
      }
    );

    const repoEmissionsTs = new nodejsLambda.NodejsFunction(
      this,
      "RepoEmissionsTimeseries",
      {
        functionName: "cloudguardian-repo-emissions-timeseries",
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: "../lambda/repo-emissions-timeseries/index.ts",
        handler: "handler",
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
        environment: {
          WORKFLOW_TABLE_NAME: this.workflowRunsTable.tableName,
          DEFAULT_TZ: "America/New_York",
        },
      }
    );

    // --- Owner (all repos combined) timeline ---
    const ownerEmissionsTs = new nodejsLambda.NodejsFunction(
      this,
      "OwnerEmissionsTimeseries",
      {
        functionName: "cloudguardian-owner-emissions-timeseries",
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: "../lambda/owner-emissions-timeseries/index.ts",
        handler: "handler",
        timeout: cdk.Duration.seconds(45),
        memorySize: 512,
        environment: {
          WORKFLOW_TABLE_NAME: this.workflowRunsTable.tableName,
          DEFAULT_TZ: "America/New_York",
          GITHUB_TOKEN: process.env.GITHUB_TOKEN || "", // for listing repos
        },
      }
    );

    // 3. Grant Lambda permissions
    this.workflowRunsTable.grantReadData(repoEmissionsTs);
    this.workflowRunsTable.grantReadData(ownerEmissionsTs);
    this.languageTable.grantWriteData(backfillCoordinator);
    this.languageTable.grantReadData(languageFetcher);
    this.languageTable.grantWriteData(languageSnapshotter);
    languageSnapshotter.grantInvoke(webhookRouter);

    this.workflowRunsTable.grantWriteData(workflowBackfillCoordinator);
    this.workflowRunsTable.grantWriteData(workflowRunProcessor);
    workflowRunProcessor.grantInvoke(webhookRouter);

    // 4. CRITICAL: Grant API Gateway permission to invoke Lambda functions
    backfillCoordinator.grantInvoke(
      new iam.ServicePrincipal("apigateway.amazonaws.com")
    );
    languageFetcher.grantInvoke(
      new iam.ServicePrincipal("apigateway.amazonaws.com")
    ); // ← THIS WAS MISSING!

    // 5. Create API Gateway
    const api = new apigateway.RestApi(this, "CloudGuardianApi", {
      restApiName: "CloudGuardian Service",
      description: "API for CloudGuardian language tracking",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // 6. Add API endpoints
    const backfillResource = api.root.addResource("backfill");
    backfillResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(backfillCoordinator)
    );

    const webhookResource = api.root.addResource("webhook");
    webhookResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(webhookRouter)
    );

    const repoResource = api.root.addResource("repo");
    const ownerResource = repoResource.addResource("{owner}");
    const nameResource = ownerResource.addResource("{name}");
    const languagesResource = nameResource.addResource("languages");
    languagesResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(languageFetcher)
    );

    const backfillWorkflowsResource =
      api.root.addResource("backfill-workflows");
    backfillWorkflowsResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(workflowBackfillCoordinator)
    );

    // Add /repo/{owner}/{name}/emissions (create only if missing)
    const repoEmissions =
      nameResource.getResource("emissions") ??
      nameResource.addResource("emissions");
    repoEmissions.addMethod(
      "GET",
      new apigateway.LambdaIntegration(repoEmissionsTs)
    );

    // Create /user/{owner}/emissions (only if missing)
    const userResource =
      api.root.getResource("user") ?? api.root.addResource("user");
    const userOwnerRes =
      userResource.getResource("{owner}") ??
      userResource.addResource("{owner}");
    const ownerEmissions =
      userOwnerRes.getResource("emissions") ??
      userOwnerRes.addResource("emissions");
    ownerEmissions.addMethod(
      "GET",
      new apigateway.LambdaIntegration(ownerEmissionsTs)
    );

    // 7. Outputs
    new cdk.CfnOutput(this, "ApiGatewayUrl", {
      value: api.url,
    });
    new cdk.CfnOutput(this, "BackfillEndpoint", {
      value: `${api.url}backfill`,
    });
    new cdk.CfnOutput(this, "LanguagesEndpointExample", {
      value: `${api.url}repo/octocat/hello-world/languages`,
    });
    new cdk.CfnOutput(this, "WebhookEndpoint", {
      value: `${api.url}webhook`,
      description: "URL to configure in GitHub webhook settings",
    });

    new cdk.CfnOutput(this, "BackfillWorkflowsEndpoint", {
      value: `${api.url}backfill-workflows`,
    });

    new cdk.CfnOutput(this, "RepoEmissionsEndpointExample", {
      value: `${api.url}repo/octocat/hello-world/emissions?bucket=day`,
      description: "Per-repo emissions timeline (example)",
    });

    new cdk.CfnOutput(this, "OwnerEmissionsEndpointExample", {
      value: `${api.url}user/octocat/emissions?bucket=day`,
      description: "All-repos (owner) emissions timeline (example)",
    });
  }
}
