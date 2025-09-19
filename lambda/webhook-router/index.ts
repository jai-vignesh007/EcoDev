import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient();

export const handler = async (event: any) => {
  console.log("🔍 [DEBUG] Webhook router handler started");
  
  // Log all received headers for debugging
  console.log("🔍 [DEBUG] Received headers:", JSON.stringify(event.headers, null, 2));
  console.log("🔍 [DEBUG] Event body type:", typeof event.body);
  console.log("🔍 [DEBUG] Event body length:", event.body?.length || 0);

  // Check for required headers
  if (!event.headers || !event.headers['X-GitHub-Event']) {
    console.error("❌ [DEBUG] Missing required headers or x-github-event header");
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Missing required headers',
        message: 'x-github-event header is required'
      })
    };
  }

  const signature = event.headers['X-Hub-Signature-256'];
  const githubEventType = event.headers['X-GitHub-Event'];
  const body = event.body;

  console.log(`🔍 [DEBUG] Event type: ${githubEventType}`);
  console.log(`🔍 [DEBUG] Signature present: ${!!signature}`);

  try {
    // Skip verification for now - focus on routing first
    console.log("🔍 [DEBUG] Skipping signature verification for debugging");

    // Route based on event type
    let targetLambda: string;
    
    switch (githubEventType) {
      case 'push':
        targetLambda = 'cloudguardian-language-snapshotter';
        console.log('✅ [DEBUG] Routing to Language Snapshotter');
        break;
      
      case 'ping':
        console.log('✅ [DEBUG] Handling GitHub ping event');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Pong! Webhook is working' })
        };
      case 'workflow_run':
        targetLambda = 'cloudguardian-workflow-run-processor';
        console.log('✅ [DEBUG] Routing to Workflow Run Processor');
        break;
      
      default:
        console.log(`🔍 [DEBUG] No handler for event type: ${githubEventType}`);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            message: 'Event ignored - no handler',
            eventType: githubEventType
          })
        };
    }

    // Prepare the payload for the target Lambda
    const payload = {
      headers: event.headers,
      body: event.body
    };

    console.log(`🔍 [DEBUG] Invoking target Lambda: ${targetLambda}`);
    
    // Asynchronously invoke the target Lambda function
    const invokeCommand = new InvokeCommand({
      FunctionName: targetLambda,
      InvocationType: 'Event', // Asynchronous execution
      Payload: JSON.stringify(payload),
    });

    await lambdaClient.send(invokeCommand);
    console.log(`✅ [DEBUG] Successfully routed ${githubEventType} event to ${targetLambda}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        message: 'Event routed successfully',
        eventType: githubEventType,
        targetLambda: targetLambda
      })
    };

  } catch (error) {
    console.error('❌ [DEBUG] ERROR in webhook router:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Internal server error',
        // message: error.message
      })
    };
  }
};