#!/usr/bin/env node
import fs from 'node:fs';

// If executed by live tool invocation, this script creates or touches the canary file passed as argv[2]
const canaryPath = process.argv[2];
if (canaryPath) {
  fs.writeFileSync(canaryPath, `LIVE_EXECUTION_DETECTED at ${Date.now()}\n`, 'utf8');
}
process.exit(0);
