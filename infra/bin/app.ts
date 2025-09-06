import { App } from 'aws-cdk-lib';
import { CloudGuardianStack  } from '../lib/CloudGuardianStack ';
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const app = new App();
new CloudGuardianStack(app, 'CloudGuardianStack', {
  env: { 
  account: process.env.AWS_ACCOUNT, 
  region: process.env.AWS_REGION 
}
});