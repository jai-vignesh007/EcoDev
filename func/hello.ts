import type { APIGatewayProxyResult } from 'aws-lambda';

export const handler = async (): Promise<APIGatewayProxyResult> => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      msg: 'Hello from Lambda Function URL!'
    })
  };
};
