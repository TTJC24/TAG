#!/usr/bin/env node
import { getBrainStatus } from '../brainStatus.ts';

getBrainStatus()
  .then((status) => {
    console.log(JSON.stringify(status, null, 2));
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
