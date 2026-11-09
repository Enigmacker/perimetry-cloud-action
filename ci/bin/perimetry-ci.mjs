#!/usr/bin/env node
import { main } from '../src/cli.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`perimetry-ci needs Node.js 20 or later (this is ${process.versions.node}).`);
  process.exit(2);
}
process.exitCode = await main();
